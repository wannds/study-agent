use crate::{api::ApiError, db, AppState};
use axum::{
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::FromRow;
use std::{
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

type Result<T> = std::result::Result<T, ApiError>;
fn bad(message: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.to_string())
}
fn io(error: impl std::fmt::Display) -> ApiError {
    ApiError(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("视频处理失败：{error}"),
    )
}
// The distributed worker and tools belong to Study Agent, never a separate install.
fn bundled_root(executable: &FsPath, working_dir: &FsPath) -> PathBuf {
    let directory = executable.parent().unwrap_or(working_dir);
    let app = if directory.file_name().is_some_and(|n| n == "bin") {
        directory.parent().unwrap_or(working_dir)
    } else { working_dir };
    app.join("runtime/video")
}
pub fn engine_root() -> PathBuf {
    // Retain explicit developer overrides; no external-install fallback.
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if let Some(root) = std::env::var_os("STUDY_VIDEO_RUNTIME").or_else(|| std::env::var_os("STUDY_COURSE2MD_DIR")) {
        let root = PathBuf::from(root);
        return if root.is_absolute() { root } else { cwd.join(root) };
    }
    let exe = std::env::current_exe().unwrap_or_else(|_| cwd.join("study-agent.exe"));
    bundled_root(&exe, &cwd)
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(default)]
pub struct Options {
    pub auto_plan: bool,
    pub daily_minutes: u32,
    pub source: String,
    pub title: String,
    pub transcript_source: String,
    pub provider: String,
    pub threads: u32,
    pub sample_interval: f64,
    pub similarity: f64,
    pub cooldown: f64,
    pub slide_mode: String,
    pub stable_secs: f64,
    pub max_height: u32,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            auto_plan: false,
            daily_minutes: 30,
            source: String::new(),
            title: String::new(),
            transcript_source: "auto".into(),
            provider: "cpu".into(),
            threads: 2,
            sample_interval: 1.0,
            similarity: 0.90,
            cooldown: 2.0,
            slide_mode: "first".into(),
            stable_secs: 1.0,
            max_height: 720,
        }
    }
}
impl Options {
    fn validate(&self) -> std::result::Result<(), String> {
        if !(15..=120).contains(&self.daily_minutes) {
            return Err("每日学习时间需在 15—120 分钟之间".into());
        }
        if !["auto", "subtitle", "asr"].contains(&self.transcript_source.as_str())
            || !["cpu", "gpu"].contains(&self.provider.as_str())
            || !["first", "stable"].contains(&self.slide_mode.as_str())
        {
            return Err("识别或截图模式无效".into());
        }
        if !(1..=16).contains(&self.threads)
            || !(0.5..=30.0).contains(&self.sample_interval)
            || !(0.5..=1.0).contains(&self.similarity)
            || !(0.0..=60.0).contains(&self.cooldown)
            || !(0.1..=10.0).contains(&self.stable_secs)
            || ![360, 480, 720, 1080].contains(&self.max_height)
        {
            return Err("处理参数超出支持范围".into());
        }
        if self.title.chars().count() > 100 || self.source.len() > 4096 {
            return Err("名称或来源过长".into());
        }
        Ok(())
    }
}

