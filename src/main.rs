mod accounts;
mod ai;
mod ai_protocol;
mod api;
mod connections;
mod db;
mod handwriting;
mod import;
mod jobs;
mod model_routes;
mod notes;
mod plans;
mod video;

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::{header, StatusCode, Uri},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Router,
};
use rust_embed::RustEmbed;
use std::{path::PathBuf, sync::Arc, time::Duration};

#[derive(Clone)]
pub struct AppState {
    pub pool: sqlx::SqlitePool,
    pub http: reqwest::Client,
    pub slots: Arc<tokio::sync::Semaphore>,
    pub video_slots: Arc<tokio::sync::Semaphore>,
    pub data_dir: PathBuf,
    pub accounts: Arc<accounts::Accounts>,
}
#[derive(RustEmbed)]
#[folder = "web/dist/"]
struct Web;

async fn static_file(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path.starts_with("api/") {
        return (
            StatusCode::NOT_FOUND,
            axum::Json(serde_json::json!({"error":"接口不存在"})),
        )
            .into_response();
    }
    let target = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = Web::get(target) {
        let mime = mime_guess::from_path(target).first_or_octet_stream();
        return (
            [
                (header::CONTENT_TYPE, mime.as_ref()),
                (
                    header::CACHE_CONTROL,
                    if target == "index.html" {
                        "no-cache"
                    } else {
                        "public, max-age=86400"
                    },
                ),
            ],
            file.data.into_owned(),
        )
            .into_response();
    }
    (StatusCode::NOT_FOUND, "页面不存在").into_response()
}

async fn local_only(req: Request, next: Next) -> Response {
    let account_request = req.uri().path().starts_with("/api/accounts");
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|s| s.to_str().ok())
        .unwrap_or("");
    let parsed = format!("http://{host}").parse::<reqwest::Url>().ok();
    let allowed = parsed
        .as_ref()
        .and_then(|u| u.host_str())
        .is_some_and(|h| h == "127.0.0.1" || h == "localhost");
    if !allowed {
        return (StatusCode::FORBIDDEN, "仅允许本机访问").into_response();
    }
    if !matches!(
        *req.method(),
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    ) {
        if let Some(origin) = req.headers().get(header::ORIGIN) {
            let expected = format!("http://{host}");
            if origin.to_str().ok() != Some(expected.as_str()) {
                return (StatusCode::FORBIDDEN, "请求来源不匹配").into_response();
            }
        }
    }
    let mut response = next.run(req).await;
    if account_request {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    }
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    response
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "study_agent=info".into()),
        )
        .init();
    let folder = PathBuf::from(std::env::var("STUDY_DATA_DIR").unwrap_or_else(|_| "data".into()));
    std::fs::create_dir_all(&folder)?;
    let pool = db::connect(&folder).await?;
    if std::env::var("STUDY_SEED").ok().as_deref() != Some("0") {
        db::seed(&pool).await?;
    }
    let state = AppState {
        accounts: Arc::new(accounts::Accounts::new()),
        pool,
        http: reqwest::Client::builder()
            .timeout(Duration::from_secs(90))
            .connect_timeout(Duration::from_secs(15))
            .build()?,
        slots: Arc::new(tokio::sync::Semaphore::new(1)),
        video_slots: Arc::new(tokio::sync::Semaphore::new(1)),
        data_dir: folder.canonicalize()?,
    };
    let app = Router::new()
        .route("/api/plans", get(plans::list))
        .route("/api/courses/{id}/plan", post(plans::create))
        .route("/api/plans/{id}", get(plans::detail))
        .route("/api/plans/{id}/retry", post(plans::retry))
        .route("/api/plans/{id}/confirm", post(plans::confirm))
        .route("/api/plan-tasks/{id}", put(plans::mark_task))
        .route("/api/accounts", get(accounts::status))
        .route("/api/accounts/youtube/browsers", get(accounts::browsers))
        .route(
            "/api/accounts/youtube/connect",
            post(accounts::youtube_connect),
        )
        .route("/api/accounts/youtube/check", post(accounts::youtube_check))
        .route("/api/accounts/bilibili/qr", post(accounts::qr_start))
        .route(
            "/api/accounts/bilibili/qr/{id}/poll",
            post(accounts::qr_poll),
        )
        .route(
            "/api/accounts/bilibili/qr/{id}/cancel",
            post(accounts::qr_cancel),
        )
        .route("/api/accounts/bilibili/check", post(accounts::bili_check))
        .route(
            "/api/accounts/{platform}/disconnect",
            post(accounts::disconnect),
        )
        .route("/api/health", get(api::health))
        .route("/api/video/status", get(video::engine_status))
        .route("/api/video/tasks", get(video::list).post(video::create))
        .route(
            "/api/video/upload",
            post(video::upload).layer(DefaultBodyLimit::max(
                2 * 1024 * 1024 * 1024usize + 10 * 1024 * 1024,
            )),
        )
        .route("/api/video/tasks/{id}/cancel", post(video::cancel))
        .route("/api/video/tasks/{id}/retry", post(video::retry))
        .route("/api/video/assets/{id}/{*file}", get(video::asset))
        .route("/api/stats", get(api::stats))
        .route(
            "/api/courses",
            get(api::list_courses).post(api::import_course),
        )
        .route("/api/courses/{id}", get(api::course))
        .route("/api/lessons/{id}/progress", put(api::progress))
        .route("/api/lessons/{id}/messages", get(api::messages))
        .route("/api/lessons/{id}/chat", post(api::chat))
        .route(
            "/api/lessons/{id}/exercises",
            get(api::exercises).post(api::quiz),
        )
        .route("/api/notes", get(notes::list).post(notes::create))
        .route(
            "/api/notes/{id}",
            get(notes::get)
                .put(notes::save)
                .layer(DefaultBodyLimit::max(64 * 1024 * 1024)),
        )
        .route("/api/exercises", get(api::exercise_history))
        .route("/api/exercises/{id}/grade", post(api::grade))
        .route("/api/exercises/{id}/draft", put(api::save_draft))
        .route(
            "/api/exercises/{id}/ink",
            get(handwriting::get)
                .put(handwriting::save)
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024)),
        )
        .route(
            "/api/exercises/{id}/ink/recognize",
            post(handwriting::recognize),
        )
        .route("/api/jobs", get(api::list_jobs))
        .route("/api/jobs/{id}/retry", post(api::retry))
        .route("/api/jobs/{id}/events", get(api::events))
        .route("/api/settings", get(api::settings).put(api::save_settings))
        .route("/api/settings/test", post(api::test_model))
        .route(
            "/api/model-routes",
            get(model_routes::get).put(model_routes::save),
        )
        .route(
            "/api/connections",
            get(connections::list).post(connections::save),
        )
        .route("/api/connections/test", post(connections::test))
        .route("/api/connections/models", post(connections::models))
        .route(
            "/api/connections/{id}/activate",
            post(connections::activate),
        )
        .route("/api/connections/{id}/delete", post(connections::delete))
        .fallback(static_file)
        .layer(DefaultBodyLimit::max(5 * 1024 * 1024))
        .layer(middleware::from_fn(local_only))
        .with_state(state);
    let port: u16 = std::env::var("STUDY_PORT")
        .unwrap_or_else(|_| "8731".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!(
        "Study Agent {}: http://127.0.0.1:{port}",
        env!("CARGO_PKG_VERSION")
    );
    println!("Data directory: {}", folder.canonicalize()?.display());
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
