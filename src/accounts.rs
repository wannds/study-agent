//! Source accounts share course2md's native storage. No credentials reach HTTP responses.
use crate::{api::ApiError, video, AppState};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use c2m_source::auth::{
    self,
    youtube::{self, Browser, BrowserChoice, Reader, Session},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, ApiError>;
fn bad(text: &str) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, text.into())
}
fn failed(text: &str) -> ApiError {
    ApiError(StatusCode::BAD_GATEWAY, text.into())
}

pub struct Accounts {
    inner: Mutex<Inner>,
    gate: Arc<tokio::sync::Semaphore>,
}
#[derive(Default)]
struct Inner {
    qr: Option<Login>,
    last_generated: Option<Instant>,
}
struct Login {
    id: String,
    session: Option<auth::QrSession>,
    last_poll: Option<Instant>,
    view: Value,
}
impl Accounts {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            gate: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
    async fn run<T, F>(self: Arc<Self>, operation: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Inner) -> Result<T> + Send + 'static,
    {
        let permit =
            self.gate.clone().try_acquire_owned().map_err(|_| {
                ApiError(StatusCode::CONFLICT, "账号操作正在进行，请稍后重试".into())
            })?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let mut state = self
                .inner
                .lock()
                .map_err(|_| failed("账号服务繁忙，请重新启动软件"))?;
            operation(&mut state)
        })
        .await
        .map_err(|_| failed("账号操作未完成，请重试"))?
    }
}

pub async fn status(State(s): State<AppState>) -> Result<Json<Value>> {
    s.accounts.run(|_| {
        let bili = if auth::cookie_path().is_file() { "saved" } else { "disconnected" };
        let yt = match youtube::saved_choice() {
            Ok(Some(choice)) => json!({"state":"configured","browser":choice.browser.id(),"profile":choice.profile}),
            Ok(None) => json!({"state":"disconnected"}),
            Err(_) => json!({"state":"error","message":"YouTube 连接设置无法读取，请重新连接"}),
        };
        Ok(Json(json!({"bilibili":{"state":bili},"youtube":yt,"engine_ready":video::engine_root().join("bin/course2md.exe").is_file(),"shared":true})))
    }).await
}

pub async fn browsers(State(s): State<AppState>) -> Result<Json<Value>> {
    s.accounts
        .run(|_| {
            let rows: Vec<_> = Browser::installed()
                .into_iter()
                .map(|b| {
                    let profiles: Vec<_> = b
                        .profiles()
                        .into_iter()
                        .map(|p| json!({"id":p.dir,"name":p.name}))
                        .collect();
                    json!({"id":b.id(),"name":b.name(),"profiles":profiles})
                })
                .collect();
            Ok(Json(json!({"browsers":rows})))
        })
        .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

pub async fn qr_start(State(s): State<AppState>, Json(_): Json<Empty>) -> Result<Json<Value>> {
    s.accounts.run(|state| {
        if state.last_generated.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return Err(bad("生成过于频繁，请稍等几秒"));
        }
        if state.qr.as_ref().and_then(|q| q.session.as_ref()).is_some_and(|q| !q.remaining().is_zero()) {
            return Err(bad("已有等待确认的二维码，请先取消或等待过期"));
        }
        state.last_generated = Some(Instant::now());
        let qr = auth::QrSession::generate().map_err(|_| failed("获取 B站二维码失败，请检查网络后重试"))?;
        let id = uuid::Uuid::new_v4().to_string();
        let reply = json!({"id":id,"state":"waiting","remaining":qr.remaining().as_secs(),"modules":qr.modules()});
        state.qr = Some(Login { id, session: Some(qr), last_poll: None, view: json!({"state":"waiting"}) });
        Ok(Json(reply))
    }).await
}

pub async fn qr_poll(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(_): Json<Empty>,
) -> Result<Json<Value>> {
    s.accounts
        .run(move |state| {
            let login = state.qr.as_mut().filter(|q| q.id == id).ok_or_else(|| {
                ApiError(
                    StatusCode::GONE,
                    "二维码已取消或服务已重启，请重新生成".into(),
                )
            })?;
            if login
                .last_poll
                .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
                || login.session.is_none()
            {
                return Ok(Json(login.view.clone()));
            }
            login.last_poll = Some(Instant::now());
            let qr = login.session.as_mut().unwrap();
            let reply = match qr
                .poll()
                .map_err(|_| failed("查询扫码状态失败，请检查网络；也可以取消后重试"))?
            {
                auth::QrPoll::Waiting => {
                    json!({"state":"waiting","remaining":qr.remaining().as_secs()})
                }
                auth::QrPoll::AwaitingConfirmation => {
                    json!({"state":"confirm","remaining":qr.remaining().as_secs()})
                }
                auth::QrPoll::Expired => {
                    login.session = None;
                    json!({"state":"expired","remaining":0})
                }
                auth::QrPoll::Authenticated(verified) => {
                    login.session = None;
                    login.view = json!({"state":"failed"});
                    let profile = verified
                        .save()
                        .map_err(|_| failed("平台已确认，但本机保存失败，请重新扫码"))?;
                    json!({"state":"connected","name":profile.name,"remaining":0})
                }
            };
            login.view = reply.clone();
            Ok(Json(reply))
        })
        .await
}