#[derive(Serialize, FromRow, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub source: String,
    #[serde(skip_serializing)]
    pub options: String,
    pub status: String,
    pub stage: String,
    pub percent: i64,
    pub error: String,
    #[serde(skip_serializing)]
    pub out_dir: String,
    pub course_id: String,
    pub cancel_requested: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub async fn engine_status() -> Json<Value> {
    let root = engine_root();
    let tools = [
        ("course2md", "bin/course2md.exe"),
        ("ffmpeg", "tools/ffmpeg-bin/ffmpeg.exe"),
        ("ffprobe", "tools/ffmpeg-bin/ffprobe.exe"),
        ("yt-dlp", "bin/yt-dlp/yt-dlp.exe"),
        ("llama-server", "tools/llama/llama-server.exe"),
    ];
    let checks: Vec<_> = tools
        .iter()
        .map(|(name, path)| json!({"name":name,"ready":root.join(path).is_file()}))
        .collect();
    let models = root
        .join("models/llama-qwen3-1.7b/Qwen3-ASR-1.7B-Q8_0.gguf")
        .is_file()
        && root
            .join("models/llama-qwen3-1.7b/mmproj-Qwen3-ASR-1.7B-Q8_0.gguf")
            .is_file()
        && root.join("tools/llama/llama-server.exe").is_file();
    Json(
        json!({"root":root,"ready":tools[..3].iter().all(|(_,p)|root.join(p).is_file()),"tools":checks,"local_asr_ready":models,"upload_limit_mb":2048,"note":"内置转换引擎；首次需要语音识别时自动下载约 2.5 GB 模型，下载后复用。"}),
    )
}
pub async fn list(State(s): State<AppState>) -> Result<Json<Vec<Task>>> {
    Ok(Json(
        sqlx::query_as("SELECT * FROM video_tasks ORDER BY created_at DESC LIMIT 100")
            .fetch_all(&s.pool)
            .await?,
    ))
}
async fn task(s: &AppState, id: &str) -> Result<Task> {
    Ok(sqlx::query_as("SELECT * FROM video_tasks WHERE id=?")
        .bind(id)
        .fetch_one(&s.pool)
        .await?)
}

fn normalize_source(source: &str) -> std::result::Result<String, String> {
    let source = source.trim().trim_matches('"');
    if source.starts_with("https://") || source.starts_with("http://") {
        let url = reqwest::Url::parse(source).map_err(|_| "视频链接格式不正确")?;
        if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
            return Err("请使用不含账号密码的视频链接".into());
        }
        return Ok(url.to_string());
    }
    let path = FsPath::new(source);
    if !path.is_absolute() || !path.is_file() {
        return Err("请选择视频文件，或填写存在的完整本地路径".into());
    }
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp4", "mkv", "mov", "webm", "avi", "m4v"].contains(&ext.as_str()) {
        return Err("支持 MP4、MKV、MOV、WebM、AVI、M4V 视频".into());
    }
    Ok(path.to_string_lossy().into_owned())
}
async fn register(s: AppState, mut options: Options, id: String) -> Result<Json<Value>> {
    options.validate().map_err(bad)?;
    options.source = normalize_source(&options.source).map_err(bad)?;
    if !engine_root().join("bin/course2md.exe").is_file() {
        return Err(bad("内置转换引擎缺失，请重新解压完整安装包，或运行 scripts\\build-video.ps1"));
    }
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM video_tasks WHERE status IN ('queued','running')")
            .fetch_one(&s.pool)
            .await?;
    if count >= 5 {
        return Err(bad("最多同时保留 5 个待处理视频，请等待已有任务完成"));
    }
    if options.title.trim().is_empty() {
        options.title = if options.source.starts_with("http") {
            "视频课程".into()
        } else {
            FsPath::new(&options.source)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .take(100)
                .collect()
        };
    }
    let now = db::now();
    sqlx::query("INSERT INTO video_tasks(id,title,source,options,status,stage,created_at,updated_at) VALUES(?,?,?,?,'queued','等待转换',?,?)")
        .bind(&id).bind(options.title.trim()).bind(&options.source).bind(serde_json::to_string(&options).map_err(io)?).bind(now).bind(now).execute(&s.pool).await?;
    schedule(s, id.clone());
    Ok(Json(json!({"id":id})))
}
pub async fn create(
    State(s): State<AppState>,
    Json(options): Json<Options>,
) -> Result<Json<Value>> {
    register(s, options, db::id()).await
}

