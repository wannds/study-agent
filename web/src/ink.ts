export type Point = [number, number, number];
export type Stroke = { tool: 'pen' | 'eraser'; points: Point[]; color?: string; width?: number };
export type InkPreferences = { color: string; penWidth: number; eraserWidth: number };
export function inkPreferences(label: string): InkPreferences {
  const defaults = { color: '#242733', penWidth: 4, eraserWidth: 30 };
  try {
    const v = JSON.parse(localStorage.getItem(`study-ink-tools-${label}`) || '{}');
    return {
      color: typeof v.color === 'string' && /^#[0-9a-f]{6}$/i.test(v.color) ? v.color : defaults.color,
      penWidth: Number.isInteger(v.penWidth) && v.penWidth >= 1 && v.penWidth <= 20 ? v.penWidth : defaults.penWidth,
      eraserWidth: Number.isInteger(v.eraserWidth) && v.eraserWidth >= 8 && v.eraserWidth <= 100 ? v.eraserWidth : defaults.eraserWidth,
    };
  } catch { return defaults; }
}
export type Sheet = { strokes: Stroke[] };
export const MAX_INK_PAGES = 20;
export type InkKind = 'answer' | 'scratch';
export type InkDocument = { answer: Sheet; scratch: Sheet; image: string; answer_extra?: { sheet: Sheet; image: string }[]; scratch_extra?: Sheet[] };
export function sheetsOf(document: InkDocument, kind: InkKind): Sheet[] {
  return kind === 'answer' ? [document.answer, ...(document.answer_extra || []).map(p => p.sheet)] : [document.scratch, ...(document.scratch_extra || [])];
}
export function hasAnswerInk(document: InkDocument) { return sheetsOf(document, 'answer').some(p => p.strokes.length > 0); }
type Remote = { revision: number; document: InkDocument; recognized_text: string; recognized_revision: number };
type Cached = { revision: number; document: InkDocument; dirty: boolean; transcript: string; mode: 'text' | 'ink' };
type Snapshot = Cached & { loading: boolean; saving: boolean; error: string; conflict: boolean; localError: boolean };

export async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`/api${path}`, { method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const v = r.headers.get('content-type')?.includes('json') ? await r.json() : { error: await r.text() };
  if (!r.ok) { const error = new Error(v.error || `请求失败（${r.status}）`) as Error & { status?: number }; error.status = r.status; throw error; }
  return v as T;
}

export function paintStroke(c: CanvasRenderingContext2D, s: Stroke, from = 0) {
  c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = s.color || '#242733'; c.fillStyle = s.color || '#242733';
    c.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
    for (let i = from; i < s.points.length; i++) {
      const p = s.points[i], before = s.points[Math.max(0, i - 1)];
      const width = s.tool === 'eraser' ? (s.width ?? 30) : (s.width ?? 4) * (.5 + p[2]);
      c.lineWidth = width;
      if (i === 0) { c.beginPath(); c.arc(p[0], p[1], width / 2, 0, Math.PI * 2); c.fill(); }
      else { c.beginPath(); c.moveTo(before[0], before[1]); c.lineTo(p[0], p[1]); c.stroke(); }
    }
  c.globalCompositeOperation = 'source-over';
}
export function paint(canvas: HTMLCanvasElement, sheet: Sheet) {
  const c = canvas.getContext('2d'); if (!c) return;
  c.clearRect(0, 0, 1200, 900);
  for (const s of sheet.strokes) paintStroke(c, s);
}
export function imageOf(sheet: Sheet): string {
  if (!sheet.strokes.length) return '';
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 900; paint(canvas, sheet);
  const c = canvas.getContext('2d')!;
  c.globalCompositeOperation = 'destination-over'; c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 900);
  return canvas.toDataURL('image/png');
}

