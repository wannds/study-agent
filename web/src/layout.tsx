import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';

type Axis = 'horizontal' | 'vertical';
type Preferences = Record<string, number | string>;
const STORAGE = 'study-layout-v1';
function decode(raw: string | null): Preferences {
  try {
    const v = JSON.parse(raw || '{}');
    if (!v || Array.isArray(v) || typeof v !== 'object') return {};
    const valid: Preferences = {};
    for (const [key, value] of Object.entries(v)) {
      if (/^[a-z.-]{1,60}$/.test(key) && ((typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 5000) || value === 'horizontal' || value === 'vertical')) valid[key] = value;
    }
    return valid;
  } catch { return {}; }
}
let preferences: Preferences = {};
try { preferences = decode(localStorage.getItem(STORAGE)); } catch { /* Defaults still work. */ }
let warning = '';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(fn => fn());
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
function persist() {
  try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); warning = ''; }
  catch { warning = '布局已调整，但未能保存；重启后可能恢复默认。'; }
  notify();
}
function setPreference(key: string, value: number | string, save = true) {
  preferences = { ...preferences, [key]: value }; notify(); if (save) persist();
}
function resetKey(key: string) { const next = { ...preferences }; delete next[key]; preferences = next; persist(); }
export function resetLayouts() { preferences = {}; persist(); }
export function LayoutWarning() {
  const text = useSyncExternalStore(subscribe, () => warning);
  return text ? <div className="layout-warning" role="status">{text}</div> : null;
}
export function useInkDirection(): [Axis, (direction: Axis) => void] {
  const direction = useSyncExternalStore(subscribe, () => preferences['ink.direction']);
  return [direction === 'vertical' ? 'vertical' : 'horizontal', direction => setPreference('ink.direction', direction)];
}
export function resetInkLayout() {
  const next = { ...preferences };
  for (const key of Object.keys(next)) if (key.startsWith('ink.')) delete next[key];
  preferences = next; persist();
}
window.addEventListener('storage', event => { if (event.key === STORAGE || event.key === null) { preferences = decode(event.newValue); notify(); } });

type Props = {
  id: string; label: string; className?: string; children: [ReactNode, ReactNode];
  axis?: Axis; stackBelow?: number; initial: number; verticalInitial?: number;
  minFirst: number; minSecond: number; maxFirst?: number; maxSecond?: number;
  verticalMinFirst?: number; verticalMinSecond?: number; anchor?: 'first' | 'second';
};
const GAP = 8;