pub async fn upload(State(s): State<AppState>, mut form: Multipart) -> Result<Json<Value>> {
    let id = db::id();
    let folder = s.data_dir.join("video").join(&id).join("input");
    tokio::fs::create_dir_all(&folder).await.map_err(io)?;
    let mut options = Options::default();
    let mut video = None;
    let mut original = String::new();
    let result: Result<Json<Value>> = async {
        while let Some(mut field) = form
            .next_field()
            .await
            .map_err(|e| bad(format!("上传未完成：{e}")))?
        {
            let name = field.name().unwrap_or("").to_string();
            if name == "options" {
                let value = field.text().await.map_err(bad)?;
                if value.len() > 10000 {
                    return Err(bad("参数过长"));
                }
                options = serde_json::from_str(&value).map_err(|_| bad("视频参数格式错误"))?;
                continue;
            }
            if name != "video" && name != "subtitle" {
                return Err(bad("未知上传字段"));
            }
            let filename = field.file_name().unwrap_or("").to_owned();
            let ext = FsPath::new(&filename)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let allowed = if name == "video" {
                ["mp4", "mkv", "mov", "webm", "avi", "m4v"].contains(&ext.as_str())
            } else {
                ["srt", "vtt"].contains(&ext.as_str())
            };
            if !allowed {
                return Err(bad("文件类型不受支持"));
            }
            let path = folder.join(format!("input.{ext}"));
            let mut output = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .await
                .map_err(io)?;
            let mut size = 0u64;
            let limit = if name == "video" {
                2 * 1024 * 1024 * 1024u64
            } else {
                5 * 1024 * 1024u64
            };
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|e| bad(format!("文件上传中断：{e}")))?
            {
                size += chunk.len() as u64;
                if size > limit {
                    return Err(bad("文件超过大小限制"));
                }
                output.write_all(&chunk).await.map_err(io)?;
            }
            output.flush().await.map_err(io)?;
            if size == 0 {
                return Err(bad("文件为空"));
            }
            if name == "video" {
                if video.is_some() {
                    return Err(bad("每个任务只允许一个视频"));
                }
                video = Some(path);
                original = filename;
            }
        }
        options.source = video
            .as_ref()
            .ok_or_else(|| bad("请选择视频文件"))?
            .to_string_lossy()
            .into_owned();
        if options.title.trim().is_empty() {
            options.title = FsPath::new(&original)
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .chars()
                .take(100)
                .collect();
        }
        register(s.clone(), options, id.clone()).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_dir_all(&folder).await;
    }
    result
}

pub async fn cancel(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let t = task(&s, &id).await?;
    if !["queued", "running"].contains(&t.status.as_str()) {
        return Err(bad("此任务已经结束"));
    }
    sqlx::query("UPDATE video_tasks SET cancel_requested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,stage='正在取消',updated_at=? WHERE id=?")
        .bind(db::now()).bind(id).execute(&s.pool).await?;
    Ok(Json(json!({"ok":true})))
}
pub async fn retry(State(s): State<AppState>, Path(id): Path<String>) -> Result<Json<Value>> {
    let count: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM video_tasks WHERE status IN ('queued','running')")
            .fetch_one(&s.pool)
            .await?;
    if count >= 5 {
        return Err(bad("最多同时保留 5 个待处理视频，请等待已有任务完成"));
    }
    let result=sqlx::query("UPDATE video_tasks SET status='queued',cancel_requested=0,stage='等待重试',error='',updated_at=? WHERE id=? AND status IN ('failed','interrupted','cancelled')")
        .bind(db::now()).bind(&id).execute(&s.pool).await?;
    if result.rows_affected() != 1 {
        return Err(bad("只有失败、中断或取消的任务可以重试"));
    }
    schedule(s, id);
    Ok(Json(json!({"ok":true})))
}
fn schedule(s: AppState, id: String) {
    tokio::spawn(async move {
        let Ok(_permit) = s.video_slots.clone().acquire_owned().await else {
            return;
        };
        match task(&s, &id).await {
            Ok(t) if t.status == "queued" && t.cancel_requested == 0 => {}
            _ => return,
        }
        if let Err(error) = convert(&s, &id).await {
            let message = error.chars().take(1600).collect::<String>();
            let _=sqlx::query("UPDATE video_tasks SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'failed' END,stage='转换未完成',error=?,updated_at=? WHERE id=?").bind(message).bind(db::now()).bind(&id).execute(&s.pool).await;
        }
    });
}

