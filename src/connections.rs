use crate::{
    ai::{self, ModelConfig},
    api::ApiError,
    db, AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<Json<T>, ApiError>;
fn bad(msg: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, msg.into())
}
fn conflict() -> ApiError {
    ApiError(
        StatusCode::CONFLICT,
        "此连接已在别处修改，请重新打开后再操作".into(),
    )
}
#[derive(FromRow)]
struct Row {
    id: String,
    name: String,
    provider: String,
    config: String,
    revision: i64,
}
impl Row {
    fn cfg(&self) -> std::result::Result<ModelConfig, ApiError> {
        serde_json::from_str(&self.config).map_err(|_| bad("连接配置无法读取"))
    }
    fn public(&self) -> std::result::Result<Value, ApiError> {
        let c = self.cfg()?;
        Ok(
            json!({"id":self.id,"name":self.name,"provider":self.provider,"base_url":c.base_url,"model":c.model,"has_api_key":!c.api_key.is_empty(),"revision":self.revision,"protocol":c.protocol,"options":c.options}),
        )
    }
}
#[derive(Deserialize)]
pub struct Draft {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    revision: i64,
    #[serde(default)]
    name: String,
    #[serde(default)]
    provider: String,
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    clear_key: bool,
    #[serde(default)]
    activate: bool,
    #[serde(default)]
    protocol: Option<crate::ai_protocol::Protocol>,
    #[serde(default)]
    options: Option<crate::ai_protocol::Options>,
}
#[derive(Deserialize)]
pub struct Revision {
    revision: i64,
}

pub fn normalize_base(raw: &str) -> std::result::Result<String, String> {
    let mut url = reqwest::Url::parse(raw.trim()).map_err(|_| "请输入完整的 http(s) 接口地址")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("接口地址不能包含账号、查询参数或片段".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = path
        .strip_suffix("/chat/completions")
        .or_else(|| path.strip_suffix("/models"))
        .or_else(|| path.strip_suffix("/responses"))
        .or_else(|| path.strip_suffix("/messages"))
        .or_else(|| {
            path.rsplit_once("/models/")
                .filter(|(_, tail)| tail.ends_with(":generateContent"))
                .map(|(base, _)| base)
        })
        .unwrap_or(path)
        .to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}
fn resolve(
    d: &Draft,
    previous: Option<&ModelConfig>,
    needs_model: bool,
) -> std::result::Result<ModelConfig, ApiError> {
    let base = normalize_base(&d.base_url).map_err(bad)?;
    let key = if d.clear_key {
        String::new()
    } else if !d.api_key.trim().is_empty() {
        d.api_key.trim().to_string()
    } else if let Some(prev) = previous {
        if !prev.api_key.is_empty() && normalize_base(&prev.base_url).ok().as_deref() != Some(&base)
        {
            return Err(bad("接口地址已改变，请重新填写 API Key；无需密钥时请勾选清除密钥。旧密钥不会发送到新地址。"));
        }
        prev.api_key.clone()
    } else {
        String::new()
    };
    let c = ModelConfig {
        base_url: base,
        model: if needs_model {
            d.model.trim().to_string()
        } else {
            "listing".into()
        },
        api_key: key,
        protocol: d
            .protocol
            .unwrap_or_else(|| previous.map(|p| p.protocol).unwrap_or_default()),
        options: d
            .options
            .clone()
            .unwrap_or_else(|| previous.map(|p| p.options.clone()).unwrap_or_default()),
    };
    c.validate().map_err(bad)?;
    Ok(c)
}
async fn active(pool: &sqlx::SqlitePool) -> std::result::Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar("SELECT value FROM settings WHERE key='active_connection'")
        .fetch_optional(pool)
        .await
}
async fn previous(s: &AppState, d: &Draft) -> std::result::Result<Option<ModelConfig>, ApiError> {
    if let Some(id) = &d.id {
        let row = sqlx::query_as::<_, Row>("SELECT * FROM model_connections WHERE id=?")
            .bind(id)
            .fetch_one(&s.pool)
            .await?;
        if row.revision != d.revision {
            return Err(conflict());
        }
        Ok(Some(row.cfg()?))
    } else {
        Ok(None)
    }
}

