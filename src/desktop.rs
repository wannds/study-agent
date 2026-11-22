#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "windows")]
mod desktop {
    use std::{
        collections::hash_map::DefaultHasher,
        fs::{self, OpenOptions},
        hash::{Hash, Hasher},
        os::windows::process::CommandExt,
        path::{Path, PathBuf},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    use tao::{
        dpi::LogicalSize,
        event::{Event, WindowEvent},
        event_loop::{ControlFlow, EventLoopBuilder},
        window::{Icon, WindowBuilder},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::{CreateMutexW, CREATE_NO_WINDOW},
        UI::WindowsAndMessaging::{
            FindWindowW, IsIconic, MessageBoxW, SetForegroundWindow, ShowWindow, MB_ICONERROR,
            MB_ICONINFORMATION, MB_OK, SW_RESTORE,
        },
    };
    use wry::{NewWindowResponse, WebContext, WebViewBuilder};

    type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
    const APP_TITLE: &str = "知行 · 学习工作台（桌面版）";

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(Some(0)).collect()
    }

    pub fn message(text: &str, error: bool) {
        let title = wide(APP_TITLE);
        let body = wide(text);
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                body.as_ptr(),
                title.as_ptr(),
                MB_OK
                    | if error {
                        MB_ICONERROR
                    } else {
                        MB_ICONINFORMATION
                    },
            );
        }
    }

    struct Instance(HANDLE);
    impl Drop for Instance {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn acquire_instance(root: &Path, port: u16, title: &str) -> Result<Option<Instance>> {
        let mut hash = DefaultHasher::new();
        root.to_string_lossy().to_lowercase().hash(&mut hash);
        port.hash(&mut hash);
        let name = wide(&format!("Local\\StudyAgentDesktop-{:x}", hash.finish()));
        unsafe {
            let handle = CreateMutexW(std::ptr::null(), 0, name.as_ptr());
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().into());
            }
            if GetLastError() == ERROR_ALREADY_EXISTS {
                CloseHandle(handle);
                let window = FindWindowW(std::ptr::null(), wide(title).as_ptr());
                if !window.is_null() {
                    if IsIconic(window) != 0 {
                        ShowWindow(window, SW_RESTORE);
                    }
                    SetForegroundWindow(window);
                }
                return Ok(None);
            }
            Ok(Some(Instance(handle)))
        }
    }

    fn root_from_exe(exe: &Path) -> Result<PathBuf> {
        let parent = exe.parent().ok_or("无法确定程序目录")?;
        let root = if parent
            .file_name()
            .is_some_and(|s| s.eq_ignore_ascii_case("bin"))
        {
            parent.parent().ok_or("无法确定项目目录")?
        } else if parent.ends_with("target/release") || parent.ends_with("target/debug") {
            parent
                .parent()
                .and_then(Path::parent)
                .ok_or("无法确定开发目录")?
        } else {
            parent
        };
        Ok(root.to_path_buf())
    }

    fn local_url(value: &str, port: u16) -> bool {
        reqwest::Url::parse(value).is_ok_and(|url| {
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(port)
                && url.username().is_empty()
                && url.password().is_none()
        })
    }

    fn local_download(value: &str, port: u16) -> bool {
        local_url(value.strip_prefix("blob:").unwrap_or(value), port)
    }

    fn external_link(value: &str) {
        if reqwest::Url::parse(value).is_ok_and(|u| matches!(u.scheme(), "http" | "https")) {
            let _ = open::that_detached(value);
        }
    }

    fn export_path(folder: &Path, suggested: &Path) -> PathBuf {
        let stem = suggested
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("课程笔记");
        let stem: String = stem
            .chars()
            .filter(|c| !c.is_control() && !"<>:\"/\\|?*".contains(*c))
            .take(60)
            .collect();
        let stem = stem.trim().trim_matches('.');
        let stem = if stem.is_empty() {
            "课程笔记"
        } else {
            stem
        };
        let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
        let extension = match suggested.extension().and_then(|s| s.to_str()) {
            Some("html") => "html",
            Some("json") => "json",
            _ => "md",
        };
        folder.join(format!("{stem}-{suffix}.{extension}"))
    }

    async fn healthy(client: &reqwest::Client, url: &str) -> bool {
        let Ok(response) = client.get(format!("{url}/api/health")).send().await else {
            return false;
        };
        if !response.status().is_success() {
            return false;
        }
        response
            .json::<serde_json::Value>()
            .await
            .is_ok_and(|v| v["app"] == "study-agent" && v["ok"] == true)
    }

    async fn ensure_backend(root: &Path, data: &Path, port: u16) -> Result<bool> {
        let url = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(2))
            .build()?;
        if healthy(&client, &url).await {
            return Ok(false);
        }
        if tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok()
        {
            return Err(format!(
                "端口 {port} 已被其他服务占用。请关闭冲突程序后重新启动。原有数据不会改变。"
            )
            .into());
        }
        let exe = root.join("bin/study-agent.exe");
        if !exe.is_file() {
            return Err(format!(
                "缺少后台程序：{}。请保留整个 study-agent 文件夹。",
                exe.display()
            )
            .into());
        }
        let logs = root.join("logs");
        fs::create_dir_all(&logs)?;
        fs::create_dir_all(data)?;
        let stdout = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("server.out.log"))?;
        let stderr = OpenOptions::new()
            .create(true)
            .append(true)
            .open(logs.join("server.err.log"))?;
        let mut child = Command::new(exe)
            .current_dir(root)
            .env("STUDY_PORT", port.to_string())
            .env("STUDY_DATA_DIR", data)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()?;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait()? {
                // A simultaneous web launcher may have won the port race.
                if healthy(&client, &url).await {
                    return Ok(false);
                }
                return Err(
                    format!("后台启动失败（{status}），请查看 logs/server.err.log。").into(),
                );
            }
            if healthy(&client, &url).await {
                return Ok(true);
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let _ = child.kill();
        let _ = child.wait();
        Err("后台启动超时，请查看 logs/server.err.log。".into())
    }

    fn icon() -> Option<Icon> {
        let mut rgba = vec![0u8; 32 * 32 * 4];
        for y in 0..32usize {
            for x in 0..32usize {
                let i = (y * 32 + x) * 4;
                let page = (8..24).contains(&x)
                    && ((8..11).contains(&y) || (15..18).contains(&y) || (22..25).contains(&y));
                rgba[i..i + 4].copy_from_slice(if page {
                    &[245, 242, 255, 255]
                } else {
                    &[106, 82, 202, 255]
                });
            }
        }
        Icon::from_rgba(rgba, 32, 32).ok()
    }

    enum DesktopEvent {
        Download(Option<PathBuf>, bool),
    }

    pub fn run() -> Result<()> {
        let root = root_from_exe(&std::env::current_exe()?)?;
        let port: u16 = std::env::var("STUDY_PORT")
            .unwrap_or_else(|_| "8731".into())
            .parse()?;
        let data = std::env::var_os("STUDY_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| root.join("data"));
        let data = if data.is_absolute() {
            data
        } else {
            root.join(data)
        };
        let title = if port == 8731 {
            APP_TITLE.to_owned()
        } else {
            format!("{APP_TITLE} · {port}")
        };
        let Some(instance) = acquire_instance(&root, port, &title)? else {
            return Ok(());
        };
        wry::webview_version()
            .map_err(|e| format!("未找到可用的 Microsoft Edge WebView2 Runtime：{e}"))?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()?;
        let started = runtime.block_on(ensure_backend(&root, &data, port))?;
        drop(runtime);
        let exports = if port == 8731 {
            root.join("exports")
        } else {
            data.join("exports")
        };
        fs::create_dir_all(&exports)?;
        let profile = data.join("desktop-webview");
        fs::create_dir_all(&profile)?;
        let mut context = WebContext::new(Some(profile));
        let event_loop = EventLoopBuilder::<DesktopEvent>::with_user_event().build();
        let window = WindowBuilder::new()
            .with_title(&title)
            .with_inner_size(LogicalSize::new(1120u32, 730u32))
            .with_min_inner_size(LogicalSize::new(820u32, 600u32))
            .with_window_icon(icon())
            .build(&event_loop)?;
        let proxy = event_loop.create_proxy();
        let webview = WebViewBuilder::new_with_web_context(&mut context)
            .with_url(format!("http://127.0.0.1:{port}/"))
            .with_background_color((248, 248, 253, 255))
            .with_devtools(false)
            .with_navigation_handler(move |url| {
                if local_url(&url, port) || local_download(&url, port) || url == "about:blank" {
                    true
                } else {
                    external_link(&url);
                    false
                }
            })
            .with_new_window_req_handler(|url, _| {
                external_link(&url);
                NewWindowResponse::Deny
            })
            .with_download_started_handler(move |url, destination| {
                if !local_download(&url, port) {
                    return false;
                }
                *destination = export_path(&exports, destination);
                true
            })
            .with_download_completed_handler(move |_, path, success| {
                let _ = proxy.send_event(DesktopEvent::Download(path, success));
            })
            .build(&window)?;
        fs::create_dir_all(root.join("logs"))?;
        fs::write(
            root.join("logs/desktop-status.json"),
            serde_json::to_vec_pretty(&serde_json::json!({
                "version": env!("CARGO_PKG_VERSION"), "port": port, "backend_started": started,
                "webview": wry::webview_version().unwrap_or_default(), "data_dir": data,
                "pid": std::process::id(), "note": "Closing the window keeps the backend running; stop.bat exits all components."
            }))?,
        )?;
        event_loop.run(move |event, _, control_flow| {
            // Keep the native window, profile, webview and instance guard alive together.
            let _keep_alive = (&window, &webview, &context, &instance);
            *control_flow = ControlFlow::Wait;
            match event {
                Event::WindowEvent {
                    event: WindowEvent::CloseRequested,
                    ..
                } => *control_flow = ControlFlow::Exit,
                Event::UserEvent(DesktopEvent::Download(path, success)) => {
                    if success {
                        message(
                            &format!(
                                "笔记已导出：\n{}",
                                path.as_deref().unwrap_or(Path::new("exports")).display()
                            ),
                            false,
                        );
                    } else {
                        message("导出失败，请检查 exports 目录是否可写后重试。", true);
                    }
                }
                _ => {}
            }
        });
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_expected_origin_stays_in_window() {
            assert!(local_url("http://127.0.0.1:8731/api/health", 8731));
            for bad in [
                "http://127.0.0.1:8732/",
                "https://127.0.0.1:8731/",
                "file:///C:/secret",
                "http://127.0.0.1.evil:8731/",
                "http://user@127.0.0.1:8731/",
            ] {
                assert!(!local_url(bad, 8731), "{bad}");
            }
            assert!(local_download("blob:http://127.0.0.1:8731/id", 8731));
            assert!(!local_download("blob:https://example.org/id", 8731));
        }

        #[test]
        fn exports_stay_in_output_folder_and_get_unique_names() {
            let folder = Path::new("E:/study-agent/exports");
            let first = export_path(folder, Path::new("C:/Downloads/中文课程.md"));
            let second = export_path(folder, Path::new("C:/Downloads/中文课程.md"));
            assert_eq!(first.parent(), Some(folder));
            assert_eq!(first.extension().unwrap(), "md");
            assert!(first
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("中文课程-"));
            assert_ne!(first, second);
            assert_eq!(
                export_path(folder, Path::new("课程.html"))
                    .extension()
                    .unwrap(),
                "html"
            );
        }

        #[test]
        fn launcher_finds_root_without_current_directory() {
            assert_eq!(
                root_from_exe(Path::new("E:/study-agent/bin/study-agent-desktop.exe")).unwrap(),
                PathBuf::from("E:/study-agent")
            );
            assert_eq!(
                root_from_exe(Path::new(
                    "E:/study-agent/target/release/study-agent-desktop.exe"
                ))
                .unwrap(),
                PathBuf::from("E:/study-agent")
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    if let Err(error) = desktop::run() {
        desktop::message(&format!("桌面版启动失败：\n{error}"), true);
        std::process::exit(1);
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!(
        "This desktop build currently supports Windows. Use the web launcher on other platforms."
    );
}
