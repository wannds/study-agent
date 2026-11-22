import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import InkCanvas from './InkCanvas';
import { MAX_INK_PAGES, paint, sheetsOf, type InkDocument, type InkKind, type Sheet } from './ink';

function Thumbnail({ sheet }: { sheet: Sheet }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current; if (!canvas) return;
    canvas.getContext('2d')!.setTransform(.2, 0, 0, .2, 0, 0);
    paint(canvas, sheet);
  }, [sheet]);
  return <canvas ref={ref} width={240} height={180} aria-hidden="true" />;
}

export default function InkNotebook({ document, kind, exerciseId, disabled = false, onChange, onAdd, paperLabel, canvasLabel, scopeLabel = '每题', maxPages = MAX_INK_PAGES }: {
  document: InkDocument; kind: InkKind; exerciseId: string; disabled?: boolean; paperLabel?: string; canvasLabel?: string; scopeLabel?: string; maxPages?: number;
  onChange?: (sheet: Sheet, index: number) => void; onAdd?: () => number | null;
}) {
  const label = paperLabel || (kind === 'answer' ? '答题纸' : '草稿纸');
  const storage = `study-ink-page-${exerciseId}-${kind}`;
  const [selected, setSelected] = useState(() => {
    try { const n = Number(localStorage.getItem(storage)); return Number.isInteger(n) && n >= 0 && n < maxPages ? n : 0; } catch { return 0; }
  });
  const pages = sheetsOf(document, kind), index = Math.min(selected, pages.length - 1);
  const strip = useRef<HTMLDivElement>(null);
  function select(n: number) {
    setSelected(n);
    try { localStorage.setItem(storage, String(n)); } catch { /* Paper still saves to the learning database. */ }
  }
  useEffect(() => {
    const el = strip.current, button = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && button) {
      if (button.offsetLeft < el.scrollLeft) el.scrollLeft = button.offsetLeft;
      else if (button.offsetLeft + button.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = button.offsetLeft + button.offsetWidth - el.clientWidth;
    }
  }, [index]);
  return <section className="ink-notebook" aria-label={`${label}分页`}>
    <div className="ink-page-heading"><strong>{label}</strong><span>第 {index + 1} / {pages.length} 页</span>
      {!disabled && <button className="button secondary small" disabled={!onAdd || pages.length >= maxPages} onClick={() => { const next = onAdd?.(); if (next !== null && next !== undefined) select(next); }}><Plus size={14} />新增{label}</button>}
    </div>
    <div className="ink-page-navigation">
      <button className="icon-button" aria-label={`${label}上一页`} disabled={index === 0} onClick={() => select(index - 1)}><ChevronLeft size={18} /></button>
      <div ref={strip} className="ink-page-thumbnails" aria-label={`${label}缩略图`}>
        {pages.map((sheet, n) => <button key={n} type="button" className="ink-page-thumbnail" aria-label={`${label}第 ${n + 1} 页`} aria-current={n === index ? 'page' : undefined} onClick={() => select(n)}><Thumbnail sheet={sheet} /><span>{n + 1}{sheet.strokes.length ? '' : ' · 空白'}</span></button>)}
      </div>
      <button className="icon-button" aria-label={`${label}下一页`} disabled={index === pages.length - 1} onClick={() => select(index + 1)}><ChevronRight size={18} /></button>
    </div>
    <InkCanvas key={`${kind}-${index}`} label={canvasLabel || (kind === 'answer' ? '正式答案' : '草稿纸')} sheet={pages[index]} disabled={disabled} onChange={sheet => onChange?.(sheet, index)} />
    <p className="ink-hint">{disabled ? '当前为只读状态，可通过缩略图或翻页按钮回看。' : `${scopeLabel}${label}最多 ${maxPages} 页，切页后自动保存；清空和撤销仅影响当前页。`}</p>
  </section>;
}
