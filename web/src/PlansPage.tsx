import SplitPanels from './layout';
import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Sparkles, ArrowRight, RefreshCw, Check, LoaderCircle, BookOpen, RotateCcw, AlertCircle } from 'lucide-react';
import './plans.css';

type Plan = { id: string; course_id: string; title: string; status: string; daily_minutes: number; start_date: string; stage: string; error: string };
type Source = { lesson_id: string; title: string; label: string; start: number; end: number };
type Unit = { title: string; summary: string; key_points: string[]; difficulties: string[]; objective: string; minutes: number; sources: Source[] };
type Task = { id: string; unit_index: number; lesson_id: string; kind: string; title: string; minutes: number; due_date: string; done: number };
type Detail = { plan: Plan; analysis: { summary?: string; units?: Unit[]; warnings?: string[]; total_chunks?: number; analyzed_chunks?: number }; tasks: Task[] };
const names: Record<string, string> = { queued: '等待分析', running: '分析中', waiting_model: '等待配置模型', interrupted: '已中断', failed: '需重试', draft: '待确认', active: '学习中', completed: '已完成安排' };
const working = (p: Plan) => ['queued', 'running'].includes(p.status);
function localDate() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const r = await fetch(`/api${path}`, { method: body === undefined ? 'GET' : method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await r.json(); if (!r.ok) throw new Error(result.error || '学习计划请求失败'); return result;
}
export default function PlansPage({ courses, initialCourseId, onOpen, onSettings, toast }: {
  courses: { id: string; title: string }[]; initialCourseId?: string; onOpen: (course: string, lesson?: string, practice?: boolean) => void; onSettings: () => void; toast: (s: string) => void;
}) {
  const [plans, setPlans] = useState<Plan[]>([]); const [selected, setSelected] = useState(''); const selection = useRef(''); selection.current = selected;
  const [courseId, setCourseId] = useState(initialCourseId || courses[0]?.id || ''); const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState('');
  const [minutes, setMinutes] = useState(30); const [start, setStart] = useState(localDate()); const [filter, setFilter] = useState('today');
  const formPlan = useRef(''); const [reload, setReload] = useState(0);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const rows = await api<Plan[]>('/plans'); if (disposed) return; setPlans(rows);
        let id = selection.current;
        if (!id) { id = rows.find(p => p.course_id === initialCourseId)?.id || rows[0]?.id || ''; if (id) setSelected(id); }
        if (id) { const d = await api<Detail>(`/plans/${id}`); if (disposed || (selection.current && selection.current !== id)) return; setDetail(d);
          if (formPlan.current !== id) { formPlan.current = id; setMinutes(d.plan.daily_minutes); setStart(d.plan.start_date || localDate()); }
        }
        setLoading(false);
      } catch (e) { if (!disposed) { setError((e as Error).message); setLoading(false); } }
      finally { if (!disposed) timer = setTimeout(poll, 2500); }
    }
    poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [selected, initialCourseId, reload]);
  const refresh = () => setReload(n => n + 1);
  async function act(fn: () => Promise<void>) { setBusy(true); setError(''); try { await fn(); refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function generate() { await act(async () => { const p = await api<{ id: string; existing?: boolean }>(`/courses/${courseId}/plan`, { daily_minutes: 30 }); setSelected(p.id); setDetail(null); toast(p.existing ? '已打开这门课的学习计划' : '已加入分析队列，完成后生成计划草稿'); }); }
  const p = detail?.plan; const units = detail?.analysis.units || []; const tasks = detail?.tasks || []; const today = localDate();
  const unfinished = tasks.filter(t => !t.done); const due = unfinished.filter(t => t.due_date <= today); const overdue = unfinished.filter(t => t.due_date < today);
  const visible = tasks.filter(t => filter === 'all' || (filter === 'today' ? !t.done && t.due_date <= today : filter === 'upcoming' ? !t.done && t.due_date > today : filter === 'review' ? t.kind === 'review' : !!t.done));
  return <main className="dashboard plans-page">
    <div className="page-heading"><div><div className="eyebrow">A COURSE, ONE STEP AT A TIME</div><h1>学习计划<span className="heading-dot">.</span></h1><p>先分析课程，再确认每天的学习与复习安排。</p></div><button className="button secondary" onClick={() => { setError(''); refresh(); }}><RefreshCw size={16} />刷新</button></div>
    <section className="feature-panel plan-create"><div><label className="feature-field">选择已有课程<select aria-label="计划课程" value={courseId} onChange={e => setCourseId(e.target.value)}>{!courses.length && <option value="">请先导入资料或转换视频</option>}{courses.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></label><p className="feature-hint">生成会把课程文字发送给已配置的模型，按分段调用并可能产生费用。已有计划会直接打开；原文和截图保留。</p></div><button className="button primary" disabled={busy || !courseId} onClick={generate}><Sparkles size={16} />{plans.some(p => p.course_id === courseId) ? '打开已有计划' : '分析并生成草稿'}</button></section>
    {error && <div className="form-error" role="alert"><AlertCircle size={16} />{error}</div>}
    {loading ? <p className="plan-status" role="status"><LoaderCircle className="spin" size={18} />正在读取学习计划…</p> : !plans.length ? <div className="video-empty"><CalendarDays size={30} /><p>还没有学习计划。选择一门课程生成，或在视频转换时开启自动分析。</p><button className="button secondary" onClick={onSettings}>配置学习助教模型</button></div> : <SplitPanels id="plan-list" label="调整计划列表与详情区大小" className="plan-layout" initial={225} minFirst={160} maxFirst={420} minSecond={300} stackBelow={520} verticalInitial={150} verticalMinFirst={100} verticalMinSecond={260}>
      <nav className="feature-panel plan-list" aria-label="课程计划">{plans.map(item => <button key={item.id} className={selected === item.id ? 'selected' : ''} onClick={() => { setSelected(item.id); setDetail(null); setError(''); }}><span>{item.title}</span><small>{names[item.status]}</small></button>)}</nav>
      <div className="plan-content">{!p ? <p className="plan-status">正在读取计划详情…</p> : <>
        <section className="feature-panel"><div className="plan-title"><h2>{p.title}</h2><span className="quiet-badge">{names[p.status]}</span></div><p className="plan-status" role="status">{working(p) && <LoaderCircle className="spin" size={16} />}{p.stage}</p>
          {p.error && <p className="form-error">{p.error}</p>}
          {working(p) && <p className="feature-hint">可以离开此页，分析在后台继续。已保存的分析单元：{units.length}{detail?.analysis.total_chunks ? ` / ${detail.analysis.total_chunks}` : ''}。</p>}
          {['waiting_model', 'failed', 'interrupted'].includes(p.status) && <div className="account-actions"><button className="button primary" disabled={busy} onClick={() => act(async () => { await api(`/plans/${p.id}/retry`, {}); toast('继续分析已排队，已保存分段会复用'); })}><RotateCcw size={15} />继续分析</button><button className="button secondary" onClick={onSettings}>模型设置</button><span className="feature-hint">未保存的失败请求可能需要重新调用模型。</span></div>}
          {detail?.analysis.summary && <p className="plan-prose">{detail.analysis.summary}</p>}
          {!!detail?.analysis.warnings?.length && <div className="plan-warning">{detail.analysis.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>}
          <p className="feature-hint">AI 依据字幕和课程文字分析，不识别截图内容。学习时长为估计，结果可对照原文检查。</p>
          <button className="button ghost small" onClick={() => onOpen(p.course_id)}><BookOpen size={15} />阅读完整课程</button>
        </section>
        {p.status === 'draft' && <section className="feature-panel plan-confirm"><h2>确认学习安排</h2><p className="feature-hint">{units.length} 个学习单元，预计学习 {units.reduce((sum, u) => sum + u.minutes, 0)} 分钟，另加每单元 3 次、每次 5 分钟的复习。确认前不会创建日期任务。</p><div className="feature-fields"><label className="feature-field">开始日期<input aria-label="计划开始日期" type="date" min="2000-01-01" max="2100-12-31" value={start} onChange={e => setStart(e.target.value)} /></label><label className="feature-field">本课程每天可用时间（分钟）<input aria-label="每日学习分钟" type="number" min={15} max={120} value={minutes} onChange={e => setMinutes(+e.target.value)} /></label></div><p className="feature-hint">学习按顺序安排，复习目标为单元学习后的第 1、3、7 天；当日时间已满会顺延。此时间预算仅用于本课程，多门课程可能同日安排。</p><button className="button primary" disabled={busy || !start || minutes < 15 || minutes > 120} onClick={() => act(async () => { const v = await api<{ task_count: number }>(`/plans/${p.id}/confirm`, { start_date: start, daily_minutes: minutes }); toast(`已创建 ${v.task_count} 项学习与复习安排`); })}><Check size={16} />确认并开始学习计划</button></section>}
        {!!tasks.length && <section className="feature-panel"><div className="plan-title"><h2>学习与复习安排</h2><span className="quiet-badge">已完成 {tasks.length - unfinished.length} / {tasks.length}</span></div><p className="feature-hint">今天及待补做 {due.length} 项 · 共 {due.reduce((n, t) => n + t.minutes, 0)} 分钟{overdue.length ? ` · 其中 ${overdue.length} 项已逾期` : ''}。完成状态由你确认，不会自动认定已掌握。</p><label className="feature-field">查看任务<select aria-label="学习任务筛选" value={filter} onChange={e => setFilter(e.target.value)}><option value="today">今天及待补做</option><option value="upcoming">未来安排</option><option value="review">全部复习</option><option value="done">已完成</option><option value="all">全部安排</option></select></label>
          {!visible.length && <p className="feature-hint">当前筛选下没有任务，可以查看未来或全部安排。</p>}
          <div className="plan-task-list">{visible.map(t => <article className={`plan-task ${t.done ? 'done' : ''}`} key={t.id}><div><strong>{t.title}</strong><p>{t.due_date} · {t.minutes} 分钟{!t.done && t.due_date < today ? ' · 待补做' : ''}</p><span>{units[t.unit_index]?.objective}</span></div><div className="account-actions"><button className="button secondary small" onClick={() => onOpen(p.course_id, t.lesson_id, t.kind === 'review')}>{t.kind === 'review' ? '阅读与练习' : '开始学习'}<ArrowRight size={14} /></button><button className="button ghost small" disabled={busy} onClick={() => act(async () => { await api(`/plan-tasks/${t.id}`, { done: !t.done }, 'PUT'); })}>{t.done ? <RotateCcw size={14} /> : <Check size={14} />}{t.done ? '撤销完成' : '标记完成'}</button></div></article>)}</div>
        </section>}
        {!!units.length && <section className="feature-panel"><div className="plan-title"><h2>AI 分析与学习单元</h2><span className="quiet-badge">{units.length} 个已保存单元</span></div><div className="plan-units">{units.map((u, i) => <details key={i}><summary><span>{i + 1}. {u.title}</span><small>约 {u.minutes} 分钟</small></summary><p className="plan-prose">{u.summary}</p><h3>学习目标</h3><p>{u.objective}</p><h3>知识点</h3><ul>{u.key_points.map((point, n) => <li key={n}>{point}</li>)}</ul>{!!u.difficulties.length && <><h3>重点难点</h3><ul>{u.difficulties.map((point, n) => <li key={n}>{point}</li>)}</ul></>}<h3>对应课程原文</h3><div className="plan-sources">{u.sources.map((source, n) => <button className="button ghost small" key={n} onClick={() => onOpen(p.course_id, source.lesson_id)}><BookOpen size={14} />{source.title} · {source.label} · 文字 {source.start + 1}—{source.end}</button>)}</div></details>)}</div></section>}
      </>}</div>
    </SplitPanels>}
  </main>;
}
