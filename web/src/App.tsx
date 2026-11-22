import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, ChevronDown, ChevronRight, Circle, Clock3, FileText, FolderOpen, GraduationCap, Layers3, ListChecks, LoaderCircle, MessageCircle, MoreHorizontal, Plus, Search, Send, Settings2, Sparkles, Terminal, Upload, X, Zap, AlertCircle, RotateCcw, CheckCircle2, HardDrive, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Video, Globe, Eye, EyeOff, Minus } from 'lucide-react';
import VideoPage from './VideoPage';
import ExportPage from './ExportPage';
import AccountsPage from './AccountsPage';
import PlansPage from './PlansPage';
import NotesPage, { rememberedNote } from './NotesPage';
import { noteStore } from './notes';
import CourseNotesPanel from './CourseNotesPanel';
import ModelSettings from './ModelSettings';
import { NotebookPen } from 'lucide-react';
import ExerciseCard from './ExerciseCard';
import SplitPanels, { LayoutWarning, resetLayouts } from './layout';
import { CalendarDays } from 'lucide-react';
import { Link2 } from 'lucide-react';
import { localImage } from './media';

type Course = { id: string; title: string; description: string; source_kind: string; created_at: number; lesson_count: number; read_count: number };
type Lesson = { id: string; course_id: string; title: string; ordinal: number; content: string; source_label: string; reading_status: string };
type Message = { id: string; role: string; content: string; sources: string; created_at: number };
type Job = { id: string; lesson_id: string; kind: string; status: string; stage: string; error: string; created_at: number; updated_at: number };
type Exercise = { id: string; lesson_id: string; question: string; reference_answer: string; rubric: string; student_answer: string; score: number | null; feedback: string; status: string; created_at: number };
type Settings = { base_url: string; model: string; has_api_key: boolean; ready: boolean; analysis_ready?:boolean;practice_ready?:boolean;vision_ready?:boolean;analysis_model?:string;practice_model?:string;vision_model?:string };
type Stats = { courses: number; lessons: number; read: number; graded: number; running: number };
type HistoryItem = { id: string; course_id: string; lesson_id: string; lesson_title: string; course_title: string; question: string; status: string; score: number | null; created_at: number };
type View = 'courses' | 'workspace' | 'exercises' | 'jobs' | 'video' | 'exports' | 'accounts' | 'plans' | 'notes';
const active = (j: Job) => ['queued', 'running'].includes(j.status);
const jobNames: Record<string, string> = { chat: '助教问答', quiz: '生成练习', grade: '作答评估' };
const statusNames: Record<string, string> = { queued: '排队中', running: '执行中', done: '已完成', failed: '失败', interrupted: '已中断' };
const sourceName = (kind: string) => ({ video: '视频课程', markdown: 'Markdown', text: '文字资料', course2md: 'course2md', '示例课程': '示例课程' }[kind] || kind);

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = response.headers.get('content-type') || '';
  const result = ct.includes('json') ? await response.json() : { error: await response.text() };
  if (!response.ok) throw new Error(result.error || `请求失败（${response.status}）`);
  return result as T;
}

function Markdown({ children }: { children: string }) {
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => localImage(src) ? <img className="course-screenshot" src={src} alt={alt || '课程截图'} loading="lazy" /> : <span className="image-placeholder"><FileText size={15} />{alt || '图片'} · 外部图片未导入</span>,
  }}>{children}</ReactMarkdown></div>;
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => { const fn = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; document.addEventListener('keydown', fn); return () => document.removeEventListener('keydown', fn); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}><section role="dialog" aria-modal="true" aria-label={title} className={`modal ${wide ? 'wide' : ''}`}>
    <div className="modal-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>{children}
  </section></div>;
}