pub async fn qr_cancel(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(_): Json<Empty>,
) -> Result<Json<Value>> {
    s.accounts
        .run(move |state| {
            if state.qr.as_ref().is_some_and(|q| q.id == id) {
                state.qr = None;
            }
            Ok(Json(json!({"ok":true})))
        })
        .await
}

pub async fn bili_check(State(s): State<AppState>, Json(_): Json<Empty>) -> Result<Json<Value>> {
    s.accounts
        .run(|_| {
            let result = auth::bilibili_account_status()
                .map_err(|_| failed("暂时无法验证 B站账号。请检查网络；已有登录状态未被删除"))?;
            Ok(Json(match result {
                auth::AccountStatus::Disconnected => json!({"state":"disconnected"}),
                auth::AccountStatus::Expired => json!({"state":"expired"}),
                auth::AccountStatus::Connected(p) => json!({"state":"connected","name":p.name}),
            }))
        })
        .await
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connect {
    browser: String,
    #[serde(default)]
    profile: Option<String>,
}
fn choice(input: Connect) -> Result<BrowserChoice> {
    let browser = Browser::from_id(&input.browser).ok_or_else(|| bad("不支持的浏览器"))?;
    if !Browser::installed().contains(&browser) {
        return Err(bad("未找到所选浏览器，请先安装并登录 YouTube"));
    }
    let profile = input.profile.filter(|p| !p.is_empty());
    if let Some(ref p) = profile {
        if !browser
            .profiles()
            .iter()
            .any(|candidate| &candidate.dir == p)
        {
            return Err(bad("浏览器配置无效，请刷新列表重新选择"));
        }
    }
    Ok(BrowserChoice { browser, profile })
}
fn ytdlp() -> Result<PathBuf> {
    let root = video::engine_root();
    [
        root.join("bin/yt-dlp/yt-dlp.exe"),
        root.join("bin/yt-dlp.exe"),
    ]
    .into_iter()
    .find(|p| p.is_file())
    .ok_or_else(|| bad("内置视频下载工具缺失，请重新解压完整安装包"))
}
fn verify_youtube(choice: &BrowserChoice) -> Result<Value> {
    match youtube::check_session(&ytdlp()?, choice, Reader::App) {
        Ok(Session::SignedIn) => Ok(json!({"state":"connected","browser":choice.browser.id(),"profile":choice.profile})),
        Ok(Session::SignedOut) => Err(bad("所选浏览器中没有检测到 YouTube 登录。请在该浏览器登录后重试")),
        Err(_) => Err(failed("无法读取所选浏览器的登录状态。请确认已登录 YouTube，关闭该浏览器后重试，或选择其他浏览器；已有连接未改变")),
    }
}
pub async fn youtube_connect(
    State(s): State<AppState>,
    Json(input): Json<Connect>,
) -> Result<Json<Value>> {
    s.accounts
        .run(move |_| {
            let selected = choice(input)?;
            let result = verify_youtube(&selected)?;
            youtube::save_choice(&selected)
                .map_err(|_| failed("浏览器已验证，但连接设置保存失败"))?;
            Ok(Json(result))
        })
        .await
}
pub async fn youtube_check(State(s): State<AppState>, Json(_): Json<Empty>) -> Result<Json<Value>> {
    s.accounts
        .run(|_| {
            let selected = youtube::saved_choice()
                .map_err(|_| bad("连接设置无法读取，请重新连接"))?
                .ok_or_else(|| bad("请先连接 YouTube 浏览器"))?;
            Ok(Json(verify_youtube(&selected)?))
        })
        .await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Disconnect {
    confirm_shared: bool,
}
pub async fn disconnect(
    State(s): State<AppState>,
    Path(platform): Path<String>,
    Json(input): Json<Disconnect>,
) -> Result<Json<Value>> {
    if !input.confirm_shared {
        return Err(bad("请先确认断开会同时影响本机 course2md"));
    }
    s.accounts
        .run(move |state| {
            match platform.as_str() {
                "bilibili" => {
                    state.qr = None;
                    auth::clear_bilibili_login()
                        .map_err(|_| failed("无法清除 B站本地登录，请重试"))?;
                }
                "youtube" => {
                    youtube::clear_youtube_login()
                        .map_err(|_| failed("无法清除 YouTube 连接，请重试"))?;
                }
                _ => return Err(bad("不支持的平台")),
            }
            Ok(Json(json!({"ok":true,"state":"disconnected"})))
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_arbitrary_browser_and_unexpected_credentials() {
        assert!(choice(Connect {
            browser: "--exec=payload".into(),
            profile: None
        })
        .is_err());
        assert!(
            serde_json::from_value::<Connect>(json!({"browser":"edge","cookies":"secret"}))
                .is_err()
        );
        assert!(serde_json::from_value::<Empty>(json!({"password":"secret"})).is_err());
    }
    #[tokio::test]
    async fn serializes_account_operations_without_exposing_state() {
        let accounts = Arc::new(Accounts::new());
        let permit = accounts.gate.clone().acquire_owned().await.unwrap();
        assert!(matches!(
            accounts.clone().run(|_| Ok(())).await,
            Err(ApiError(StatusCode::CONFLICT, _))
        ));
        drop(permit);
        assert!(accounts.run(|_| Ok(())).await.is_ok());
    }
}
