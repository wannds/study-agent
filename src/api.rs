use crate::{ai, db, import, jobs, AppState};
use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub struct ApiError(pub StatusCode, pub String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error":self.1}))).into_response()
    }
}
impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        if matches!(e, sqlx::Error::RowNotFound) {
            return Self(StatusCode::NOT_FOUND, "记录不存在".into());
        }
        if let sqlx::Error::Database(ref err) = e {
            if err.is_unique_violation() {
                return Self(StatusCode::CONFLICT, "同类任务正在运行，请等待完成".into());
            }
        }
        tracing::error!(error=%e,"database request failed");
        Self(
            StatusCode::INTERNAL_SERVER_ERROR,
            "保存或读取数据失败，请查看服务日志".into(),
        )
    }
}
fn bad(s: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, s.into())
}
type Result<T> = std::result::Result<Json<T>, ApiError>;

pub async fn health() -> Json<Value> {
    Json(json!({"ok":true,"app":"study-agent","version":env!("CARGO_PKG_VERSION")}))
}
pub async fn list_courses(State(s): State<AppState>) -> Result<Vec<db::Course>> {
    Ok(Json(db::courses(&s.pool).await?))
}
pub async fn course(State(s): State<AppState>, Path(id): Path<String>) -> Result<Value> {
    let courses = db::courses(&s.pool).await?;
    let c = courses
        .into_iter()
        .find(|c| c.id == id)
        .ok_or(ApiError(StatusCode::NOT_FOUND, "课程不存在".into()))?;
    let lessons: Vec<db::Lesson> =
        sqlx::query_as("SELECT * FROM lessons WHERE course_id=? ORDER BY ordinal")
            .bind(&id)
            .fetch_all(&s.pool)
            .await?;
    Ok(Json(json!({"course":c,"lessons":lessons})))
}
pub async fn import_course(
    State(s): State<AppState>,
    Json(mut req): Json<import::ImportRequest>,
) -> Result<Value> {
    req.title = req.title.trim().to_string();
    if req.title.is_empty() || req.title.chars().count() > 100 {
        return Err(bad("课程名称需要 1—100 个字符"));
    }
    let lessons = import::parse(&req).map_err(bad)?;
    let id = db::id();
    let count = lessons.len();
    let mut tx = s.pool.begin().await?;
    sqlx::query("INSERT INTO courses VALUES (?,?,?,?,?)")
        .bind(&id)
        .bind(&req.title)
        .bind(format!("{} 个章节 · 从本地资料导入", count))
        .bind(&req.format)
        .bind(db::now())
        .execute(&mut *tx)
        .await?;
    for (i, l) in lessons.into_iter().enumerate() {
        sqlx::query("INSERT INTO lessons VALUES (?,?,?,?,?,?,'unread')")
            .bind(db::id())
            .bind(&id)
            .bind(l.title)
            .bind(i as i64)
            .bind(l.content)
            .bind(l.source)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"id":id,"lesson_count":count})))
}
#[derive(Deserialize)]
pub struct Progress {
    status: String,
}
pub async fn progress(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<Progress>,
) -> Result<Value> {
    if !["unread", "reading", "read"].contains(&req.status.as_str()) {
        return Err(bad("无效阅读状态"));
    }
    db::lesson(&s.pool, &id).await?;
    sqlx::query("UPDATE lessons SET reading_status=? WHERE id=?")
        .bind(&req.status)
        .bind(&id)
        .execute(&s.pool)
        .await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn messages(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> Result<Vec<db::Message>> {
    db::lesson(&s.pool, &id).await?;
    Ok(Json(sqlx::query_as("SELECT * FROM (SELECT * FROM messages WHERE lesson_id=? ORDER BY created_at DESC LIMIT 100) ORDER BY created_at").bind(id).fetch_all(&s.pool).await?))
}
pub async fn exercises(State(s): State<AppState>, Path(id): Path<String>) -> Result<Value> {
    let rows: Vec<db::Exercise> =
        sqlx::query_as("SELECT * FROM exercises WHERE lesson_id=? ORDER BY created_at DESC")
            .bind(id)
            .fetch_all(&s.pool)
            .await?;
    Ok(Json(json!(rows
        .iter()
        .map(db::Exercise::public)
        .collect::<Vec<_>>())))
}
pub async fn exercise_history(State(s): State<AppState>) -> Result<Value> {
    let rows:Vec<(String,String,String,String,String,String,String,Option<i64>,i64)>=sqlx::query_as("SELECT e.id,l.course_id,e.lesson_id,l.title,c.title,e.question,e.status,e.score,e.created_at FROM exercises e JOIN lessons l ON l.id=e.lesson_id JOIN courses c ON c.id=l.course_id ORDER BY e.created_at DESC LIMIT 100").fetch_all(&s.pool).await?;
    Ok(Json(json!(rows.into_iter().map(|(id,course_id,lesson_id,lesson_title,course_title,question,status,score,created_at)|json!({"id":id,"course_id":course_id,"lesson_id":lesson_id,"lesson_title":lesson_title,"course_title":course_title,"question":question,"status":status,"score":score,"created_at":created_at})).collect::<Vec<_>>())))
}

async fn ready(s: &AppState) -> std::result::Result<(), ApiError> {
    let cfg = ai::config(s).await.map_err(bad)?;
    if !cfg.ready() {
        return Err(ApiError(
            StatusCode::SERVICE_UNAVAILABLE,
            "请先在模型设置中填写接口地址和模型名称".into(),
        ));
    }
    let queued: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')")
            .fetch_one(&s.pool)
            .await?;
    if queued >= 20 {
        return Err(ApiError(
            StatusCode::TOO_MANY_REQUESTS,
            "等待中的任务较多，请稍后再试".into(),
        ));
    }
    Ok(())
}
async fn insert_job(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
    lesson_id: &str,
    kind: &str,
    payload: Value,
    ts: i64,
) -> std::result::Result<(), ApiError> {
    sqlx::query("INSERT INTO jobs(id,lesson_id,kind,status,stage,payload,created_at,updated_at) VALUES(?,?,?,'queued','等待执行',?,?,?)")
        .bind(id).bind(lesson_id).bind(kind).bind(payload.to_string()).bind(ts).bind(ts).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Deserialize)]
pub struct ChatRequest {
    question: String,
}
pub async fn chat(
    State(s): State<AppState>,
    Path(lesson_id): Path<String>,
    Json(req): Json<ChatRequest>,
) -> Result<Value> {
    let q = req.question.trim();
    if q.is_empty() || q.chars().count() > 4000 {
        return Err(bad("请输入 1—4000 字的问题"));
    }
    db::lesson(&s.pool, &lesson_id).await?;
    ready(&s).await?;
    let id = db::id();
    let ts = db::now();
    let mut tx = s.pool.begin().await?;
    insert_job(&mut tx, &id, &lesson_id, "chat", json!({"question":q}), ts).await?;
    sqlx::query(
        "INSERT INTO messages(id,lesson_id,role,content,created_at) VALUES(?,?,'user',?,?)",
    )
    .bind(db::id())
    .bind(&lesson_id)
    .bind(q)
    .bind(ts)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    jobs::launch(s, id.clone());
    Ok(Json(json!({"id":id})))
}
pub async fn quiz(State(s): State<AppState>, Path(lesson_id): Path<String>) -> Result<Value> {
    db::lesson(&s.pool, &lesson_id).await?;
    ready(&s).await?;
    let id = db::id();
    let ts = db::now();
    let mut tx = s.pool.begin().await?;
    insert_job(&mut tx, &id, &lesson_id, "quiz", json!({}), ts).await?;
    tx.commit().await?;
    jobs::launch(s, id.clone());
    Ok(Json(json!({"id":id})))
}
#[derive(Deserialize)]
pub struct Answer {
    answer: String,
    #[serde(default)]
    handwriting_revision: Option<i64>,
    #[serde(default)]
    include_image: bool,
    #[serde(default)]
    handwriting_confirmed: bool,
}
pub async fn grade(
    State(s): State<AppState>,
    Path(exercise_id): Path<String>,
    Json(req): Json<Answer>,
) -> Result<Value> {
    let answer = req.answer.trim();
    if answer.is_empty() || answer.chars().count() > 10000 {
        return Err(bad("请输入 1—10000 字的答案"));
    }
    let e = db::exercise(&s.pool, &exercise_id).await?;
    if e.status == "graded" {
        return Err(bad("本题已批改，请生成新练习以保留本次作答记录"));
    }
    ready(&s).await?;
    let id = db::id();
    let ts = db::now();
    let mut tx = s.pool.begin().await?;
    insert_job(
        &mut tx,
        &id,
        &e.lesson_id,
        "grade",
        json!({"exercise_id":exercise_id,"answer":answer}),
        ts,
    )
    .await?;
    if req.include_image && req.handwriting_revision.is_none() {
        return Err(bad("图片批改需要指定已保存的手写原稿"));
    }
    let mut payload = json!({"exercise_id":exercise_id,"answer":answer});
    if let Some(revision) = req.handwriting_revision {
        if !req.handwriting_confirmed {
            return Err(bad("请先核对手写识别文字，再确认提交"));
        }
        let images = crate::handwriting::grade_images(&mut tx, &exercise_id, revision).await?;
        payload["handwriting_revision"] = json!(revision);
        if req.include_image {
            payload["answer_images"] = json!(images);
        }
    }
    // Discard stale failed jobs once a newer answer is submitted.
    sqlx::query("UPDATE jobs SET status='done',stage='已由新提交替代' WHERE lesson_id=? AND kind='grade' AND status IN ('failed','interrupted') AND json_extract(payload,'$.exercise_id')=?")
        .bind(&e.lesson_id).bind(&exercise_id).execute(&mut *tx).await?;
    sqlx::query("UPDATE jobs SET payload=? WHERE id=?")
        .bind(payload.to_string())
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE exercises SET student_answer=?,status='answered',score=NULL,feedback='' WHERE id=?",
    )
    .bind(answer)
    .bind(&exercise_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    jobs::launch(s, id.clone());
    Ok(Json(json!({"id":id})))
}
pub async fn save_draft(
    State(s): State<AppState>,
    Path(exercise_id): Path<String>,
    Json(req): Json<Answer>,
) -> Result<Value> {
    if req.answer.chars().count() > 10000 {
        return Err(bad("答案最多 10000 字"));
    }
    let e = db::exercise(&s.pool, &exercise_id).await?;
    let active:i64=sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE lesson_id=? AND kind='grade' AND status IN ('running','queued')").bind(&e.lesson_id).fetch_one(&s.pool).await?;
    if active > 0 {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "正在批改，请稍后修改答案".into(),
        ));
    }
    if e.status == "graded" {
        return Err(bad("这道题已批改，请生成新练习"));
    }
    sqlx::query("UPDATE exercises SET student_answer=? WHERE id=?")
        .bind(req.answer)
        .bind(exercise_id)
        .execute(&s.pool)
        .await?;
    Ok(Json(json!({"ok":true})))
}
#[derive(Deserialize)]
pub struct JobFilter {
    lesson_id: Option<String>,
}
pub async fn list_jobs(
    State(s): State<AppState>,
    Query(q): Query<JobFilter>,
) -> Result<Vec<db::Job>> {
    Ok(Json(if let Some(id) = q.lesson_id {
        sqlx::query_as("SELECT * FROM jobs WHERE lesson_id=? ORDER BY created_at DESC LIMIT 60")
            .bind(id)
            .fetch_all(&s.pool)
            .await?
    } else {
        sqlx::query_as("SELECT * FROM jobs ORDER BY created_at DESC LIMIT 60")
            .fetch_all(&s.pool)
            .await?
    }))
}
pub async fn retry(State(s): State<AppState>, Path(id): Path<String>) -> Result<Value> {
    ready(&s).await?;
    let job: db::Job = sqlx::query_as("SELECT * FROM jobs WHERE id=?")
        .bind(&id)
        .fetch_one(&s.pool)
        .await?;
    if !["failed", "interrupted"].contains(&job.status.as_str()) {
        return Err(bad("只能重试失败或中断的任务"));
    }
    if job.kind == "grade" {
        let payload: Value = serde_json::from_str(&job.payload).map_err(|_| bad("任务数据损坏"))?;
        let e = db::exercise(&s.pool, payload["exercise_id"].as_str().unwrap_or("")).await?;
        if e.status == "graded" {
            return Err(bad("该练习已经完成批改，无需重试旧任务"));
        }
    }
    let changed=sqlx::query("UPDATE jobs SET status='queued',stage='等待重试',error='',updated_at=? WHERE id=? AND status IN ('failed','interrupted')").bind(db::now()).bind(&id).execute(&s.pool).await?;
    if changed.rows_affected() == 0 {
        return Err(bad("任务状态已改变"));
    }
    jobs::launch(s, id.clone());
    Ok(Json(json!({"id":id})))
}
pub async fn events(State(s): State<AppState>, Path(id): Path<String>) -> Result<Value> {
    let rows: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT tool,detail,created_at FROM job_events WHERE job_id=? ORDER BY id")
            .bind(id)
            .fetch_all(&s.pool)
            .await?;
    Ok(Json(json!(rows
        .into_iter()
        .map(|(tool, detail, ts)| json!({"tool":tool,"detail":detail,"created_at":ts}))
        .collect::<Vec<_>>())))
}