pub async fn asset(
    State(s): State<AppState>,
    Path((id, file)): Path<(String, String)>,
) -> Result<Response> {
    let t = task(&s, &id).await?;
    let path = asset_path(&s, &t, &file).await.map_err(bad)?;
    let bytes = tokio::fs::read(&path).await.map_err(io)?;
    if bytes.len() > 12 * 1024 * 1024 {
        return Err(bad("截图过大"));
    }
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    Ok((
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::CACHE_CONTROL, "private, max-age=86400".into()),
        ],
        bytes,
    )
        .into_response())
}
async fn asset_path(s: &AppState, t: &Task, file: &str) -> std::result::Result<PathBuf, String> {
    if t.out_dir.is_empty()
        || !file.starts_with("frames/")
        || file.split(['/', '\\']).any(|p| p == ".." || p == ".")
    {
        return Err("无效截图路径".into());
    }
    let ext = FsPath::new(file)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    if !["jpg", "jpeg", "png", "webp"].contains(&ext) {
        return Err("仅允许读取课程截图".into());
    }
    let base = tokio::fs::canonicalize(&t.out_dir)
        .await
        .map_err(|_| "截图目录不存在")?;
    let expected = tokio::fs::canonicalize(s.data_dir.join("video").join(&t.id).join("notes"))
        .await
        .map_err(|_| "转换目录不存在")?;
    let path = tokio::fs::canonicalize(base.join(file))
        .await
        .map_err(|_| "截图不存在")?;
    if !base.starts_with(expected) || !path.starts_with(&base) {
        return Err("截图不属于此课程".into());
    }
    Ok(path)
}

