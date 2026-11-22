use crate::{api::ApiError, db, handwriting::Document, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

type Result<T> = std::result::Result<Json<T>, ApiError>;
fn bad(message: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn title(value: &str) -> std::result::Result<String, ApiError> {
    let value = value.trim();
    if value.chars().count() > 120 {
        return Err(bad("笔记标题最多 120 字"));
    }
    Ok(if value.is_empty() {
        "未命名笔记".into()
    } else {
        value.into()
    })
}
async fn course(s: &AppState, id: Option<String>) -> std::result::Result<Option<String>, ApiError> {
    let id = id.filter(|v| !v.is_empty());
    if let Some(id) = &id {
        let found: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM courses WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await?;
        if found == 0 {
            return Err(bad("关联课程不存在，请重新选择课程"));
        }
    }
    Ok(id)
}
#[derive(Serialize, sqlx::FromRow)]
struct Stored {
    id: String,
    title: String,
    course_id: Option<String>,
    text: String,
    document: String,
    revision: i64,
    archived: bool,
    created_at: i64,
    updated_at: i64,
}
impl Stored {
    fn public(self) -> std::result::Result<Value, ApiError> {
        let document: Value =
            serde_json::from_str(&self.document).map_err(|_| bad("笔记原稿数据损坏"))?;
        Ok(
            json!({"id":self.id,"title":self.title,"course_id":self.course_id,"text":self.text,"document":document,"revision":self.revision,"archived":self.archived,"created_at":self.created_at,"updated_at":self.updated_at}),
        )
    }
}
#[derive(Serialize, sqlx::FromRow)]
struct Summary {
    id: String,
    title: String,
    course_id: Option<String>,
    course_title: Option<String>,
    preview: String,
    page_count: i64,
    revision: i64,
    archived: bool,
    updated_at: i64,
}
#[derive(Default, Deserialize)]
pub struct Filter {
    #[serde(default)]
    q: String,
    course_id: Option<String>,
    #[serde(default)]
    unlinked: bool,
    #[serde(default)]
    archived: bool,
    #[serde(default)]
    offset: u32,
}
pub async fn list(State(s): State<AppState>, Query(f): Query<Filter>) -> Result<Value> {
    if f.q.chars().count() > 200 {
        return Err(bad("搜索内容最多 200 字"));
    }
    let q = f.q.trim();
    let cid = f.course_id.unwrap_or_default();
    if f.unlinked && !cid.is_empty() {
        return Err(bad("独立笔记与课程筛选不能同时使用"));
    }
    let total: i64=sqlx::query_scalar("SELECT COUNT(*) FROM notes n WHERE n.archived=? AND (?='' OR n.course_id=?) AND (?=0 OR n.course_id IS NULL) AND (?='' OR instr(lower(n.title),lower(?))>0 OR instr(lower(n.text),lower(?))>0)")
        .bind(f.archived).bind(&cid).bind(&cid).bind(f.unlinked).bind(q).bind(q).bind(q).fetch_one(&s.pool).await?;
    let items: Vec<Summary>=sqlx::query_as("SELECT n.id,n.title,n.course_id,c.title AS course_title,substr(n.text,1,100) AS preview,1+coalesce(json_array_length(n.document,'$.answer_extra'),0) AS page_count,n.revision,n.archived,n.updated_at FROM notes n LEFT JOIN courses c ON c.id=n.course_id WHERE n.archived=? AND (?='' OR n.course_id=?) AND (?=0 OR n.course_id IS NULL) AND (?='' OR instr(lower(n.title),lower(?))>0 OR instr(lower(n.text),lower(?))>0) ORDER BY n.updated_at DESC,n.id LIMIT 50 OFFSET ?")
        .bind(f.archived).bind(&cid).bind(&cid).bind(f.unlinked).bind(q).bind(q).bind(q).bind(i64::from(f.offset)).fetch_all(&s.pool).await?;
    Ok(Json(json!({"items":items,"total":total})))
}
#[derive(Deserialize)]
pub struct Create {
    #[serde(default)]
    title: String,
    course_id: Option<String>,
}
pub async fn create(State(s): State<AppState>, Json(req): Json<Create>) -> Result<Value> {
    let id = db::id();
    let now = db::now();
    let title = title(&req.title)?;
    let cid = course(&s, req.course_id).await?;
    sqlx::query(
        "INSERT INTO notes(id,title,course_id,document,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(title)
    .bind(cid)
    .bind(json!(Document::default()).to_string())
    .bind(now)
    .bind(now)
    .execute(&s.pool)
    .await?;
    get(State(s), Path(id)).await
}
pub async fn get(State(s): State<AppState>, Path(id): Path<String>) -> Result<Value> {
    let row: Stored = sqlx::query_as("SELECT * FROM notes WHERE id=?")
        .bind(id)
        .fetch_one(&s.pool)
        .await?;
    Ok(Json(row.public()?))
}
#[derive(Deserialize)]
pub struct Save {
    revision: i64,
    title: String,
    course_id: Option<String>,
    text: String,
    document: Document,
    #[serde(default)]
    archived: bool,
}
pub async fn save(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<Save>,
) -> Result<Value> {
    if req.revision < 0 {
        return Err(bad("笔记版本不正确"));
    }
    let title = title(&req.title)?;
    let cid = course(&s, req.course_id).await?;
    if req.text.chars().count() > 100000 {
        return Err(bad("每篇笔记的文字最多 100000 字"));
    }
    req.document.validate_note()?;
    if !req.document.scratch.strokes.is_empty() || !req.document.scratch_extra.is_empty() {
        return Err(bad("笔记只保存笔记纸，请勿附加隐藏草稿区"));
    }
    let document = serde_json::to_string(&req.document).map_err(|_| bad("笔记格式不正确"))?;
    if document.len() > 60_000_000 {
        return Err(bad("笔记原稿过大，请另建笔记继续"));
    }
    let now = db::now();
    let changed=sqlx::query("UPDATE notes SET title=?,course_id=?,text=?,document=?,archived=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?")
        .bind(title).bind(cid).bind(req.text).bind(document).bind(req.archived).bind(now).bind(&id).bind(req.revision).execute(&s.pool).await?;
    if changed.rows_affected() != 1 {
        let found: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM notes WHERE id=?")
            .bind(&id)
            .fetch_one(&s.pool)
            .await?;
        if found == 0 {
            return Err(ApiError(StatusCode::NOT_FOUND, "笔记不存在".into()));
        }
        return Err(ApiError(
            StatusCode::CONFLICT,
            "这篇笔记已在其他窗口修改。当前草稿已保留，请先导出备份再重新载入。".into(),
        ));
    }
    Ok(Json(json!({"revision":req.revision+1,"updated_at":now})))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn note_title_limits_and_default() {
        assert_eq!(title("  ").ok().as_deref(), Some("未命名笔记"));
        assert_eq!(title("  我的笔记  ").ok().as_deref(), Some("我的笔记"));
        assert!(title(&"字".repeat(121)).is_err());
    }
}