pub async fn settings(State(s): State<AppState>) -> Result<Value> {
    let c = crate::model_routes::config_for(&s, "chat")
        .await
        .map_err(bad)?;
    let analysis = crate::model_routes::config_for(&s, "analysis")
        .await
        .map_err(bad)?;
    let practice = crate::model_routes::config_for(&s, "practice")
        .await
        .map_err(bad)?;
    let vision = crate::model_routes::config_for(&s, "vision")
        .await
        .map_err(bad)?;
    Ok(Json(
        json!({"base_url":c.base_url,"model":c.model,"has_api_key":!c.api_key.is_empty(),"ready":c.ready(),"analysis_ready":analysis.ready(),"practice_ready":practice.ready(),"vision_ready":vision.ready() && vision.options.supports_images!=Some(false),"analysis_model":analysis.model,"practice_model":practice.model,"vision_model":vision.model}),
    ))
}
#[derive(Deserialize)]
pub struct SettingsRequest {
    base_url: String,
    model: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    clear_key: bool,
}
pub async fn save_settings(
    State(s): State<AppState>,
    Json(req): Json<SettingsRequest>,
) -> Result<Value> {
    let prev = ai::config(&s).await.map_err(bad)?;
    let c = ai::ModelConfig {
        base_url: req.base_url.trim().trim_end_matches('/').to_string(),
        model: req.model.trim().to_string(),
        protocol: prev.protocol,
        options: prev.options.clone(),
        api_key: if req.clear_key {
            String::new()
        } else if req.api_key.trim().is_empty() {
            if !prev.api_key.is_empty()
                && crate::connections::normalize_base(&prev.base_url).ok()
                    != crate::connections::normalize_base(&req.base_url).ok()
            {
                return Err(bad("接口地址已改变，请重新填写 API Key 或清除旧密钥"));
            }
            prev.api_key
        } else {
            req.api_key.trim().to_string()
        },
    };
    c.validate().map_err(bad)?;
    crate::connections::save_legacy(&s, &c).await?;
    Ok(Json(json!({"ok":true,"ready":c.ready()})))
}
pub async fn test_model(State(s): State<AppState>) -> Result<Value> {
    let c = ai::config(&s).await.map_err(bad)?;
    let msg = ai::complete(
        &s,
        &c,
        &[json!({"role":"user","content":"请只回复：连接成功"})],
        None,
    )
    .await
    .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))?;
    let text = ai::content(&msg).map_err(bad)?;
    Ok(Json(json!({"ok":true,"response":ai::cut(&text,160)})))
}
pub async fn stats(State(s): State<AppState>) -> Result<Value> {
    let (courses,lessons,read,graded,running):(i64,i64,i64,i64,i64)=sqlx::query_as("SELECT (SELECT COUNT(*) FROM courses),(SELECT COUNT(*) FROM lessons),(SELECT COUNT(*) FROM lessons WHERE reading_status='read'),(SELECT COUNT(*) FROM exercises WHERE status='graded'),(SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running'))").fetch_one(&s.pool).await?;
    Ok(Json(
        json!({"courses":courses,"lessons":lessons,"read":read,"graded":graded,"running":running}),
    ))
}
