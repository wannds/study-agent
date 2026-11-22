import SplitPanels, { resetInkLayout, useInkDirection } from './layout';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, ChevronDown, ListChecks, LoaderCircle, Maximize2, PenLine, Sparkles, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import InkNotebook from './InkNotebook';
import { hasAnswerInk, inkStore, request, sheetsOf } from './ink';
import './handwriting.css';
import { localImage } from './media';

type Exercise = { id: string; question: string; reference_answer: string; rubric: string; student_answer: string; score: number | null; feedback: string; status: string };
function Markdown({ children }: { children: string }) { return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
  a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>,
  img: ({ src, alt }) => localImage(src) ? <img className="course-screenshot" src={src} alt={alt || '课程截图'} loading="lazy" /> : <span className="image-placeholder">{alt || '图片'} · 外部图片未导入</span>,
}}>{children}</ReactMarkdown></div>; }

export default function ExerciseCard({ exercise: e, busy, ready, visionReady=ready, onConfigure, onChange, toast }: { exercise: Exercise; busy: boolean; ready: boolean; visionReady?:boolean; onConfigure: () => void; onChange: () => Promise<void>; toast: (s: string) => void }) {
  const [store] = useState(() => inkStore(e.id));
  const ink = useSyncExternalStore(store.subscribe, store.snapshot);
  const [answer, setAnswer] = useState(() => { try { return localStorage.getItem(`study-answer-${e.id}`) ?? e.student_answer; } catch { return e.student_answer; } });
  const [saving, setSaving] = useState(false), [recognizing, setRecognizing] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [includeImage, setIncludeImage] = useState(false);
  const [expanded, setExpanded] = useState(false), [scratch, setScratch] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const [inkDirection, setInkDirection] = useInkDirection();
  const graded = e.status === 'graded', submitted = e.status === 'answered';
  const locked = graded || submitted || busy || saving || recognizing;
  useEffect(() => { setConfirmed(false); }, [ink.document.answer, ink.document.answer_extra]);
  useEffect(() => { if (expanded && dialog.current && !dialog.current.open) dialog.current.showModal(); }, [expanded]);
  async function recognize() {
    if (!visionReady) { setExpanded(false); onConfigure(); return; }
    setRecognizing(true); setError(''); setConfirmed(false);
    try {
      await store.flush();
      const v = await request<{ text: string; revision: number }>(`/exercises/${e.id}/ink/recognize`, 'POST', { revision: store.value.revision });
      if (v.revision !== store.value.revision || store.value.dirty) throw new Error('原稿已改变，请重新识别');
      store.transcript(v.text); toast('识别完成，请对照原稿核对文字与公式');
    } catch (err) { setError((err as Error).message); }
    finally { setRecognizing(false); }
  }
  async function submit(grade: boolean) {
    if (grade && !(ink.mode === 'ink' && includeImage ? visionReady : ready)) { setExpanded(false); onConfigure(); return; }
    setSaving(true); setError('');
    try {
      await store.flush();
      const handwritten = ink.mode === 'ink';
      if (grade && handwritten && !confirmed) throw new Error('请先核对识别文字，并勾选确认');
      if (!grade) {
        if (!handwritten) await request(`/exercises/${e.id}/draft`, 'PUT', { answer });
        toast('草稿已保存');
      } else {
        await request(`/exercises/${e.id}/grade`, 'POST', { answer: handwritten ? store.value.transcript : answer, ...(handwritten ? { handwriting_revision: store.value.revision, handwriting_confirmed: true, include_image: includeImage } : {}) });
        try { localStorage.removeItem(`study-answer-${e.id}`); } catch { /* Server submission succeeded. */ }
        setExpanded(false); toast('答案和原稿已保存，正在等待批改'); await onChange();
      }
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }
  function textChange(text: string) {
    setAnswer(text);
    try { localStorage.setItem(`study-answer-${e.id}`, text); }
    catch { setError('浏览器存储已满，请点击保存草稿保存到学习库'); }
  }
  const status = ink.loading ? '正在载入原稿…' : ink.saving ? '正在保存…' : ink.dirty ? '笔迹待同步到学习库' : '原稿已同步到学习库';
  const editor = <div className="handwriting-editor">
    <div className="answer-modes" role="group" aria-label="答题方式">
      <button aria-pressed={ink.mode === 'text'} disabled={locked || ink.loading} onClick={() => store.mode('text')}>键盘输入</button>
      <button aria-pressed={ink.mode === 'ink'} disabled={locked || ink.loading} onClick={() => store.mode('ink')}><PenLine size={15} />手写答题</button>
      {!expanded && <button className="ink-expand" disabled={ink.loading} onClick={() => setExpanded(true)}><Maximize2 size={15} />展开书写</button>}
    </div>
    {ink.loading ? <p className="ink-hint">正在载入本题原稿…</p> : <>
      {ink.mode === 'text' ? <><label className="answer-label">写下你的理解</label><textarea className="answer-input" aria-label="练习答案" placeholder="试着用自己的话回答…" value={answer} maxLength={10000} disabled={locked} onChange={event => textChange(event.target.value)} /></> : <>
        <InkNotebook exerciseId={e.id} kind="answer" document={ink.document} disabled={locked || ink.conflict} onChange={(sheet, index) => store.change('answer', sheet, index)} onAdd={() => store.addPage('answer')} />
        <div className="ink-recognize">
          <p>识别会按页码发送本题全部有笔迹的答题页，空白页自动跳过；草稿纸不发送。需要支持图片输入的模型，可能产生模型费用。</p>
          <button className="button secondary" disabled={locked || ink.conflict || !hasAnswerInk(ink.document)} onClick={recognize}>{recognizing ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}{recognizing ? '正在识别…' : '识别手写答案'}</button>
        </div>
        <label className="answer-label" htmlFor={`transcript-${e.id}`}>核对识别文字与公式（也可手动填写）</label>
        <textarea id={`transcript-${e.id}`} className="answer-input" placeholder="识别后请对照上方原稿，修正负号、上下标和公式。识别失败也可在此手动转录。" value={ink.transcript} maxLength={10000} disabled={locked} onChange={ev => { store.transcript(ev.target.value); setConfirmed(false); }} />
        <label className="ink-check"><input type="checkbox" checked={confirmed} disabled={locked || !ink.transcript.trim()} onChange={ev => setConfirmed(ev.target.checked)} />我已对照原稿核对文字和公式</label>
        <label className="ink-check"><input type="checkbox" checked={includeImage} disabled={locked} onChange={ev => setIncludeImage(ev.target.checked)} />批改时同时发送全部答题页图片（草稿纸不发送，需要图片模型）</label>
      </>}
      <div className="ink-scratch"><button className="text-button" aria-expanded={scratch} onClick={() => setScratch(!scratch)}>{scratch ? '收起草稿纸' : '打开草稿纸'}<ChevronDown size={14} /></button><span>仅本机保存，不参与批改</span></div>
      {scratch && <InkNotebook exerciseId={e.id} kind="scratch" document={ink.document} disabled={locked || ink.conflict} onChange={(sheet, index) => store.change('scratch', sheet, index)} onAdd={() => store.addPage('scratch')} />}
      <div className="ink-save-status" role="status">{status}{ink.localError && ' · 本机临时备份失败，请等待同步成功后再关闭'}</div>
    </>}
    {(error || ink.error) && <div className="ink-error" role="alert">{error || ink.error}{ink.error && <div><button className="text-button" onClick={() => store.recoverDownload()}>导出本窗口草稿</button>{ink.conflict ? <button className="text-button" onClick={() => void store.reload()}>重新载入原稿</button> : <button className="text-button" onClick={() => void store.flush().catch(() => {})}>重试保存</button>}</div>}</div>}
    {submitted ? <p className="ink-hint">答案已提交，原稿已锁定。批改失败时可使用本节上方的“重试任务”。</p> : <div className="answer-actions">
      <button className="button ghost small" disabled={locked || ink.loading || ink.conflict} onClick={() => submit(false)}>保存草稿</button>
      <button className="button primary small" disabled={locked || ink.loading || ink.conflict || (ink.mode === 'ink' ? !confirmed || !ink.transcript.trim() || !hasAnswerInk(ink.document) : !answer.trim())} onClick={() => submit(true)}>{saving || busy ? <LoaderCircle className="spin" size={14} /> : <ArrowRight size={14} />}确认并提交批改</button>
    </div>}
  </div>;
  return <section className="exercise-card">
    <div className="exercise-card-heading"><span><ListChecks size={14} />理解练习</span><span className={`exercise-status ${graded ? 'graded' : ''}`}>{graded ? `${e.score} / 100` : submitted ? '已提交' : '等待作答'}</span></div>
    <Markdown>{e.question}</Markdown>
    {graded ? <>
      <div className="answer-display"><span>你的答案</span><p>{e.student_answer}</p></div>
      {ink.loading && <p className="ink-hint">正在载入手写原稿…</p>}
      {ink.error && <p className="ink-error" role="alert">{ink.error}<button onClick={() => void store.reload()}>重试载入</button></p>}
      {hasAnswerInk(ink.document) && <details className="ink-original"><summary>查看手写原稿（{sheetsOf(ink.document, 'answer').length} 页）</summary><InkNotebook exerciseId={e.id} kind="answer" document={ink.document} disabled /><button className="text-button" onClick={() => setExpanded(true)}>放大原稿<Maximize2 size={14} /></button></details>}
      {sheetsOf(ink.document, 'scratch').some(p => p.strokes.length) && <details><summary>查看本题草稿纸（未提交）</summary><InkNotebook exerciseId={e.id} kind="scratch" document={ink.document} disabled /></details>}
      <div className="feedback"><h4><Sparkles size={14} />助教反馈</h4><Markdown>{e.feedback}</Markdown></div>
      <details className="reference"><summary>查看参考答案与评分要点<ChevronDown size={14} /></summary><Markdown>{e.reference_answer + '\n\n**评分要点**\n\n' + e.rubric}</Markdown></details>
    </> : expanded ? <p className="ink-hint">正在展开的书写窗口中答题</p> : editor}
    {expanded && createPortal(<dialog ref={dialog} className="ink-dialog" onCancel={() => setExpanded(false)} onClose={() => setExpanded(false)}>
      <header><div><strong>手写答题</strong><span>原稿与当前题目绑定，书写后自动保存</span></div><div className="ink-dialog-actions"><div className="ink-direction" role="group" aria-label="手写窗口排列"><button aria-pressed={inkDirection === 'horizontal'} onClick={() => setInkDirection('horizontal')}>左右排列</button><button aria-pressed={inkDirection === 'vertical'} onClick={() => setInkDirection('vertical')}>上下排列</button></div><button className="button secondary layout-reset" onClick={resetInkLayout}>恢复默认布局</button><button autoFocus aria-label="收起书写" className="icon-button" onClick={() => setExpanded(false)}><X size={22} /></button></div></header>
      <SplitPanels id="ink.panes" label="调整题目区与书写区大小" className="ink-dialog-layout" axis={inkDirection} initial={280} minFirst={160} maxFirst={650} minSecond={260} verticalInitial={180} verticalMinFirst={100} verticalMinSecond={240}><aside><span className="answer-label">当前题目</span><Markdown>{e.question}</Markdown>{graded ? <><span className="answer-label">批改反馈</span><Markdown>{e.feedback}</Markdown></> : <p className="ink-hint">先书写，再识别、核对和提交。关闭书写窗口不会清空草稿。</p>}</aside><main>{graded ? <div className="ink-original"><InkNotebook exerciseId={e.id} kind="answer" document={ink.document} disabled /><details><summary>回看本题草稿纸（未提交）</summary><InkNotebook exerciseId={e.id} kind="scratch" document={ink.document} disabled /></details><span className="answer-label">提交时确认的答案</span><Markdown>{e.student_answer}</Markdown></div> : editor}</main></SplitPanels>
    </dialog>, document.body)}
  </section>;
}
