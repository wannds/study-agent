import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { BookOpen, FileText, LoaderCircle, NotebookPen, PenLine, Plus, RefreshCw, RotateCcw, Save, Search, Trash2, Download } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import InkNotebook from './InkNotebook';
import SplitPanels from './layout';
import { request, sheetsOf } from './ink';
import { MAX_NOTE_PAGES, noteStore, type Note, type NoteList, type NoteSummary } from './notes';
import './handwriting.css';
import './notes.css';
type Course = { id: string; title: string };

export function NoteEditor({ id, courses, onMoved, onOpenCourse, toast, compact = false }: { id: string; courses: Course[]; onMoved: () => void; onOpenCourse: (id: string) => void; toast: (message: string) => void; compact?: boolean }) {
  const store = noteStore(id), state = useSyncExternalStore(store.subscribe, store.snapshot);
  const [working, setWorking] = useState(false), [preview, setPreview] = useState(false);
  const note = state.note;
  async function save() { try { await store.flush(); toast('笔记已保存'); } catch { /* Store shows the error with recovery actions. */ } }
  async function move() {
    if (!note) return;
    setWorking(true);
    try { await store.archive(!note.archived); toast(note.archived ? '笔记已恢复' : '笔记已移到回收站，可随时恢复'); onMoved(); }
    catch { /* Local content stays available for retry or export. */ }
    finally { setWorking(false); }
  }
  if (state.loading) return <section className="notes-editor"><p role="status"><LoaderCircle className="spin" size={18} />正在载入笔记…</p></section>;
  if (!note) return <section className="notes-editor"><div role="alert" className="ink-error">{state.error || '笔记不存在'}<button className="button secondary small" onClick={() => void store.reload()}>重新载入</button></div></section>;
  const disabled = note.archived || state.conflict || working;
  const status = state.saving ? '正在保存…' : state.dirty ? '修改待保存' : '已保存到本机';
  return <section className="notes-editor" aria-label="笔记编辑区">
    <div className="notes-editor-heading"><span className="notes-save-status" role="status">{status}{state.localError && ' · 临时备份失败，请等待保存成功后再关闭'}</span><div className="notes-actions">
      <button className="button secondary small" disabled={!state.dirty || state.saving || state.conflict || working} onClick={save}><Save size={14} />保存</button>
      <button className="button ghost small" onClick={() => store.exportBackup()}><Download size={14} />备份</button>
      {!compact && <button className="button ghost small" disabled={state.conflict || working} onClick={move}>{working ? <LoaderCircle size={14} className="spin" /> : note.archived ? <RotateCcw size={14} /> : <Trash2 size={14} />}{note.archived ? '恢复笔记' : '移到回收站'}</button>}
    </div></div>
    {note.archived && <p className="notes-archive-banner">这篇笔记在回收站中，恢复后即可继续编辑。</p>}
    {state.error && <div className="ink-error" role="alert">{state.error}<div><button className="text-button" onClick={() => store.exportBackup()}>导出本窗口草稿</button>{!state.conflict && <button className="text-button" onClick={save}>重试保存</button>}<button className="text-button" onClick={() => void store.reload()}>重新载入</button></div></div>}
    <label className="notes-title-label">笔记标题<input aria-label="笔记标题" value={note.title} maxLength={120} disabled={disabled} placeholder="未命名笔记" onChange={e => store.patch({ title: e.target.value })} /></label>
    {!compact && <div className="notes-course-line"><label>关联课程<select aria-label="关联课程" disabled={disabled} value={note.course_id || ''} onChange={e => store.patch({ course_id: e.target.value || null })}><option value="">独立笔记（不关联课程）</option>{courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>{note.course_id && <button className="text-button" onClick={() => onOpenCourse(note.course_id!)}><BookOpen size={14} />打开课程</button>}</div>}
    <div className="answer-modes notes-modes" role="group" aria-label="笔记编辑方式"><button aria-pressed={state.mode === 'text'} onClick={() => store.mode('text')}><FileText size={15} />文字笔记</button><button aria-pressed={state.mode === 'ink'} onClick={() => store.mode('ink')}><PenLine size={15} />手写笔记</button><span>{note.text.length} 字 · {sheetsOf(note.document, 'answer').length} 页手写纸</span></div>
    {state.mode === 'text' ? <div className="notes-text-pane"><div className="notes-text-heading"><span>文字和手写保存在同一篇笔记中</span><button className="text-button" onClick={() => setPreview(!preview)}>{preview ? '继续编辑' : '预览排版'}</button></div>{preview ? <article className="markdown notes-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ alt }) => <span>{alt || '图片'} · 外部图片未加载</span> }}>{note.text || '这篇笔记还没有文字内容。'}</ReactMarkdown></article> : <textarea className="notes-text" aria-label="笔记正文" placeholder="记录思考、知识点和待解决的问题…支持 Markdown 标题、列表和公式文字。" value={note.text} maxLength={100000} disabled={disabled} onChange={e => store.patch({ text: e.target.value })} />}</div> : <InkNotebook exerciseId={`note-${id}`} kind="answer" paperLabel="笔记纸" canvasLabel="手写笔记" scopeLabel="每篇" maxPages={MAX_NOTE_PAGES} document={note.document} disabled={disabled} onChange={(sheet, index) => store.changeSheet(sheet, index)} onAdd={() => store.addPage()} />}
    <p className="ink-hint notes-local-hint">自动保存在本机，不会自动发送给 AI。文字和手写可以随时切换，原有内容都会保留。</p>
  </section>;
}

const UNLINKED = '__unlinked__';
export function rememberedNote(courseId: string, archived: boolean) {
  try { return localStorage.getItem(`study-notes-selected:${courseId || 'all'}:${archived ? 'trash' : 'active'}`) || (!courseId && !archived ? localStorage.getItem('study-notes-selected') || '' : ''); } catch { return ''; }
}
export function rememberNote(id: string, courseId: string, archived: boolean) {
  try { localStorage.setItem(`study-notes-selected:${courseId || 'all'}:${archived ? 'trash' : 'active'}`, id); } catch { /* Only the selected view is affected. */ }
}

export default function NotesPage({ courses, initialCourseId = '', onOpenCourse, toast }: { courses: Course[]; initialCourseId?: string; onOpenCourse: (id: string) => void; toast: (message: string) => void }) {
  const [items, setItems] = useState<NoteSummary[]>([]), [total, setTotal] = useState(0);
  const [search, setSearch] = useState(''), [query, setQuery] = useState(''), [courseId, setCourseId] = useState(() => { if (initialCourseId) return initialCourseId; try { const saved = localStorage.getItem('study-notes-course') || ''; return saved === UNLINKED || courses.some(c => c.id === saved) ? saved : ''; } catch { return ''; } }), [archived, setArchived] = useState(false);
  const [selected, setSelected] = useState(() => rememberedNote(courseId, false));
  const [loading, setLoading] = useState(true), [creating, setCreating] = useState(false), [error, setError] = useState('');
  const requestId = useRef(0);
  const resolveScope = useRef(true);
  function choose(id: string, trash = archived) { setSelected(id); rememberNote(id, courseId, trash); }
  function switchScope(nextCourse: string, nextArchived: boolean) {
    if (courseId === nextCourse && archived === nextArchived) return;
    requestId.current++; resolveScope.current = true; setLoading(true); setItems([]);
    setSearch(''); setQuery(''); setCourseId(nextCourse); setArchived(nextArchived);
    setSelected(rememberedNote(nextCourse, nextArchived));
  }
  useEffect(() => { try { localStorage.setItem('study-notes-course', courseId); } catch { /* Notes remain saved in SQLite. */ } }, [courseId]);
  const scopeTitle = courseId === UNLINKED ? '独立笔记' : courses.find(c => c.id === courseId)?.title || '全部笔记';
  const load = useCallback(async (offset = 0, showLoading = false) => {
    const ticket = ++requestId.current; if (showLoading) setLoading(true);
    try {
      const params = new URLSearchParams({ q: query, course_id: courseId === UNLINKED ? '' : courseId, unlinked: String(courseId === UNLINKED), archived: String(archived), offset: String(offset) });
      const result = await request<NoteList>(`/notes?${params}`);
      if (ticket !== requestId.current) return;
      setItems(old => offset ? [...old, ...result.items.filter(n => !old.some(o => o.id === n.id))] : result.items); setTotal(result.total); setError('');
      const verifyScope = resolveScope.current; resolveScope.current = false;
      setSelected(current => {
        const state = current ? noteStore(current).value : null;
        const note = state?.note;
        const wrongScope = !!note && !state?.dirty && (note.archived !== archived || (courseId === UNLINKED ? note.course_id !== null : !!courseId && note.course_id !== courseId));
        const next = !current || wrongScope || (verifyScope && !result.items.some(n => n.id === current)) ? result.items[0]?.id || '' : current;
        rememberNote(next, courseId, archived); return next;
      });
    } catch (e) { if (ticket === requestId.current) setError((e as Error).message); }
    finally { if (ticket === requestId.current) setLoading(false); }
  }, [query, courseId, archived]);
  useEffect(() => { const timer = setTimeout(() => setQuery(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { void load(0, true); return () => { requestId.current++; }; }, [load]);
  useEffect(() => { const changed = () => { void load(); }; window.addEventListener('study-notes-changed', changed); return () => window.removeEventListener('study-notes-changed', changed); }, [load]);
  async function create() {
    setCreating(true); setError('');
    try { const note = await request<Note>('/notes', 'POST', { title: '未命名笔记', course_id: courseId && courseId !== UNLINKED ? courseId : null }); noteStore(note.id, note); setSearch(''); setQuery(''); setArchived(false); choose(note.id, false); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setCreating(false); }
  }
  return <main className="dashboard notes-dashboard">
    <div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL NOTES</div><h1>我的笔记<span className="heading-dot">.</span></h1><p>当前：{scopeTitle}。{courseId && courseId !== UNLINKED ? '新建笔记会自动关联这门课程。' : '可选择课程，分别整理对应笔记。'}</p></div><button className="button primary" disabled={creating || loading} onClick={create}>{creating ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}新建笔记</button></div>
    <SplitPanels id="notes-list" label="调整笔记列表与编辑区大小" className="notes-layout" initial={250} minFirst={180} minSecond={300} maxFirst={420} stackBelow={500} verticalInitial={220} verticalMinFirst={150} verticalMinSecond={340}>
      <aside className="notes-list" aria-label="笔记列表"><label className="notes-search"><Search size={15} /><input aria-label="搜索笔记" placeholder="搜索标题或文字…" value={search} maxLength={200} onChange={e => { setSearch(e.target.value); }} /></label>
        <label className="notes-course-selector"><span>选择课程</span><select className="notes-filter" aria-label="按课程筛选笔记" value={courseId} onChange={e => switchScope(e.target.value, archived)}><option value="">全部笔记</option><option value={UNLINKED}>独立笔记（未关联课程）</option>{courses.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
        <div className="notes-list-tabs"><button aria-pressed={!archived} onClick={() => switchScope(courseId, false)}>笔记</button><button aria-pressed={archived} onClick={() => switchScope(courseId, true)}><Trash2 size={13} />回收站</button><button className="icon-button" aria-label="刷新笔记列表" onClick={() => void load(0, true)}><RefreshCw size={14} /></button></div>
        {error && <div className="ink-error" role="alert">{error}<button className="text-button" onClick={() => void load(0, true)}>重试读取</button></div>}
        {loading ? <p className="notes-empty" role="status">正在读取笔记…</p> : <><div className="notes-list-count">共 {total} 篇{archived ? '已移除的笔记' : '笔记'}</div>{!items.length ? <div className="notes-empty"><NotebookPen size={26} /><p>{query || courseId ? '没有符合筛选条件的笔记。' : archived ? '回收站为空。' : '还没有笔记，点击“新建笔记”开始记录。'}</p></div> : items.map(n => <button className={`notes-list-item ${selected === n.id ? 'selected' : ''}`} key={n.id} onClick={() => choose(n.id)}><strong>{n.title}</strong><span>{n.preview.trim() || '手写笔记 / 暂无文字'}</span><small>{n.course_title || '独立笔记'} · {n.page_count} 页</small><time>{new Date(n.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></button>)}{items.length < total && <button className="button secondary small" onClick={() => void load(items.length)}>加载更多</button>}</>}
      </aside>
      {selected ? <NoteEditor key={selected} id={selected} courses={courses} onMoved={() => { choose(''); void load(); }} onOpenCourse={onOpenCourse} toast={toast} /> : <section className="notes-editor notes-empty-editor"><NotebookPen size={36} /><h2>给思考留一页纸</h2><p>选择已有笔记，或新建一篇文字与手写笔记。</p><button className="button secondary" disabled={creating || loading} onClick={create}><Plus size={16} />新建笔记</button></section>}
    </SplitPanels>
  </main>;
}
