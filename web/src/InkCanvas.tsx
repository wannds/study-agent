import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { Eraser, PenLine, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import { inkPreferences, paint, paintStroke, type InkPreferences, type Sheet, type Stroke, type Point } from './ink';

const colors = [['墨黑', '#242733'], ['蓝色', '#2563eb'], ['红色', '#dc2626'], ['绿色', '#16803d'], ['紫色', '#7c3aed'], ['橙色', '#c85a0a']];

export default function InkCanvas({ sheet, onChange, disabled = false, label }: { sheet: Sheet; onChange: (sheet: Sheet) => void; disabled?: boolean; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<{ id: number; stroke: Stroke } | null>(null);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [fingerWriting, setFingerWriting] = useState(() => {
    try { return localStorage.getItem('study-finger-writing') !== 'off'; }
    catch { return true; }
  });
  function toggleFingerWriting() {
    const next = !fingerWriting;
    setFingerWriting(next);
    try { localStorage.setItem('study-finger-writing', next ? 'on' : 'off'); }
    catch { /* The choice still applies to this canvas. */ }
  }
  const cursorRing = useRef<HTMLSpanElement>(null);
  const [eraserEnd, setEraserEnd] = useState(false);
  const [preferences, setPreferences] = useState(() => inkPreferences(label));
  const [preferencesError, setPreferencesError] = useState('');
  const penCursor = useMemo(() => {
    const shape = 'M4 27l2-8L22 3a3 3 0 0 1 4 4L10 23z';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><path d="${shape}" fill="white" stroke="white" stroke-width="4" stroke-linejoin="round"/><path d="${shape}" fill="white" stroke="${preferences.color}" stroke-width="1.7" stroke-linejoin="round"/><path d="M6 19l4 4M20 5l4 4M4 27l3-1" fill="none" stroke="${preferences.color}" stroke-width="1.7"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 4 27, default`;
  }, [preferences.color]);
  function showCursor(e: PointerEvent<HTMLCanvasElement>, usedTool = active.current?.stroke.tool || tool) {
    const ring = cursorRing.current; if (!ring) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    const visible = !disabled && e.pointerType !== 'touch' && usedTool === 'eraser' && x >= 0 && y >= 0 && x <= r.width && y <= r.height;
    ring.style.display = visible ? 'block' : 'none';
    if (visible) { ring.style.left = `${x / r.width * 100}%`; ring.style.top = `${y / r.height * 100}%`; }
  }
  useEffect(() => { if (cursorRing.current) cursorRing.current.style.display = 'none'; }, [tool, disabled]);
  function choose(patch: Partial<InkPreferences>) {
    const next = { ...preferences, ...patch }; setPreferences(next);
    try { localStorage.setItem(`study-ink-tools-${label}`, JSON.stringify(next)); setPreferencesError(''); }
    catch { setPreferencesError('当前样式已生效，但未能记住工具设置。'); }
  }
  const [redo, setRedo] = useState<Stroke[]>([]);
  const [limit, setLimit] = useState('');
  const ref = useRef(sheet); ref.current = sheet;
  useEffect(() => { if (canvas.current) paint(canvas.current, sheet); }, [sheet]);
  useEffect(() => () => { if (active.current) { onChange({ strokes: [...ref.current.strokes, active.current.stroke] }); active.current = null; } }, []);
  const point = (e: { clientX: number; clientY: number; pressure: number; pointerType: string }): Point => {
    const r = canvas.current!.getBoundingClientRect();
    return [Math.round(Math.max(0, Math.min(1200, (e.clientX - r.left) / r.width * 1200)) * 10) / 10, Math.round(Math.max(0, Math.min(900, (e.clientY - r.top) / r.height * 900)) * 10) / 10, e.pointerType === 'pen' ? Math.round((e.pressure || .5) * 100) / 100 : .5];
  };
  function finish(e: PointerEvent<HTMLCanvasElement>) {
    if (active.current?.id !== e.pointerId) return;
    const stroke = active.current.stroke; active.current = null; setEraserEnd(false); showCursor(e, tool);
    onChange({ strokes: [...ref.current.strokes, stroke] }); setRedo([]);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }
  return <div className="ink-board">
    <div className="ink-tools" role="toolbar" aria-label={`${label}工具`}>
      <button disabled={disabled} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}><PenLine size={16} />笔</button>
      <button disabled={disabled} aria-pressed={tool === 'eraser'} onClick={() => setTool('eraser')}><Eraser size={16} />橡皮</button>
      <button disabled={disabled} aria-pressed={fingerWriting} onClick={toggleFingerWriting}>手指书写</button>
      <button disabled={disabled || !sheet.strokes.length} onClick={() => { setRedo([...redo, sheet.strokes.at(-1)!]); onChange({ strokes: sheet.strokes.slice(0, -1) }); }}><RotateCcw size={16} />撤销</button>
      <button disabled={disabled || !redo.length} onClick={() => { onChange({ strokes: [...sheet.strokes, redo.at(-1)!] }); setRedo(redo.slice(0, -1)); }}><RotateCw size={16} />重做</button>
      <button disabled={disabled || !sheet.strokes.length} onClick={() => { if (window.confirm(`清空${label}？此操作无法撤销。`)) { onChange({ strokes: [] }); setRedo([]); } }}><Trash2 size={16} />清空</button>
    </div>
    <div className="ink-style-controls" role="group" aria-label={`${label}样式`}>
      {tool === 'pen' ? <>
        <div className="ink-colors" role="group" aria-label="笔颜色">
          <span>颜色</span>{colors.map(([name, color]) => <button key={color} type="button" disabled={disabled} aria-label={`笔颜色：${name}`} title={name} aria-pressed={preferences.color.toLowerCase() === color} style={{ backgroundColor: color }} onClick={() => choose({ color })} />)}
          <label className="ink-custom-color" title="自定义笔颜色">自定义<input aria-label={`${label}自定义笔颜色`} type="color" value={preferences.color} disabled={disabled} onChange={e => choose({ color: e.target.value })} /></label>
        </div>
        <label className="ink-width-control"><span>粗细</span><input type="range" aria-label={`${label}笔粗细`} min={1} max={20} step={1} value={preferences.penWidth} disabled={disabled} onChange={e => choose({ penWidth: Number(e.target.value) })} /><output>{preferences.penWidth} px</output><span className="ink-pen-preview" aria-hidden="true" style={{ height: preferences.penWidth, backgroundColor: preferences.color }} /></label>
      </> : <label className="ink-width-control"><span>橡皮大小</span><input type="range" aria-label={`${label}橡皮大小`} min={8} max={100} step={1} value={preferences.eraserWidth} disabled={disabled} onChange={e => choose({ eraserWidth: Number(e.target.value) })} /><output>{preferences.eraserWidth} px</output></label>}
      {preferencesError && <span className="ink-hint" role="status">{preferencesError}</span>}
    </div>
    <div className="ink-paper"><canvas ref={canvas} width={1200} height={900} aria-label={label} style={{ cursor: disabled ? 'default' : tool === 'eraser' || eraserEnd ? 'none' : penCursor }}
      onPointerEnter={e => showCursor(e)}
      onPointerLeave={() => { if (cursorRing.current) cursorRing.current.style.display = 'none'; }}
      onContextMenu={e => e.preventDefault()}
      onPointerDown={e => {
        if (disabled || active.current || (e.pointerType === 'touch' && (!fingerWriting || !e.isPrimary)) || (e.button !== 0 && e.button !== 5)) return;
        if (sheet.strokes.length >= 1900 || sheet.strokes.reduce((n, s) => n + s.points.length, 0) > 28000) { setLimit('这一页的笔迹已较多，请新增一页继续书写。'); return; }
        setLimit(''); e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId);
        const usedTool = e.button === 5 ? 'eraser' : tool; setEraserEnd(e.button === 5); showCursor(e, usedTool);
        active.current = { id: e.pointerId, stroke: { tool: usedTool, points: [point(e)], width: usedTool === 'eraser' ? preferences.eraserWidth : preferences.penWidth, ...(usedTool === 'pen' ? { color: preferences.color } : {}) } };
        paintStroke(e.currentTarget.getContext('2d')!, active.current.stroke);
      }}
      onPointerMove={e => {
        showCursor(e);
        if (active.current?.id !== e.pointerId) return;
        const from = active.current.stroke.points.length;
        const events = e.nativeEvent.getCoalescedEvents?.() || [e.nativeEvent];
        for (const ev of events.length ? events : [e.nativeEvent]) {
          const p = point(ev), last = active.current.stroke.points.at(-1)!;
          if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1 && active.current.stroke.points.length < 2000) active.current.stroke.points.push(p);
        }
        if (active.current.stroke.points.length >= 2000) setLimit('这一笔已达到长度上限，请抬笔后继续书写。');
        paintStroke(e.currentTarget.getContext('2d')!, active.current.stroke, from);
      }} onPointerUp={finish} onPointerCancel={e => { finish(e); if (cursorRing.current) cursorRing.current.style.display = 'none'; }} onLostPointerCapture={finish} />
      <span ref={cursorRing} className="ink-eraser-cursor" aria-hidden="true" style={{ width: `${preferences.eraserWidth / 1200 * 100}%` }} />
      {!sheet.strokes.length && <span className="ink-placeholder">{label === '草稿纸' ? '在这里演算，不参与批改' : label === '手写笔记' ? '写下笔记、公式与示意图，落笔后自动保存' : '用触控笔或鼠标写下答案与过程'}</span>}
    </div>
    <p className="ink-hint">{limit || (fingerWriting ? '可用一根手指、触控笔或鼠标书写。用笔时可关闭「手指书写」以防手掌误触。' : '触控笔和鼠标可书写。点「手指书写」可启用触屏输入。')}</p>
  </div>;
}