export default function App() {
  const [view, setView] = useState<View>('courses');
  const [noteCourseId, setNoteCourseId] = useState('');
  const [sidePanel,setSidePanel]=useState<'none'|'assistant'|'notes'>('none');
  const [panelSwitchBusy,setPanelSwitchBusy]=useState(false);
  const panelSwitchLock=useRef(false);
  async function changePanel(next:'none'|'assistant'|'notes') {
    if(panelSwitchLock.current)return false;
    panelSwitchLock.current=true;setPanelSwitchBusy(true);
    try {
      if(sidePanel==='notes'&&next!=='notes'&&course){
        const id=rememberedNote(course.id,false);
        if(id){const store=noteStore(id);if(store.value.dirty||store.value.saving)await store.flush();}
      }
      setSidePanel(next);return true;
    } catch { toast('笔记尚未保存成功，请在笔记区重试保存或导出备份。');return false; }
    finally {panelSwitchLock.current=false;setPanelSwitchBusy(false);}
  }
  function openNotes(id = '') { setNoteCourseId(id); setView('notes'); }
  const [planCourseId, setPlanCourseId] = useState('');
  function openPlans(id = '') { setPlanCourseId(id); setView('plans'); }
  const [courses, setCourses] = useState<Course[]>([]);
  const [stats, setStats] = useState<Stats>({ courses: 0, lessons: 0, read: 0, graded: 0, running: 0 });
  const [settings, setSettings] = useState<Settings>({ base_url: '', model: '', has_api_key: false, ready: false });
  const [course, setCourse] = useState<Course | null>(null);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [lessonId, setLessonId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [exercises, setExercises] = useState<Exercise[]>([]);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [tab, setTab] = useState<'chat' | 'practice'>('chat');
  const [question, setQuestion] = useState('');
  const [search, setSearch] = useState('');
  const [readerSearch, setReaderSearch] = useState('');
  const [readerSize, setReaderSize] = useState(15);
  const [showImages, setShowImages] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [notice, setNotice] = useState('');
  const [bootError, setBootError] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [eventJob, setEventJob] = useState<Job | null>(null);
  const [events, setEvents] = useState<{ tool: string; detail: string; created_at: number }[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);
  const currentId = useRef(lessonId);
  currentId.current = lessonId;
  const lesson = lessons.find(l => l.id === lessonId);
  const lessonJobs = jobs.filter(j => j.lesson_id === lessonId);
  const pending = lessonJobs.filter(active);
  const chatBusy = pending.some(j => j.kind === 'chat');

  const toast = (text: string) => setNotice(text);
  const handleError = (e: unknown) => toast(e instanceof Error ? e.message : '操作失败，请重试');
  async function refresh() {
    const [cs, st, config, js] = await Promise.all([api<Course[]>('/courses'), api<Stats>('/stats'), api<Settings>('/settings'), api<Job[]>('/jobs')]);
    setCourses(cs); setStats(st); setSettings(config); setJobs(js); setBootError('');
  }
  async function refreshLesson(id: string) {
    const [ms, ex] = await Promise.all([api<Message[]>(`/lessons/${id}/messages`), api<Exercise[]>(`/lessons/${id}/exercises`)]);
    if (currentId.current === id) { setMessages(ms); setExercises(ex); }
  }
  useEffect(() => { refresh().catch(e => setBootError(e.message)).finally(() => setLoading(false)); }, []);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 5500); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    let disposed = false;
    const timer = setInterval(async () => {
      try {
        const js = await api<Job[]>('/jobs'); if (disposed) return;
        setJobs(js); setBootError('');
        if (lessonId) await refreshLesson(lessonId);
        if (disposed) return;
        const st = await api<Stats>('/stats'); if (!disposed) setStats(st);
      } catch { if (!disposed) setBootError('无法连接本地后台，请确认学习工具仍在运行。'); }
    }, 2500);
    return () => { disposed = true; clearInterval(timer); };
  }, [lessonId]);
  useEffect(() => {
    setMessages([]); setExercises([]); setQuestion(localStorage.getItem(`study-question-${lessonId}`) || '');
    if (lessonId) refreshLesson(lessonId).catch(handleError);
  }, [lessonId]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, chatBusy]);
  useEffect(() => { if (view === 'exercises') api<HistoryItem[]>('/exercises').then(setHistory).catch(handleError); }, [view, stats.graded]);

  async function openCourse(id: string, target?: string, practice = false) {
    try {
      const data = await api<{ course: Course; lessons: Lesson[] }>(`/courses/${id}`);
      const saved = localStorage.getItem(`study-position-${id}`);
      const chosen = data.lessons.find(l => l.id === (target || saved)) || data.lessons.find(l => l.reading_status !== 'read') || data.lessons[0];
      setCourse(data.course); setLessons(data.lessons); setLessonId(chosen?.id || ''); setTab(practice ? 'practice' : 'chat'); setSidePanel(practice ? 'assistant' : 'none'); setView('workspace');
    } catch (e) { handleError(e); }
  }
  function chooseLesson(id: string) { setLessonId(id); if (course) localStorage.setItem(`study-position-${course.id}`, id); }
  async function markRead() {
    if (!lesson) return;
    try {
      const status = lesson.reading_status === 'read' ? 'unread' : 'read';
      await api(`/lessons/${lesson.id}/progress`, 'PUT', { status });
      setLessons(ls => ls.map(l => l.id === lesson.id ? { ...l, reading_status: status } : l));
      await refresh(); toast(status === 'read' ? '已记录阅读完成，掌握程度由练习进一步检验' : '已恢复为未读');
    } catch (e) { handleError(e); }
  }
  async function ask(text = question) {
    if (!lesson || !text.trim() || sending || chatBusy) return;
    if (!settings.ready) { setShowSettings(true); return; }
    setSending(true); setTab('chat');
    try {
      await api(`/lessons/${lesson.id}/chat`, 'POST', { question: text.trim() });
      setQuestion(''); localStorage.removeItem(`study-question-${lesson.id}`);
      await Promise.all([refresh(), refreshLesson(lesson.id)]);
    } catch (e) { handleError(e); } finally { setSending(false); }
  }
  async function newExercise() {
    if (!lesson || !(await changePanel('assistant'))) return;
    setTab('practice');
    if (!(settings.practice_ready ?? settings.ready)) { setShowSettings(true); return; }
    setSending(true); setTab('practice');
    try { await api(`/lessons/${lesson.id}/exercises`, 'POST'); await refresh(); } catch (e) { handleError(e); } finally { setSending(false); }
  }
  async function retry(job: Job) { try { await api(`/jobs/${job.id}/retry`, 'POST'); await refresh(); toast('任务已重新排队'); } catch (e) { handleError(e); } }
  async function showEvents(job: Job) { setEventJob(job); setEvents([]); try { setEvents(await api(`/jobs/${job.id}/events`)); } catch (e) { handleError(e); } }
  async function exportCourse(format: 'html' | 'md') {
    if (!course) return;
    setExporting(true);
    try { const { exportCourseFile } = await import('./export'); const name = await exportCourseFile({ title: course.title, lessons }, { format, images: true, toc: true, progress: false }); toast(`已生成 ${name}`); } catch (e) { handleError(e); } finally { setExporting(false); }
  }

  return <><SplitPanels id="nav" label="调整导航栏宽度" className="app-shell" initial={224} minFirst={76} maxFirst={340} minSecond={420}>
    <aside className="sidebar">
      <button className="brand" onClick={() => setView('courses')}><div className="brand-icon"><Layers3 size={24} strokeWidth={1.8} /></div><div><strong>知行</strong><span>STUDY AGENT</span></div><span className="version">α</span></button>
      <div className="space-label">个人学习空间</div>
      <nav className="main-nav">
        <button aria-label="课程空间" title="课程空间" className={view === 'courses' || view === 'workspace' ? 'selected' : ''} onClick={() => setView('courses')}><BookOpen size={19} /><span>课程空间</span><span className="nav-count">{stats.courses}</span></button>
        <button aria-label="我的笔记" title="我的笔记" className={view === 'notes' ? 'selected' : ''} onClick={() => openNotes()}><NotebookPen size={19} /><span>我的笔记</span></button>
        <button aria-label="视频转笔记" title="视频转笔记" className={view === 'video' ? 'selected' : ''} onClick={() => setView('video')}><Video size={19} /><span>视频转笔记</span></button>
        <button aria-label="学习计划" title="学习计划" className={view === 'plans' ? 'selected' : ''} onClick={() => openPlans()}><CalendarDays size={19} /><span>学习计划</span></button>
        <button className={view === 'exercises' ? 'selected' : ''} onClick={() => setView('exercises')}><ListChecks size={19} /><span>练习记录</span></button>
        <button className={view === 'jobs' ? 'selected' : ''} onClick={() => setView('jobs')}><Terminal size={18} /><span>运行任务</span>{stats.running > 0 && <span className="nav-count">{stats.running}</span>}</button>
        <button aria-label="导出中心" title="导出中心" className={view === 'exports' ? 'selected' : ''} onClick={() => setView('exports')}><Globe size={19} /><span>导出中心</span></button>
      </nav>
      <div className="sidebar-divider" />
      <div className="space-label with-action">最近课程<button className="icon-button" aria-label="导入课程" onClick={() => setShowImport(true)}><Plus size={16} /></button></div>
      <div className="recent-courses">{courses.slice(0, 5).map((c, i) => <button key={c.id} className={course?.id === c.id && view === 'workspace' ? 'current' : ''} onClick={() => openCourse(c.id)}><span className={`course-dot dot-${i % 3}`} /><span>{c.title}</span></button>)}</div>
      <div className="sidebar-bottom">
        <div className="local-card"><span className="status-dot" /><div><strong>本地学习空间</strong><small>资料与进度保存在这台电脑</small></div><HardDrive size={16} /></div>
        <button className="settings-nav" aria-label="账号连接" title="账号连接" onClick={() => setView('accounts')}><Link2 size={18} /><span>账号连接</span></button>
        <button className="settings-nav" aria-label="模型设置" onClick={() => setShowSettings(true)}><Settings2 size={18} /><span>模型设置</span><span className={`mini-status ${settings.ready ? 'ready' : ''}`}>{settings.ready ? '已配置' : '待配置'}</span></button>
        <div className="sidebar-footer">RUST POWERED <span>v0.12.0</span></div>
      </div>
    </aside>

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><span>学习空间</span><ChevronRight size={14} /><strong>{view === 'workspace' ? course?.title : view === 'exercises' ? '练习记录' : view === 'jobs' ? '运行任务' : view === 'video' ? '视频转笔记' : view === 'exports' ? '导出中心' : view === 'accounts' ? '账号连接' : view === 'plans' ? '学习计划' : view === 'notes' ? '我的笔记' : '我的课程'}</strong></div><div className="topbar-actions"><button className="button secondary layout-reset" onClick={() => { resetLayouts(); toast('已恢复默认布局，课程和笔迹保持不变'); }}><RotateCcw size={14} />恢复默认布局</button><span className="local-tag"><span className="status-dot" />本机运行</span><button className="avatar" title="个人空间"><GraduationCap size={20} /></button></div></header>
      <LayoutWarning />
      {bootError && <div className="connection-error"><AlertCircle size={18} />后台连接失败：{bootError}<button onClick={() => refresh().catch(e => setBootError(e.message))}>重试连接</button></div>}
      {loading ? <div className="loading-page"><LoaderCircle className="spin" />正在打开学习空间…</div> : <>
        {view === 'notes' && <NotesPage key={noteCourseId || 'all-notes'} courses={courses} initialCourseId={noteCourseId} onOpenCourse={openCourse} toast={toast} />}
        {view === 'plans' && <PlansPage courses={courses} initialCourseId={planCourseId} onOpen={openCourse} onSettings={() => setShowSettings(true)} toast={toast} />}
        {view === 'accounts' && <AccountsPage onModelSettings={() => setShowSettings(true)} />}
        {view === 'video' && <VideoPage onPlans={openPlans} onSettings={() => setShowSettings(true)} modelReady={settings.analysis_ready ?? settings.ready} onAccounts={() => setView('accounts')} onOpen={id => openCourse(id)} onChange={refresh} toast={toast} />}
        {view === 'exports' && <ExportPage courses={courses} initialId={course?.id} toast={toast} />}
        {view === 'courses' && <main className="dashboard">
          <div className="page-heading"><div><div className="eyebrow">YOUR LEARNING WORKSPACE</div><h1>我的课程<span className="heading-dot">.</span></h1><p>从一份资料开始，让每次学习都有所收获。</p></div><div className="heading-actions"><button className="button secondary" onClick={() => setView('video')}><Video size={17} />处理视频</button><button className="button primary" onClick={() => setShowImport(true)}><Plus size={17} />导入课程</button></div></div>
          <section className="welcome-banner"><div><span className="banner-label"><Sparkles size={14} />你的个人学习助教</span><h2>把读过的，变成真正懂的。</h2><p>阅读资料、随时提问、动手练习。<br />让理解留在答案里，让进度接得上。</p><button className="text-button" onClick={() => settings.ready ? (courses[0] && openCourse(courses[0].id)) : setShowSettings(true)}>{settings.ready ? '开始今天的学习' : '连接你的 AI 助教'}<ArrowRight size={16} /></button></div><div className="banner-art" aria-hidden="true"><div className="art-orbit" /><div className="art-sheet back" /><div className="art-sheet front"><div className="art-book"><BookOpen size={29} strokeWidth={1.5} /></div><span /><span /><span className="short" /><div className="art-check"><Check size={14} />理解 +1</div></div><div className="art-spark"><Sparkles size={25} /></div></div></section>
          <div className="stats-row"><Stat icon={<FolderOpen size={20} />} value={stats.courses} label="已导入课程" /><Stat icon={<BookOpen size={20} />} value={`${stats.read} / ${stats.lessons}`} label="已读章节" /><Stat icon={<CheckCheck size={20} />} value={stats.graded} label="已评估练习" /></div>
          <div className="section-heading"><div><h2>课程资料</h2><span>{courses.length} 门课程</span></div><label className="search-box"><Search size={16} /><input aria-label="搜索课程" placeholder="搜索课程…" value={search} onChange={e => setSearch(e.target.value)} /><kbd>⌕</kbd></label></div>
          <div className="course-grid">{courses.filter(c => c.title.toLowerCase().includes(search.toLowerCase())).map((c, i) => <button key={c.id} className="course-card" onClick={() => openCourse(c.id)}><div className="course-card-top"><div className={`course-icon color-${i % 3}`}><BookOpen size={23} strokeWidth={1.6} /></div><span className="source-badge">{sourceName(c.source_kind)}</span></div><h3>{c.title}</h3><p>{c.description}</p><div className="course-meta"><span><Layers3 size={14} />{c.lesson_count} 个章节</span><span>{new Date(c.created_at).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</span></div><div className="progress-track"><span style={{ width: `${c.lesson_count ? c.read_count / c.lesson_count * 100 : 0}%` }} /></div><div className="course-card-bottom"><span>{c.read_count === 0 ? '准备开始' : `已读 ${c.read_count} / ${c.lesson_count} 节`}</span><span className="continue-link">{c.read_count ? '继续学习' : '开始学习'}<ArrowRight size={14} /></span></div></button>)}
            {!search && <button className="import-card" onClick={() => setShowImport(true)}><div><Plus size={24} /></div><strong>添加新的学习资料</strong><span>Markdown · 文本 · course2md 笔记</span></button>}
          </div>
          {search && !courses.some(c => c.title.toLowerCase().includes(search.toLowerCase())) && <Empty icon={<Search />} title="没有找到课程" text="试试其他关键词，或导入新的学习资料。" />}
          <div className="dashboard-note"><HardDrive size={15} />资料导入保存在本机。使用 AI 时，相关文字会发送到你配置的模型服务。</div>
        </main>}

        {view === 'workspace' && course && <main className="workspace">
          <div className="workspace-heading"><div className="workspace-title"><button className="icon-button" title="返回课程" onClick={() => setView('courses')}><ArrowLeft size={19} /></button><div><h1>{course.title}</h1><p>{lessons.length} 个章节 · {sourceName(course.source_kind)}</p></div></div><div className="heading-actions"><button className="button secondary small" disabled={panelSwitchBusy} aria-pressed={sidePanel==='assistant'} aria-expanded={sidePanel==='assistant'} onClick={() => void changePanel(sidePanel==='assistant'?'none':'assistant')}><Sparkles size={15} />学习助教</button><button className="button secondary small" disabled={panelSwitchBusy} aria-pressed={sidePanel==='notes'} aria-expanded={sidePanel==='notes'} onClick={() => void changePanel(sidePanel==='notes'?'none':'notes')}><NotebookPen size={15} />课程笔记</button><button className="button secondary small" onClick={() => openPlans(course.id)}><CalendarDays size={15} />学习计划</button><button className="button secondary small" disabled={exporting} onClick={() => setView('exports')}><ArrowDownToLine size={15} />导出笔记</button></div></div>
          <label className="compact-lesson-picker">当前章节<select aria-label="选择章节" value={lessonId} onChange={e => chooseLesson(e.target.value)}>{lessons.map((l, i) => <option key={l.id} value={l.id}>{i + 1}. {l.title}{l.reading_status === 'read' ? ' · 已读' : ''}</option>)}</select></label>
          <div className="reader-controls"><label><Search size={15} /><input aria-label="搜索当前课程" placeholder="搜索当前课程…" value={readerSearch} onChange={e => setReaderSearch(e.target.value)} /></label><button title="缩小字号" aria-label="缩小字号" onClick={() => setReaderSize(s => Math.max(12, s - 1))}><Minus size={15} /></button><span>{readerSize}px</span><button title="放大字号" aria-label="放大字号" onClick={() => setReaderSize(s => Math.min(24, s + 1))}><Plus size={15} /></button><button onClick={() => setShowImages(v => !v)}>{showImages ? <Eye size={15} /> : <EyeOff size={15} />}截图</button><button disabled={exporting} onClick={() => exportCourse('html')}><Globe size={15} />HTML</button><button disabled={exporting} onClick={() => exportCourse('md')}><FileText size={15} />MD</button></div>{readerSearch.trim() && <div className="course-search-results">{lessons.filter(l => (l.title + l.content).toLowerCase().includes(readerSearch.toLowerCase())).slice(0, 20).map(l => <button key={l.id} onClick={() => { chooseLesson(l.id); setReaderSearch(''); }}><Search size={14} /><span>{l.title}</span><ArrowRight size={14} /></button>)}{!lessons.some(l => (l.title + l.content).toLowerCase().includes(readerSearch.toLowerCase())) && <p>没有找到相关章节</p>}</div>}<SplitPanels id="toc" label="调整课程目录宽度" className="workspace-grid" initial={164} minFirst={130} maxFirst={320} minSecond={280}>
            <aside className="lesson-sidebar"><div className="lesson-toc-title">课程目录<span>{lessons.filter(l => l.reading_status === 'read').length}/{lessons.length}</span></div><div className="lesson-list">{lessons.map((l, i) => <button className={l.id === lessonId ? 'selected' : ''} key={l.id} onClick={() => chooseLesson(l.id)}><span className={`lesson-number ${l.reading_status === 'read' ? 'complete' : ''}`}>{l.reading_status === 'read' ? <Check size={13} /> : String(i + 1).padStart(2, '0')}</span><span>{l.title}</span></button>)}</div><div className="toc-footer"><BookOpen size={14} />已读不等于已掌握</div></aside>
            <SplitPanels id="reader-agent" label={sidePanel==='notes'?'调整阅读区与课程笔记大小':'调整阅读区与学习助教大小'} className="reader-agent-split" initial={350} anchor="second" minFirst={300} minSecond={300} maxSecond={900} stackBelow={640} verticalInitial={350} verticalMinFirst={260} verticalMinSecond={300}>
            <section className="reader-panel">{lesson ? <><div className="reader-toolbar"><span><FileText size={14} />课程原文</span><button className={`read-toggle ${lesson.reading_status === 'read' ? 'is-read' : ''}`} onClick={markRead}>{lesson.reading_status === 'read' ? <CheckCircle2 size={15} /> : <Circle size={15} />}{lesson.reading_status === 'read' ? '已读' : '标记已读'}</button></div><article className={`reader-content ${showImages ? '' : 'hide-pictures'}`} style={{ fontSize: readerSize }} key={lesson.id}><div className="lesson-source">{lesson.source_label}</div>{!lesson.content.trimStart().startsWith('# ') && <h1>{lesson.title}</h1>}<Markdown>{lesson.content}</Markdown><div className="reader-end"><span>本节阅读结束</span><button className="text-button" onClick={newExercise}>用一道题检验理解<ArrowRight size={14} /></button></div></article></> : <Empty icon={<BookOpen />} title="请选择章节" text="从左侧目录开始学习。" />}</section>
            {sidePanel==='assistant' ? <aside className="agent-panel"><div className="agent-heading"><div className="agent-icon"><Sparkles size={19} /></div><div><strong>学习助教</strong><span>{tab==='practice' ? ((settings.practice_ready ?? settings.ready) ? (settings.practice_model || settings.model) : '配置出题与批改模型') : settings.ready ? settings.model : '连接模型后开始交流'}</span></div><button className="icon-button" title="模型设置" onClick={() => setShowSettings(true)}><Settings2 size={17} /></button><button className="icon-button agent-close" aria-label="收起学习助教" onClick={()=>void changePanel('none')}><X size={17}/></button></div><div className="agent-tabs"><button className={tab === 'chat' ? 'selected' : ''} onClick={() => setTab('chat')}><MessageCircle size={15} />讲解与提问</button><button className={tab === 'practice' ? 'selected' : ''} onClick={() => setTab('practice')}><ListChecks size={15} />本节练习{exercises.length > 0 && <span>{exercises.length}</span>}</button></div>
              <SplitPanels id="chat-composer" label="调整对话区与输入区高度" className="agent-chat-split" axis="vertical" initial={155} verticalInitial={155} anchor="second" minFirst={120} minSecond={120} verticalMinFirst={120} verticalMinSecond={120}>
              <div className="agent-body">{tab === 'chat' ? <>
                {messages.length === 0 && <div className="assistant-empty"><div className="empty-spark"><Sparkles size={27} strokeWidth={1.5} /></div><h3>一起读懂这一节</h3><p>哪里不清楚，就从哪里开始。<br />助教会结合当前课程资料回答。</p>{!settings.ready && <button className="button primary small" onClick={() => setShowSettings(true)}>配置模型接口<ArrowRight size={14} /></button>}<div className="prompt-suggestions"><button onClick={() => ask('请用容易理解的方式讲解这一节的核心内容。')}><BookOpen size={15} /><span>讲解这一节</span><ArrowRight size={14} /></button><button onClick={() => ask('请结合这一节的核心概念，给我一个简单具体的例子。原文没有的内容请标为补充。')}><Sparkles size={15} /><span>举个简单的例子</span><ArrowRight size={14} /></button><button onClick={newExercise}><ListChecks size={15} /><span>出一道理解题</span><ArrowRight size={14} /></button></div></div>}
                {messages.map(m => <div className={`message ${m.role}`} key={m.id}><div className="message-role">{m.role === 'assistant' ? <><Sparkles size={13} />学习助教</> : '你'}</div><Markdown>{m.content}</Markdown>{m.role === 'assistant' && <Sources raw={m.sources} onChoose={chooseLesson} />}</div>)}
                {pending.filter(j => j.kind === 'chat').map(j => <JobProgress key={j.id} job={j} />)}
                {lessonJobs.filter(j => j.kind === 'chat' && ['failed', 'interrupted'].includes(j.status)).slice(0, 1).map(j => <JobError key={j.id} job={j} onRetry={() => retry(j)} />)}<div ref={chatEnd} />
              </> : <><div className="practice-header"><p>把理解写下来，再获得反馈。</p><button className="button secondary small" disabled={sending || pending.some(j => j.kind === 'quiz')} onClick={newExercise}><Plus size={14} />生成练习</button></div>{pending.filter(j => j.kind !== 'chat').map(j => <JobProgress key={j.id} job={j} />)}{lessonJobs.filter(j => j.kind !== 'chat' && ['failed', 'interrupted'].includes(j.status)).slice(0, 1).map(j => <JobError key={j.id} job={j} onRetry={() => retry(j)} />)}
                {exercises.length === 0 && !pending.some(j => j.kind === 'quiz') && <Empty icon={<ListChecks size={30} />} title="用练习检验理解" text="生成一道基于本节材料的问题。答案提交后，助教会给出具体反馈。" />}
                {exercises.map(e => <ExerciseCard key={e.id} exercise={e} busy={pending.some(j => j.kind === 'grade')} ready={settings.practice_ready ?? settings.ready} visionReady={settings.vision_ready ?? settings.ready} onConfigure={() => setShowSettings(true)} onChange={async () => { await refresh(); await refreshLesson(lessonId); }} toast={toast} />)}
              </>}</div>
              {tab === 'chat' && <div className="composer-wrapper"><div className="composer"><textarea aria-label="向助教提问" placeholder={settings.ready ? '问一问当前章节…' : '先配置模型，再开始提问…'} value={question} maxLength={4000} onChange={e => { setQuestion(e.target.value); localStorage.setItem(`study-question-${lessonId}`, e.target.value); }} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(); } }} /><div className="composer-bottom"><span><FileText size={12} />关联当前课程</span><button className="send-button" aria-label="发送问题" disabled={!question.trim() || sending || chatBusy} onClick={() => ask()}>{sending || chatBusy ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}</button></div></div><p className="composer-hint">Enter 发送 · Shift + Enter 换行</p></div>}
              </SplitPanels>
            </aside> : sidePanel==='notes' ? <CourseNotesPanel key={course.id} course={course} courses={courses} onClose={()=>void changePanel('none')} onOpenLibrary={()=>openNotes(course.id)} onOpenCourse={openCourse} toast={toast}/> : null}
            </SplitPanels>
          </SplitPanels>
        </main>}

        {view === 'exercises' && <main className="dashboard"><div className="page-heading"><div><div className="eyebrow">LEARNING EVIDENCE</div><h1>练习记录<span className="heading-dot">.</span></h1><p>留下每一次作答，看清具体的进步。</p></div></div>{history.length === 0 ? <div className="empty-page"><Empty icon={<ListChecks size={35} />} title="第一份学习证据，从一道题开始" text="打开一门课程，在右侧「本节练习」生成题目。你的答案和批改会保存在这里。" /><button className="button primary" onClick={() => setView('courses')}>去课程空间<ArrowRight size={16} /></button></div> : <div className="history-list">{history.map(e => <button className="history-card" key={e.id} onClick={() => openCourse(e.course_id, e.lesson_id, true)}><div className="history-icon"><ListChecks size={20} /></div><div><span className="lesson-source">{e.course_title} / {e.lesson_title}</span><h3>{e.question}</h3><span className="muted">{new Date(e.created_at).toLocaleString('zh-CN')}</span></div><span className={`exercise-status ${e.status === 'graded' ? 'graded' : ''}`}>{e.status === 'graded' ? `${e.score} 分` : e.status === 'answered' ? '等待批改' : '等待作答'}</span><ChevronRight size={18} /></button>)}</div>}<div className="dashboard-note"><CheckCheck size={15} />分数只表示本题表现，不自动代表知识点掌握程度。</div></main>}

        {view === 'jobs' && <main className="dashboard"><div className="page-heading"><div><div className="eyebrow">AGENT ACTIVITY</div><h1>运行任务<span className="heading-dot">.</span></h1><p>每一步执行都有记录。失败和中断可以手动重试。</p></div><span className="quiet-badge">单任务执行 · 最多 20 条等待</span></div>{jobs.length === 0 ? <Empty icon={<Terminal size={35} />} title="还没有运行记录" text="发起提问或生成练习后，可以在这里查看执行状态。" /> : <div className="job-list">{jobs.map(j => <div className="job-row" key={j.id}><div className={`job-status-icon ${j.status}`}>{active(j) ? <LoaderCircle className="spin" size={19} /> : j.status === 'done' ? <Check size={19} /> : <AlertCircle size={19} />}</div><div className="job-description"><strong>{jobNames[j.kind]}</strong><p>{j.error || j.stage}</p><span>{new Date(j.created_at).toLocaleString('zh-CN')}</span></div><span className={`status-pill ${j.status}`}>{statusNames[j.status]}</span><button className="button ghost small" onClick={() => showEvents(j)}>工具记录</button>{['failed', 'interrupted'].includes(j.status) && <button className="button secondary small" onClick={() => retry(j)}><RotateCcw size={14} />重试</button>}</div>)}</div>}</main>}
      </>}
    </div>
    </SplitPanels>
    {notice && <div className="toast" role="status"><AlertCircle size={17} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="关闭通知"><X size={15} /></button></div>}
    {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={async id => { setShowImport(false); await refresh(); await openCourse(id); toast('课程已导入，开始学习吧'); }} />}
    {showSettings && <ModelSettings onClose={() => setShowSettings(false)} onSaved={refresh} />}
    {eventJob && <Modal title="工具执行记录" subtitle={`${jobNames[eventJob.kind]} · ${statusNames[eventJob.status]}`} onClose={() => setEventJob(null)}><div className="modal-body">{events.length ? events.map((e, i) => <div className="tool-event" key={i}><strong><Terminal size={14} />{e.tool}</strong><pre>{e.detail}</pre><small>{new Date(e.created_at).toLocaleTimeString('zh-CN')}</small></div>) : <p className="muted">该任务没有额外的工具调用记录。讲解可直接使用当前章节；出题与批改使用固定的资料流程。</p>}</div></Modal>}
  </>;
}