pub async fn migrate(pool: &sqlx::SqlitePool) -> std::result::Result<(), sqlx::Error> {
    sqlx::query("CREATE TABLE IF NOT EXISTS model_connections(id TEXT PRIMARY KEY,name TEXT NOT NULL,provider TEXT NOT NULL,config TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1)").execute(pool).await?;
    let mut tx = pool.begin().await?;
    let done: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='connections_migrated'")
            .fetch_optional(&mut *tx)
            .await?;
    if done.is_none() {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT value FROM settings WHERE key='model'")
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(raw) = raw {
            if let Ok(c) = serde_json::from_str::<ModelConfig>(&raw) {
                if c.ready() {
                    sqlx::query("INSERT OR IGNORE INTO model_connections(id,name,provider,config) VALUES('legacy','原有模型连接','custom',?)").bind(&raw).execute(&mut *tx).await?;
                    sqlx::query("INSERT OR IGNORE INTO settings(key,value) VALUES('active_connection','legacy')").execute(&mut *tx).await?;
                }
            }
        }
        sqlx::query("INSERT INTO settings(key,value) VALUES('connections_migrated','1')")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await
}

pub async fn list(State(s): State<AppState>) -> Result<Value> {
    let rows = sqlx::query_as::<_, Row>("SELECT * FROM model_connections ORDER BY rowid")
        .fetch_all(&s.pool)
        .await?;
    let items = rows
        .iter()
        .map(Row::public)
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(Json(
        json!({"items":items,"active_id":active(&s.pool).await?}),
    ))
}
pub async fn save(State(s): State<AppState>, Json(d): Json<Draft>) -> Result<Value> {
    let name = d.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(bad("连接名称需为 1–80 个字符"));
    }
    if ![
        "deepseek",
        "openai",
        "ollama",
        "custom",
        "anthropic",
        "gemini",
        "qwen",
        "moonshot",
        "zhipu",
        "siliconflow",
        "openrouter",
    ]
    .contains(&d.provider.as_str())
    {
        return Err(bad("请选择服务商"));
    }
    let mut tx = s.pool.begin().await?;
    let row = if let Some(id) = &d.id {
        Some(
            sqlx::query_as::<_, Row>("SELECT * FROM model_connections WHERE id=?")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?,
        )
    } else {
        None
    };
    if row.as_ref().is_some_and(|r| r.revision != d.revision) {
        return Err(conflict());
    }
    let prev = row.as_ref().map(Row::cfg).transpose()?;
    let c = resolve(&d, prev.as_ref(), true)?;
    if let Some(id) = &d.id {
        if c.options.supports_images == Some(false)
            && crate::model_routes::assigned_in(&mut tx, id)
                .await?
                .iter()
                .any(|r| r == "vision")
        {
            return Err(bad(
                "此连接已分配给图片与手写，请先修改用途分配再设为仅文字",
            ));
        }
    }
    let raw = serde_json::to_string(&c).map_err(|_| bad("配置编码失败"))?;
    let id = d.id.clone().unwrap_or_else(db::id);
    let revision = row.as_ref().map_or(1, |r| r.revision + 1);
    if row.is_none() {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM model_connections")
            .fetch_one(&mut *tx)
            .await?;
        if count >= 50 {
            return Err(bad("最多保存 50 个连接，请先删除不再使用的连接"));
        }
    }
    sqlx::query("INSERT INTO model_connections(id,name,provider,config,revision) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,provider=excluded.provider,config=excluded.config,revision=excluded.revision").bind(&id).bind(name).bind(&d.provider).bind(&raw).bind(revision).execute(&mut *tx).await?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='active_connection'")
            .fetch_optional(&mut *tx)
            .await?;
    if d.activate || current.as_deref() == Some(&id) {
        sqlx::query("INSERT INTO settings(key,value) VALUES('model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&raw).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO settings(key,value) VALUES('active_connection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&id).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(Json(json!({"id":id,"revision":revision,"ok":true})))
}
pub async fn activate(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(v): Json<Revision>,
) -> Result<Value> {
    let mut tx = s.pool.begin().await?;
    let row = sqlx::query_as::<_, Row>("SELECT * FROM model_connections WHERE id=?")
        .bind(&id)
        .fetch_one(&mut *tx)
        .await?;
    if row.revision != v.revision {
        return Err(conflict());
    }
    row.cfg()?.validate().map_err(bad)?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&row.config).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('active_connection',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn delete(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(v): Json<Revision>,
) -> Result<Value> {
    let mut tx = s.pool.begin().await?;
    let current: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='active_connection'")
            .fetch_optional(&mut *tx)
            .await?;
    if current.as_deref() == Some(&id) {
        return Err(bad("此连接正在使用，请先切换到其他连接再删除"));
    }
    if !crate::model_routes::assigned_in(&mut tx, &id)
        .await?
        .is_empty()
    {
        return Err(bad("此连接仍被用途分配引用，请先修改用途分配再删除"));
    }
    let result = sqlx::query("DELETE FROM model_connections WHERE id=? AND revision=?")
        .bind(id)
        .bind(v.revision)
        .execute(&mut *tx)
        .await?;
    if result.rows_affected() != 1 {
        return Err(conflict());
    }
    tx.commit().await?;
    Ok(Json(json!({"ok":true})))
}
// The original settings API remains available to older clients and local tests.
pub async fn save_legacy(s: &AppState, c: &ModelConfig) -> std::result::Result<(), ApiError> {
    let raw = serde_json::to_string(c).map_err(|_| bad("配置编码失败"))?;
    let mut tx = s.pool.begin().await?;
    sqlx::query("INSERT INTO settings(key,value) VALUES('model',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(&raw).execute(&mut *tx).await?;
    let id: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key='active_connection'")
            .fetch_optional(&mut *tx)
            .await?;
    if c.ready() {
        if let Some(id) = id {
            sqlx::query("UPDATE model_connections SET config=?,revision=revision+1 WHERE id=?")
                .bind(&raw)
                .bind(id)
                .execute(&mut *tx)
                .await?;
        } else {
            let id = db::id();
            sqlx::query("INSERT INTO model_connections(id,name,provider,config) VALUES(?,'模型连接','custom',?)").bind(&id).bind(&raw).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO settings(key,value) VALUES('active_connection',?)")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
    } else {
        sqlx::query("DELETE FROM settings WHERE key='active_connection'")
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}
pub async fn test(State(s): State<AppState>, Json(d): Json<Draft>) -> Result<Value> {
    let p = previous(&s, &d).await?;
    let c = resolve(&d, p.as_ref(), true)?;
    let start = Instant::now();
    // No user material is sent, and neither discovery nor testing saves this draft.
    let msg = ai::complete(
        &s,
        &c,
        &[json!({"role":"user","content":"请只回复：连接成功"})],
        None,
    )
    .await
    .map_err(|e| ApiError(StatusCode::BAD_GATEWAY, e))?;
    let text = ai::content(&msg).map_err(bad)?;
    let text = if c.api_key.is_empty() {
        text
    } else {
        text.replace(&c.api_key, "[已隐藏]")
    };
    Ok(Json(
        json!({"ok":true,"response":ai::cut(&text,160),"latency_ms":start.elapsed().as_millis(),"scope":"text"}),
    ))
}
pub async fn models(State(s): State<AppState>, Json(d): Json<Draft>) -> Result<Value> {
    let p = previous(&s, &d).await?;
    let c = resolve(&d, p.as_ref(), false)?;
    // Never forward credentials through an endpoint redirect.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| bad("无法初始化连接"))?;
    let request =
        crate::ai_protocol::authenticate(client.get(format!("{}/models", c.base_url)), &c);
    let response = request.send().await.map_err(|e| {
        bad(if e.is_timeout() {
            "获取模型列表超时，可以重试或手动填写模型 ID"
        } else {
            "无法连接模型列表接口，请检查地址和网络，也可以手动填写模型 ID"
        })
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(bad(format!(
            "模型列表 HTTP {}：{}",
            status.as_u16(),
            match status.as_u16() {
                401 | 403 => "请检查 API Key 和访问权限",
                404 | 405 => "服务未提供 /models，请手动填写模型 ID",
                429 => "请求过于频繁，请稍后重试",
                _ => "获取失败，可以手动填写模型 ID",
            }
        )));
    }
    let mut data = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| bad("读取模型列表失败"))?;
        if data.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(bad("模型列表过大，请手动填写模型 ID"));
        }
        data.extend_from_slice(&chunk)
    }
    let v: Value = serde_json::from_slice(&data)
        .map_err(|_| bad("接口未返回 JSON 模型列表，请手动填写模型 ID"))?;
    let is_gemini = c.protocol == crate::ai_protocol::Protocol::Gemini;
    let items = v
        .get(if is_gemini { "models" } else { "data" })
        .and_then(Value::as_array)
        .or_else(|| v.as_array())
        .ok_or_else(|| bad("接口的模型列表格式不受支持，请手动填写模型 ID"))?;
    let mut models = items
        .iter()
        .filter(|m| {
            !is_gemini
                || m.get("supportedGenerationMethods")
                    .and_then(Value::as_array)
                    .is_none_or(|methods| methods.iter().any(|x| x == "generateContent"))
        })
        .filter_map(|m| {
            m.get(if is_gemini { "name" } else { "id" })
                .and_then(Value::as_str)
        })
        .map(|id| {
            if is_gemini {
                id.strip_prefix("models/").unwrap_or(id)
            } else {
                id
            }
        })
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 200
                && !id.chars().any(char::is_control)
                && (c.api_key.is_empty() || !id.contains(&c.api_key))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    models.sort();
    models.dedup();
    models.truncate(2000);
    let truncated =
        v["has_more"] == true || v["nextPageToken"].as_str().is_some_and(|t| !t.is_empty());
    Ok(Json(json!({"models":models,"truncated":truncated})))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn draft() -> Draft {
        serde_json::from_value(
            json!({"base_url":"https://api.example.com/v1/chat/completions/","model":"chat"}),
        )
        .unwrap()
    }
    #[test]
    fn normalizes_endpoint() {
        assert_eq!(
            normalize_base(" https://api.example.com/v1/chat/completions/ ").unwrap(),
            "https://api.example.com/v1"
        );
        assert!(normalize_base("https://u:p@host/v1").is_err());
        assert!(normalize_base("file:///tmp").is_err());
        assert!(normalize_base("https://host/v1?token=x").is_err());
    }
    #[test]
    fn never_reuses_key_for_changed_endpoint() {
        let prev = ModelConfig {
            base_url: "https://other.example/v1".into(),
            model: "chat".into(),
            api_key: "old-secret".into(),
            ..Default::default()
        };
        let mut d = draft();
        assert!(resolve(&d, Some(&prev), true).is_err());
        d.api_key = "replacement".into();
        assert_eq!(
            resolve(&d, Some(&prev), true).ok().unwrap().api_key,
            "replacement"
        );
        d.clear_key = true;
        assert!(resolve(&d, Some(&prev), true)
            .ok()
            .unwrap()
            .api_key
            .is_empty());
    }
}
