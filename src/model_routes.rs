use crate::{
    ai::{self, ModelConfig},
    api::ApiError,
    AppState,
};
use axum::{extract::State, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
pub const ROLES: [&str; 4] = ["chat", "analysis", "practice", "vision"];
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Routes {
    #[serde(default)]
    pub revision: i64,
    #[serde(default)]
    pub assignments: BTreeMap<String, Option<String>>,
}
pub fn decode(raw: Option<String>) -> std::result::Result<Routes, String> {
    match raw {
        Some(s) => serde_json::from_str(&s).map_err(|_| "用途分配配置损坏，请重新设置".into()),
        None => Ok(Routes::default()),
    }
}
pub async fn read(pool: &sqlx::SqlitePool) -> std::result::Result<Routes, String> {
    let raw = sqlx::query_scalar("SELECT value FROM settings WHERE key='model_routes'")
        .fetch_optional(pool)
        .await
        .map_err(|_| "读取用途分配失败")?;
    decode(raw)
}
pub async fn config_for(s: &AppState, role: &str) -> std::result::Result<ModelConfig, String> {
    if !ROLES.contains(&role) {
        return Err("未知模型用途".into());
    }
    let routes = read(&s.pool).await?;
    if let Some(Some(id)) = routes.assignments.get(role) {
        let raw: Option<String> =
            sqlx::query_scalar("SELECT config FROM model_connections WHERE id=?")
                .bind(id)
                .fetch_optional(&s.pool)
                .await
                .map_err(|_| "读取用途模型失败")?;
        let raw = raw.ok_or("该用途指定的连接已不存在，请重新分配；不会自动切换到其他服务")?;
        serde_json::from_str(&raw).map_err(|_| "用途连接配置无法读取".into())
    } else {
        ai::config(s).await
    }
}
pub async fn get(State(s): State<AppState>) -> std::result::Result<Json<Routes>, ApiError> {
    Ok(Json(
        read(&s.pool)
            .await
            .map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?,
    ))
}
pub async fn save(
    State(s): State<AppState>,
    Json(d): Json<Routes>,
) -> std::result::Result<Json<Value>, ApiError> {
    if d.assignments.keys().any(|k| !ROLES.contains(&k.as_str())) {
        return Err(ApiError(StatusCode::BAD_REQUEST, "包含未知用途".into()));
    }
    let mut tx = s.pool.begin().await?;
    let raw = sqlx::query_scalar("SELECT value FROM settings WHERE key='model_routes'")
        .fetch_optional(&mut *tx)
        .await?;
    let previous = decode(raw).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    if previous.revision != d.revision {
        return Err(ApiError(
            StatusCode::CONFLICT,
            "用途分配已在别处更新，请重新读取后再保存".into(),
        ));
    }
    for (role, id) in &d.assignments {
        if let Some(id) = id {
            let raw: Option<String> =
                sqlx::query_scalar("SELECT config FROM model_connections WHERE id=?")
                    .bind(id)
                    .fetch_optional(&mut *tx)
                    .await?;
            let c: ModelConfig = serde_json::from_str(&raw.ok_or_else(|| {
                ApiError(
                    StatusCode::BAD_REQUEST,
                    "指定连接不存在，请重新读取列表".into(),
                )
            })?)
            .map_err(|_| ApiError(StatusCode::BAD_REQUEST, "连接配置无法读取".into()))?;
            if !c.ready() {
                return Err(ApiError(StatusCode::BAD_REQUEST, "请先完善连接配置".into()));
            }
            if role == "vision" && c.options.supports_images == Some(false) {
                return Err(ApiError(
                    StatusCode::BAD_REQUEST,
                    "仅文字连接不能用于图片与手写".into(),
                ));
            }
        }
    }
    let saved = Routes {
        revision: previous.revision + 1,
        assignments: d.assignments,
    };
    sqlx::query("INSERT INTO settings(key,value) VALUES('model_routes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(serde_json::to_string(&saved).unwrap()).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({"ok":true,"revision":saved.revision})))
}
pub async fn assigned_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    id: &str,
) -> std::result::Result<Vec<String>, ApiError> {
    let raw = sqlx::query_scalar("SELECT value FROM settings WHERE key='model_routes'")
        .fetch_optional(&mut **tx)
        .await?;
    let routes = decode(raw).map_err(|e| ApiError(StatusCode::BAD_REQUEST, e))?;
    Ok(routes
        .assignments
        .iter()
        .filter(|(_, v)| v.as_deref() == Some(id))
        .map(|(k, _)| k.clone())
        .collect())
}