// One writer per exercise survives navigation; version checks protect other windows.
class InkStore {
  value: Snapshot = { revision: 0, document: { answer: { strokes: [] }, scratch: { strokes: [] }, image: '' }, dirty: false, transcript: '', mode: 'text', loading: true, saving: false, error: '', conflict: false, localError: false };
  listeners = new Set<() => void>();
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  generation = 0;
  recovery?: string;
  constructor(readonly id: string) { void this.load(); }
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; };
  snapshot = () => this.value;
  emit(patch: Partial<Snapshot>) { this.value = { ...this.value, ...patch }; this.listeners.forEach(f => f()); }
  key() { return `study-ink-v1-${this.id}`; }
  cache() {
    // Keep large strokes/images only while unsynced. The durable copy lives in SQLite.
    try { localStorage.setItem(this.key(), JSON.stringify({ revision: this.value.revision, document: this.value.dirty ? this.value.document : undefined, dirty: this.value.dirty, transcript: this.value.transcript, mode: this.value.mode })); if(this.value.localError) this.emit({ localError: false }); }
    catch { this.emit({ localError: true }); }
  }
  async load() {
    let cached: Cached | undefined;
    try { const raw = localStorage.getItem(this.key()); if (raw) { const v = JSON.parse(raw); if (Number.isInteger(v.revision) && (!v.dirty || (v.document?.answer?.strokes && v.document?.scratch?.strokes))) cached = { ...v, document: v.document || this.value.document }; } } catch { /* Server copy remains authoritative. */ }
    try {
      const r = await request<Remote>(`/exercises/${this.id}/ink`);
      if (cached?.dirty && cached.revision !== r.revision) {
        this.recovery = JSON.stringify(cached);
        this.emit({ ...cached, loading: false, conflict: true, error: '发现另一窗口保存的版本。请先导出本窗口草稿，再重新载入服务器原稿。' }); return;
      }
      if (cached?.dirty) { this.emit({ ...cached, loading: false }); this.schedule(); }
      else this.emit({ revision: r.revision, document: r.document, transcript: cached?.revision === r.revision ? cached.transcript : (r.recognized_revision === r.revision ? r.recognized_text : ''), mode: cached?.mode || (hasAnswerInk(r.document) ? 'ink' : 'text'), loading: false, error: '' });
    } catch (e) { this.emit({ ...(cached || {}), loading: false, error: (e as Error).message, conflict: true }); }
  }
  mode(mode: 'text' | 'ink') { this.emit({ mode }); this.cache(); }
  transcript(transcript: string) { this.emit({ transcript }); this.cache(); }
  change(kind: InkKind, sheet: Sheet, index = 0) {
    if (this.value.loading || this.value.conflict || index < 0 || index >= sheetsOf(this.value.document, kind).length) return;
    const document = { ...this.value.document };
    if (index === 0) {
      document[kind] = sheet;
      if (kind === 'answer') document.image = imageOf(sheet);
    } else if (kind === 'answer') {
      document.answer_extra = [...(document.answer_extra || [])];
      document.answer_extra[index - 1] = { sheet, image: imageOf(sheet) };
    } else {
      document.scratch_extra = [...(document.scratch_extra || [])];
      document.scratch_extra[index - 1] = sheet;
    }
    this.commit(document, kind === 'answer');
  }
  addPage(kind: InkKind): number | null {
    const count = sheetsOf(this.value.document, kind).length;
    if (this.value.loading || this.value.conflict || count >= MAX_INK_PAGES) return null;
    const document = { ...this.value.document };
    if (kind === 'answer') document.answer_extra = [...(document.answer_extra || []), { sheet: { strokes: [] }, image: '' }];
    else document.scratch_extra = [...(document.scratch_extra || []), { strokes: [] }];
    this.commit(document, false);
    return count;
  }
  private commit(document: InkDocument, answerChanged: boolean) {
    this.generation++;
    this.emit({ document, dirty: true, transcript: answerChanged ? '' : this.value.transcript, error: '' }); this.cache(); this.schedule();
  }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 650); }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.flight) { await this.flight; return this.flush(); }
    if (this.value.loading || this.value.conflict) throw new Error(this.value.error || '原稿尚未载入');
    if (!this.value.dirty) return;
    const document = this.value.document, revision = this.value.revision, generation = this.generation;
    this.emit({ saving: true, error: '' });
    this.flight = (async () => {
      try {
        const r = await request<{ revision: number }>(`/exercises/${this.id}/ink`, 'PUT', { revision, document });
        this.emit({ revision: r.revision, dirty: generation !== this.generation, saving: false }); this.cache();
      } catch (e) {
        this.emit({ saving: false, error: (e as Error).message, conflict: (e as Error & { status?: number }).status === 409 }); this.cache(); throw e;
      }
    })();
    try { await this.flight; } finally { this.flight = undefined; }
    if (this.value.dirty) await this.flush();
  };
  recoverDownload() {
    const blob = new Blob([this.recovery || JSON.stringify(this.value)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `handwriting-${this.id}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async reload() {
    if (this.value.dirty && !window.confirm('重新载入会替换本窗口的未保存笔迹。请先导出草稿备份。继续吗？')) return;
    localStorage.removeItem(this.key()); this.emit({ loading: true, conflict: false, dirty: false, error: '' }); await this.load();
  }
}
const stores = new Map<string, InkStore>();
export function inkStore(id: string) { let s = stores.get(id); if (!s) { s = new InkStore(id); stores.set(id, s); } return s; }
window.addEventListener('beforeunload', e => {
  if ([...stores.values()].some(s => s.value.dirty || s.value.saving)) { e.preventDefault(); e.returnValue = ''; }
});