async fn convert(s: &AppState, id: &str) -> std::result::Result<(), String> {
    let t = task(s, id).await.map_err(|e| e.1)?;
    let options: Options = serde_json::from_str(&t.options).map_err(|e| e.to_string())?;
    let root = engine_root();
    let job_dir = s.data_dir.join("video").join(id);
    let output = job_dir.join("notes");
    tokio::fs::create_dir_all(&output)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("UPDATE video_tasks SET status='running',stage='启动转换引擎',percent=0,error='',updated_at=? WHERE id=?").bind(db::now()).bind(id).execute(&s.pool).await.map_err(|e|e.to_string())?;
    let mut paths = vec![
        root.join("bin/yt-dlp"),
        root.join("bin"),
        root.join("tools/ffmpeg-bin"),
        root.join("tools/llama"),
    ];
    paths.extend(std::env::split_paths(
        &std::env::var_os("PATH").unwrap_or_default(),
    ));
    let mut cmd = Command::new(root.join("bin/course2md.exe"));
    cmd.current_dir(&root)
        .env(
            "PATH",
            std::env::join_paths(paths).map_err(|e| e.to_string())?,
        )
        .arg(&options.source)
        .arg("-o")
        .arg(&output)
        .args([
            "--json",
            "--formats",
            "md,html,json",
            "--no-llm",
            "--no-summarize",
            "--no-translate",
            "--no-llm-hint",
            "--resume",
            "--download-models",
        ])
        .arg("--model-dir")
        .arg(root.join("models"))
        .arg("--transcript-source")
        .arg(&options.transcript_source)
        .args(["--asr-model", "qwen3-1.7b"])
        .arg("--provider")
        .arg(&options.provider)
        .arg("--threads")
        .arg(options.threads.to_string())
        .arg("--sample-interval")
        .arg(options.sample_interval.to_string())
        .arg("--similarity")
        .arg(options.similarity.to_string())
        .arg("--cooldown")
        .arg(options.cooldown.to_string())
        .arg("--slide-mode")
        .arg(&options.slide_mode)
        .arg("--stable-secs")
        .arg(options.stable_secs.to_string())
        .arg("--max-height")
        .arg(options.max_height.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动 course2md 失败：{e}"))?;
    #[cfg(windows)]
    let guard =
        process_job::attach(child.id().ok_or("子进程没有 PID")?).map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("无法读取转换进度")?;
    let stderr = child.stderr.take().ok_or("无法读取转换日志")?;
    let pool = s.pool.clone();
    let event_id = id.to_string();
    let log_path = job_dir.join("events.ndjson");
    let reader = tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut done = None;
        let mut last_error = String::new();
        let mut log = tokio::fs::File::create(log_path).await.ok();
        let mut logged = 0usize;
        while let Ok(Some(line)) = lines.next_line().await {
            if logged < 8 * 1024 * 1024 {
                if let Some(log) = log.as_mut() {
                    let _ = log.write_all(line.as_bytes()).await;
                    let _ = log.write_all(b"\n").await;
                    logged += line.len();
                }
            }
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                let kind = value["type"].as_str().unwrap_or("");
                if kind == "done" {
                    done = Some(value);
                    continue;
                }
                if kind == "error" || kind == "blocked" {
                    last_error = value["message"]
                        .as_str()
                        .unwrap_or("转换失败")
                        .chars()
                        .take(1500)
                        .collect();
                }
                if kind == "stage" || kind == "progress" {
                    let stage = value["stage"].as_str().unwrap_or("处理中");
                    let total = value["total"].as_f64().unwrap_or(0.0);
                    let current = value["current"].as_f64().unwrap_or(0.0);
                    let percent = if total > 0.0 {
                        (current / total * 100.0).clamp(0.0, 100.0) as i64
                    } else {
                        0
                    };
                    let _=sqlx::query("UPDATE video_tasks SET stage=?,percent=?,updated_at=? WHERE id=? AND status='running'").bind(stage).bind(percent).bind(db::now()).bind(&event_id).execute(&pool).await;
                }
            }
        }
        (done, last_error)
    });
    let errors = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                tail = line.chars().take(1500).collect();
            }
        }
        tail
    });
    let started = Instant::now();
    let mut cancelled = false;
    let status = loop {
        tokio::select! {
            status=child.wait()=>break status.map_err(|e|e.to_string())?,
            _=tokio::time::sleep(Duration::from_millis(700))=>{
                let cancel:i64=sqlx::query_scalar("SELECT cancel_requested FROM video_tasks WHERE id=?").bind(id).fetch_one(&s.pool).await.unwrap_or(1);
                if cancel==1 || started.elapsed()>Duration::from_secs(6*3600){cancelled=cancel==1;#[cfg(windows)] guard.terminate();let _=child.kill().await;break child.wait().await.map_err(|e|e.to_string())?;}
            }
        }
    };
    #[cfg(windows)]
    drop(guard);
    let (done, error) = reader.await.map_err(|e| e.to_string())?;
    let stderr = errors.await.unwrap_or_default();
    if cancelled {
        return Err("任务已取消，可手动重试".into());
    }
    if !status.success() {
        return Err(if !error.is_empty() {
            error
        } else if !stderr.is_empty() {
            stderr
        } else {
            format!("转换进程退出：{status}")
        });
    }
    let done = done.ok_or("转换进程结束，但未返回完整笔记")?;
    if done["partial"].as_bool() == Some(true) {
        let detail = done["outcomes"]
            .as_object()
            .map(|outcomes| {
                outcomes
                    .iter()
                    .filter(|(_, v)| v["status"] == "failed")
                    .map(|(name, v)| {
                        format!("{}: {}", name, v["message"].as_str().unwrap_or("处理失败"))
                    })
                    .collect::<Vec<_>>()
                    .join("；")
            })
            .unwrap_or_default();
        return Err(format!(
            "引擎仅生成部分结果：{detail}。若截图为空，请改用检测到变化即截图，并减小采样间隔。"
        ));
    }
    let out = tokio::fs::canonicalize(done["out_dir"].as_str().ok_or("缺少笔记目录")?)
        .await
        .map_err(|e| e.to_string())?;
    if !out.starts_with(
        tokio::fs::canonicalize(&output)
            .await
            .map_err(|e| e.to_string())?,
    ) {
        return Err("引擎返回的目录不属于此任务".into());
    }
    import_result(s, &t, &out).await
}

