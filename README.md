# 知行 · Study Agent

一个本地优先的电脑学习工作台：导入资料和视频，阅读课程，与 AI 助教讨论，做题并记录文字或手写笔记。

**v0.12.0 预览版（Alpha）**。功能持续完善中，适合愿意反馈问题的个人用户。当前提供 Windows x64 桌面端和本机浏览器两种使用方式。

## 下载与启动

普通用户请到本仓库 **Releases** 下载 Windows 便携 ZIP，完整解压到有写入权限的目录，然后双击 `desktop.bat`。不要只提取两个 EXE，也不要在 ZIP 内直接运行。

- `desktop.bat`：独立桌面窗口。
- `start.bat`：启动后台并用浏览器打开本机页面。
- `stop.bat`：完全退出本目录的桌面端和后台。
- 关闭桌面窗口后后台会继续运行，以便完成任务。

桌面版使用 Windows 的 Microsoft Edge WebView2 Runtime；缺少它时需安装微软运行库。运行便携版不需要安装 Rust、Node.js 或 Python。`Code → Download ZIP` 下载的是开发源码，需要按下方步骤构建。

**不需要另行安装 course2md。** 便携包自带视频转换引擎、FFmpeg、yt-dlp 和本地语音识别运行工具。首次遇到需要语音识别的视频，知行会自动下载约 **2.5 GB** 模型到 `runtime/video/models`；之后复用。有字幕时优先使用字幕，不必先下载模型。首次下载需要网络、足够磁盘空间，失败可以重试。源码构建脚本会自动准备运行工具。

建议 Windows 10/11 x64、8 GB 或更多内存。纯阅读和笔记较轻量；本地语音识别会明显占用 CPU/内存，长视频处理时间取决于硬件。默认 CPU、2 线程、720p。此建议不是所有硬件上的性能保证。

## 功能

- **课程学习**：Markdown/TXT 导入、章节阅读、检索、阅读进度、字号和截图开关。
- **可选辅助面板**：助教与课程笔记默认收起，点击显示、再点收起；两者互斥，不挤成三栏。可拖动分栏并记住宽度。
- **文字与手写笔记**：按课程归类、多篇笔记、每篇最多 50 页手写纸、自动保存、回收站、备份和冲突提示；学习页与笔记库共用内容。
- **做题与回看**：AI 出题、文字/手写答案、独立草稿纸、每题两类各最多 20 页、笔色/粗细/橡皮大小、缩略图、核对转录后批改。
- **AI 助教**：基于当前课程回答，工具限于读取章节、检索课程和查看学习进度。
- **模型连接**：多连接配置，支持 Chat Completions、Responses、Anthropic 和 Gemini 接口；可为讲解、分析、出题批改和图像识别分别分配模型。不同服务商的实际兼容性以连接测试和模型能力为准。
- **视频转课程**：链接、本地视频或上传文件，配套 SRT/VTT；字幕/本地 ASR、截图、时间戳、进度、取消和重试。
- **学习计划**：视频完成后可自动分析文字、生成待确认计划，按日期安排学习与复习；分析需自行配置 AI 服务。
- **导出**：Markdown、内嵌截图的离线 HTML；HTML 可以通过浏览器打印为 PDF。
- **来源账号**：Bilibili 扫码及 YouTube 浏览器会话连接，供有访问权限的视频下载使用。

不配置 AI 也能阅读、写笔记、导出和进行本地视频转换。AI 讲解、分析、出题、识别和批改需要用户自己的服务配置，可能产生调用费用。

## 数据与配置

课程、笔记、对话、练习、计划和模型设置保存在 `data/`。视频任务文件也在这里。导出在 `exports/`，日志在 `logs/`。升级时先退出应用并备份 `data/`；不要覆盖自己的数据目录。

**API Key 以明文保存在本机 SQLite 中。** 发布项目或反馈问题时不要上传 `data/`、备份、Cookie 或真实密钥。读取设置接口不会把已保存的密钥返回页面。AI 请求会把有关课程内容或已选择的正式答案发送给所配置的服务；草稿纸不发送，笔记不会自动发给 AI。

账号组件仍使用上游 course2md 的用户配置目录；如果同机装有原版，账号连接状态可能共享，断开前界面会提示。共享账号配置不意味着依赖原版程序。知行的 AI 配置和学习库独立。

程序仅监听 `127.0.0.1`，不是多用户网站，不要直接部署到公网。

## 项目结构与 course2md 的关系

知行是独立应用，不是 course2md 桌面 UI 的套壳或插件：

- 桌面窗口：Rust + Tao + Wry / WebView2。
- 学习后台：Rust + Axum + SQLite。
- 界面：React + TypeScript；构建后静态资源嵌入后台 EXE。
- 视频转换：`vendor/course2md-engine` 中固定版本的引擎源码，编译成知行自带的工作进程。
- 运行工具：`runtime/video`，由脚本按固定校验值准备；模型首次使用时下载。

上游 GPUI 桌面界面不参与知行运行。上游来源与本地修改见 [vendor/README.md](vendor/README.md)，许可信息见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 从源码构建（Windows）

开发环境：Git、Rust（仓库工具链文件指定版本）、Visual Studio C++ Build Tools 与 Windows SDK、Node.js 22.12+、Python 3.11+。首次构建需要联网下载依赖和运行工具，不需要另克隆 course2md。

在克隆得到的本仓库目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-desktop.ps1
.\desktop.bat
```

仅构建浏览器后台：`scripts\build.ps1`。两条构建命令都会准备内置视频工具并编译视频引擎。内存有限时默认使用 2 个 Cargo 编译任务。

生成便携分发包：

```powershell
python scripts\dependency-notices.py
python scripts\package.py
```

输出在 `dist/`，只包含白名单文件，不包含用户数据、API Key、账号、日志、模型或源码备份。源码本身包括转换引擎；GitHub Release 提供编译好的程序和工具。模型不进入 Git 历史。

## 测试

```powershell
npm --prefix web ci
npm --prefix web run build
cargo test --locked --bin study-agent
cargo test --locked --features desktop --bin study-agent-desktop
python -m pip install -r tests\requirements.txt
python tests\course_notes.py
python tests\notes.py
python tests\multipage.py
```

浏览器交互测试使用已安装的 Microsoft Edge，并在独立数据库上运行。夹具模型不代表真实 AI 识别或评分质量。`tests/standalone_video.py` 验证内置引擎在独立目录中处理字幕视频及模型下载失败恢复；真实 ASR 可通过测试选项启用。

## 当前限制

这是预览版：尚无安装向导、签名、自动更新、云同步、多用户、MCP 或 PDF/OCR 导入；当前以 Windows x64 为验证平台。公式目前按普通文本/Markdown 展示。视频画面只做截图，不进行视觉理解。视频来源限制、账号状态、网络和第三方接口变化可能导致任务失败。

学习计划需要用户确认，不会直接安排未经确认的学习任务；AI 评分也不代表已经掌握课程。

## 开源许可

知行自有代码采用 [MIT](LICENSE) 许可证。course2md 以及其他依赖保留各自许可证，原作者署名不会移除。