export default function SplitPanels({ id, label, className = '', children, axis = 'horizontal', stackBelow = 0, initial, verticalInitial = 200, minFirst, minSecond, maxFirst = Infinity, maxSecond = Infinity, verticalMinFirst = 140, verticalMinSecond = 220, anchor = 'first' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const effective: Axis = axis === 'horizontal' && stackBelow > 0 && bounds.width > 0 && bounds.width < stackBelow ? 'vertical' : axis;
  const key = `${id}.${effective}`;
  const preferred = useSyncExternalStore(subscribe, () => preferences[key]);
  const horizontal = effective === 'horizontal';
  const minimumFirst = horizontal ? minFirst : verticalMinFirst;
  const minimumSecond = horizontal ? minSecond : verticalMinSecond;
  // A short window gets a scrollable stack with some adjustment room rather than a frozen divider.
  const extent = Math.max(horizontal ? bounds.width : bounds.height, minimumFirst + minimumSecond + GAP + (horizontal ? 0 : 100));
  const available = extent - GAP;
  const low = anchor === 'first' ? minimumFirst : minimumSecond;
  const high = Math.max(low, Math.min(available - (anchor === 'first' ? minimumSecond : minimumFirst), horizontal ? (anchor === 'first' ? maxFirst : maxSecond) : Infinity));
  const defaultSize = horizontal ? initial : verticalInitial;
  const requested = typeof preferred === 'number' ? preferred : defaultSize;
  const size = Math.max(low, Math.min(high, requested));
  const first = anchor === 'first' ? size : available - size;
  const second = available - first;
  const active = useRef<{ pointer: number; start: number; size: number; key: string; old: number | string | undefined; horizontal: boolean; low: number; high: number; anchor: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const hasSecond = children[1] !== null && children[1] !== undefined && children[1] !== false;
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const measure = () => {
      const width = el.clientWidth, height = el.clientHeight;
      setBounds(old => old.width === width && old.height === height ? old : { width, height });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(el);
    return () => observer.disconnect();
  }, []);
  function finish(cancel = false) {
    const drag = active.current; if (!drag) return;
    active.current = null; setDragging(false);
    if (cancel) {
      if (drag.old === undefined) resetKey(drag.key); else setPreference(drag.key, drag.old);
    } else persist();
    if (handle.current?.hasPointerCapture(drag.pointer)) handle.current.releasePointerCapture(drag.pointer);
  }
  useEffect(() => {
    if (!dragging) return;
    const body = document.body, oldCursor = body.style.cursor, oldSelect = body.style.userSelect;
    body.style.cursor = horizontal ? 'col-resize' : 'row-resize'; body.style.userSelect = 'none';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); } };
    document.addEventListener('keydown', escape, true);
    return () => { body.style.cursor = oldCursor; body.style.userSelect = oldSelect; document.removeEventListener('keydown', escape, true); };
  }, [dragging, horizontal]);
  useEffect(() => { if (active.current) finish(); }, [effective]);
  useEffect(() => () => { if (active.current) { active.current = null; persist(); } }, []);
  const style: CSSProperties = horizontal
    ? { gridTemplateColumns: hasSecond ? `${first}px ${GAP}px ${second}px` : 'minmax(0, 1fr)', gridTemplateRows: 'minmax(0, 1fr)' }
    : { gridTemplateRows: hasSecond ? `${first}px ${GAP}px ${second}px` : 'minmax(0, 1fr)', gridTemplateColumns: 'minmax(0, 1fr)' };
  return <div ref={ref} data-layout={id} data-axis={effective} data-first-size={Math.round(first)} className={`split-panels ${className} ${id === 'nav' && first < 180 ? 'compact-navigation' : ''}`} style={style}>
    {children[0]}
    {hasSecond && <div ref={handle} className={`resize-handle ${dragging ? 'dragging' : ''}`} role="separator" tabIndex={0} aria-label={label} aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-valuemin={Math.round(low)} aria-valuemax={Math.round(high)} aria-valuenow={Math.round(size)} aria-valuetext={`${Math.round(size)} 像素`} title="拖动调整大小；双击恢复该分栏；方向键微调，Esc 取消拖动"
      onDoubleClick={() => resetKey(key)}
      onPointerDown={event => {
        if (event.button !== 0 || active.current) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        active.current = { pointer: event.pointerId, start: horizontal ? event.clientX : event.clientY, size, key, old: preferred, horizontal, low, high, anchor }; setDragging(true);
      }}
      onPointerMove={event => {
        const drag = active.current; if (!drag || event.pointerId !== drag.pointer) return;
        const delta = (drag.horizontal ? event.clientX : event.clientY) - drag.start;
        setPreference(drag.key, Math.max(drag.low, Math.min(drag.high, drag.size + delta * (drag.anchor === 'first' ? 1 : -1))), false);
      }}
      onPointerUp={() => finish()} onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish()}
      onKeyDown={event => {
        const minus = horizontal ? 'ArrowLeft' : 'ArrowUp', plus = horizontal ? 'ArrowRight' : 'ArrowDown';
        if (![minus, plus, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const delta = (event.key === minus ? -1 : 1) * (anchor === 'first' ? 1 : -1) * (event.shiftKey ? 40 : 10);
        setPreference(key, event.key === 'Home' ? low : event.key === 'End' ? high : Math.max(low, Math.min(high, size + delta)));
      }}><span /></div>}
    {children[1]}
  </div>;
}