async fn import_result(s: &AppState, t: &Task, out: &FsPath) -> std::result::Result<(), String> {
    let bytes = tokio::fs::read(out.join("document.json"))
        .await
        .map_err(|e| format!("无法读取 document.json：{e}"))?;
    if bytes.len() > 20 * 1024 * 1024 {
        return Err("生成笔记过大，请拆分视频后处理".into());
    }
    let doc: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    let sections = doc["sections"].as_array().ok_or("视频笔记缺少章节")?;
    if sections.is_empty() || sections.len() > 1000 {
        return Err("章节数量为空或超过 1000，请调整截图间隔后重试".into());
    }
    let course_id = db::id();
    let mut tx = s.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query("INSERT INTO courses VALUES(?,?,?,?,?)")
        .bind(&course_id)
        .bind(&t.title)
        .bind(format!("{} 个章节 · 视频转图文笔记", sections.len()))
        .bind("video")
        .bind(db::now())
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    let updated = Task {
        out_dir: out.to_string_lossy().into_owned(),
        ..t.clone()
    };
    for (i, section) in sections.iter().enumerate() {
        let seconds = section["t"].as_f64().unwrap_or(0.0).max(0.0) as u64;
        let time = format!("{:02}:{:02}", seconds / 60, seconds % 60);
        let mut content = String::new();
        if let Some(file) = section["image"].as_str() {
            if asset_path(s, &updated, file).await.is_ok() {
                content.push_str(&format!(
                    "![课程截图 {time}](/api/video/assets/{}/{file})\n\n",
                    t.id
                ));
            }
        }
        let speech = section["speech"]
            .as_array()
            .map(|lines| {
                lines
                    .iter()
                    .filter_map(|v| v["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            })
            .unwrap_or_default();
        content.push_str(if speech.trim().is_empty() {
            "本节没有识别到文字，请结合截图阅读。"
        } else {
            &speech
        });
        sqlx::query("INSERT INTO lessons VALUES(?,?,?,?,?,?,'unread')")
            .bind(db::id())
            .bind(&course_id)
            .bind(format!("第 {} 节 · {time}", i + 1))
            .bind(i as i64)
            .bind(content)
            .bind(format!("视频 · {time}"))
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    sqlx::query("UPDATE video_tasks SET status='done',stage='已生成课程',percent=100,course_id=?,out_dir=?,error='',updated_at=? WHERE id=?")
        .bind(&course_id).bind(out.to_string_lossy().as_ref()).bind(db::now()).bind(&t.id).execute(&mut *tx).await.map_err(|e|e.to_string())?;
    let options: Options = serde_json::from_str(&t.options).map_err(|e| e.to_string())?;
    let plan_id = if options.auto_plan {
        let id = db::id();
        sqlx::query("INSERT INTO learning_plans(id,course_id,title,status,daily_minutes,stage,created_at,updated_at) VALUES(?,?,?,'queued',?,'视频已转完，等待 AI 分析',?,?)")
            .bind(&id).bind(&course_id).bind(&t.title).bind(options.daily_minutes).bind(db::now()).bind(db::now())
            .execute(&mut *tx).await.map_err(|e|e.to_string())?;
        Some(id)
    } else {
        None
    };
    tx.commit().await.map_err(|e| e.to_string())?;
    if let Some(id) = plan_id {
        crate::plans::launch(s.clone(), id);
    }
    Ok(())
}

#[cfg(windows)]
mod process_job {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::{JobObjects::*, Threading::*},
    };
    pub struct Job(OwnedHandle);
    impl Job {
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0.as_raw_handle(), 1);
            }
        }
    }
    pub fn attach(pid: u32) -> std::io::Result<Job> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let job = Job(OwnedHandle::from_raw_handle(handle));
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of_val(&info) as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            let ok = AssignProcessToJobObject(handle, process);
            let error = std::io::Error::last_os_error();
            CloseHandle(process);
            if ok == 0 {
                return Err(error);
            }
            Ok(job)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_video_settings() {
        assert!(Options::default().validate().is_ok());
        let mut o = Options::default();
        o.threads = 0;
        assert!(o.validate().is_err());
        o.threads = 2;
        o.similarity = f64::NAN;
        assert!(o.validate().is_err());
    }
    #[test]
    fn rejects_unsafe_sources() {
        assert!(normalize_source("--help").is_err());
        assert!(normalize_source("https://user:secret@example.org/a").is_err());
        assert!(normalize_source("https://www.youtube.com/watch?v=example").is_ok());
    }
}

#[cfg(test)]
mod bundled_runtime_tests {
    use super::*;
    #[test]
    fn packaged_runtime_is_relative_to_executable() {
        assert_eq!(bundled_root(FsPath::new("C:/Apps/Study Agent/bin/study-agent.exe"), FsPath::new("D:/other")), PathBuf::from("C:/Apps/Study Agent/runtime/video"));
    }
    #[test]
    fn development_runtime_is_in_workspace() {
        assert_eq!(bundled_root(FsPath::new("E:/work/target/release/study-agent.exe"), FsPath::new("E:/work")), PathBuf::from("E:/work/runtime/video"));
    }
}