function Stat({ icon, value, label }: { icon: ReactNode; value: number | string; label: string }) { return <div className="stat"><div className="stat-icon">{icon}</div><div><strong>{value}</strong><span>{label}</span></div></div>; }
function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) { return <div className="empty"><div className="empty-icon">{icon}</div><h3>{title}</h3><p>{text}</p></div>; }
function Sources({ raw, onChoose }: { raw: string; onChoose: (id: string) => void }) { try { const sources = JSON.parse(raw) as { lesson_id: string; title: string }[]; return <div className="sources">{sources.map(s => <button key={s.lesson_id} onClick={() => onChoose(s.lesson_id)}><FileText size={12} />{s.title}</button>)}</div>; } catch { return null; } }
function JobProgress({ job }: { job: Job }) { return <div className="job-progress"><LoaderCircle size={16} className="spin" /><div><strong>{job.stage}</strong><span>你可以继续阅读，结果会自动保存。</span></div></div>; }
function JobError({ job, onRetry }: { job: Job; onRetry: () => void }) { return <div className="job-error"><AlertCircle size={16} /><div><strong>{statusNames[job.status]}</strong><p>{job.error}</p><button className="text-button" onClick={onRetry}><RotateCcw size={13} />重试任务</button></div></div>; }

function ImportModal({ onClose, onImported }: { onClose: () => void; onImported: (id: string) => Promise<void> }) {
  const [title, setTitle] = useState(''); const [content, setContent] = useState(''); const [format, setFormat] = useState('markdown'); const [filename, setFilename] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const input = useRef<HTMLInputElement>(null);
  async function readFile(file: File) {
    setError(''); if (file.size > 4 * 1024 * 1024) { setError('文件超过 4 MB，请按课程拆分后导入'); return; }
    if (!/\.(md|markdown|txt|json)$/i.test(file.name)) { setError('请选择 .md、.txt 或 course2md 的 .json 文件'); return; }
    const text = await file.text(); setContent(text); setFilename(file.name); setTitle(file.name.replace(/\.[^.]+$/, '')); setFormat(file.name.endsWith('.json') ? 'course2md' : file.name.endsWith('.txt') ? 'text' : 'markdown');
    if (file.name.endsWith('.json')) { try { const j = JSON.parse(text); const t = (j.document || j).meta?.title; if (t) setTitle(String(t).slice(0, 100)); } catch { setError('文件不是有效 JSON，请检查文件内容'); } }
  }
  async function submit() { setBusy(true); setError(''); try { const result = await api<{ id: string }>('/courses', 'POST', { title, content, format }); await onImported(result.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return <Modal title="导入学习资料" subtitle="资料保存在本机，导入过程不会调用 AI。" onClose={onClose} wide><div className="modal-body"><button className="dropzone" onClick={() => input.current?.click()} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]).catch(e => setError(e.message)); }}><div><Upload size={22} /></div><strong>{filename || '点击选择文件，或拖放到这里'}</strong><span>Markdown / TXT / course2md document.json · 最多 4 MB</span></button><input ref={input} type="file" accept=".md,.markdown,.txt,.json" hidden onChange={e => { if (e.target.files?.[0]) readFile(e.target.files[0]).catch(e => setError(e.message)); }} /><div className="form-row"><label>课程名称<input value={title} maxLength={100} placeholder="例如：电路原理 · 第一章" onChange={e => setTitle(e.target.value)} /></label><label className="format-field">资料格式<select value={format} onChange={e => setFormat(e.target.value)}><option value="markdown">Markdown</option><option value="text">纯文本</option><option value="course2md">course2md JSON</option></select></label></div><label className="form-field">资料正文<span>也可以直接粘贴内容；Markdown 的一级、二级标题用于分节。</span><textarea className="import-text" placeholder={'# 课程名称\n\n## 第一节\n在这里粘贴你的学习资料…'} value={content} onChange={e => setContent(e.target.value)} /></label><p className="form-help">这里导入文字资料；视频请到左侧「视频转笔记」，转换后会自动保留截图。PDF 尚未接入。</p>{error && <div className="form-error"><AlertCircle size={15} />{error}</div>}</div><div className="modal-footer"><button className="button secondary" onClick={onClose}>取消</button><button className="button primary" disabled={!title.trim() || !content.trim() || busy} onClick={submit}>{busy ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}导入并开始学习</button></div></Modal>;
}

