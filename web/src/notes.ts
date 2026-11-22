import { imageOf, request, sheetsOf, type InkDocument, type Sheet } from './ink';
export const MAX_NOTE_PAGES = 50;
export type Note = { id: string; title: string; course_id: string | null; text: string; document: InkDocument; revision: number; archived: boolean; created_at: number; updated_at: number };
export type NoteSummary = Pick<Note, 'id' | 'title' | 'course_id' | 'revision' | 'archived' | 'updated_at'> & { course_title: string | null; preview: string; page_count: number };
export type NoteList = { items: NoteSummary[]; total: number };
type State = { note: Note | null; mode: 'text' | 'ink'; loading: boolean; saving: boolean; dirty: boolean; error: string; conflict: boolean; localError: boolean };

class NoteStore {
  value: State = { note: null, mode: 'text', loading: true, saving: false, dirty: false, error: '', conflict: false, localError: false };
  listeners = new Set<() => void>();
  timer?: ReturnType<typeof setTimeout>;
  flight?: Promise<void>;
  generation = 0;
  constructor(readonly id: string, initial?: Note) { void this.load(initial); }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.value;
  emit(patch: Partial<State>) { this.value = { ...this.value, ...patch }; this.listeners.forEach(f => f()); }
  key() { return `study-note-v1-${this.id}`; }
  cache() {
    try {
      localStorage.setItem(this.key(), JSON.stringify({ revision: this.value.note?.revision, note: this.value.dirty ? this.value.note : undefined, dirty: this.value.dirty, mode: this.value.mode }));
      if (this.value.localError) this.emit({ localError: false });
    } catch { this.emit({ localError: true }); }
  }
  async load(initial?: Note) {
    let cached: { note?: Note; dirty?: boolean; revision?: number; mode?: 'text' | 'ink' } | undefined;
    try {
      const raw = localStorage.getItem(this.key());
      if (raw) { const v = JSON.parse(raw); if (Number.isInteger(v.revision) && (!v.dirty || (v.note?.id === this.id && v.note?.document?.answer?.strokes && v.note?.document?.scratch?.strokes))) cached = v; }
    } catch { /* The SQLite copy remains authoritative. */ }
    try {
      const note = initial || await request<Note>(`/notes/${this.id}`);
      if (cached?.dirty && cached.note) {
        const conflict = cached.revision !== note.revision;
        this.emit({ note: cached.note, mode: cached.mode === 'ink' ? 'ink' : 'text', dirty: true, loading: false, conflict, error: conflict ? '发现另一窗口保存的版本，请先导出本窗口草稿，再重新载入。' : '' });
        if (!conflict) this.schedule();
      } else this.emit({ note, mode: cached?.mode === 'ink' ? 'ink' : 'text', loading: false, dirty: false, conflict: false, error: '' });
    } catch (e) { this.emit({ note: cached?.note || null, dirty: !!cached?.dirty, loading: false, error: (e as Error).message }); }
  }
  mode(mode: 'text' | 'ink') { this.emit({ mode }); this.cache(); }
  patch(patch: Partial<Pick<Note, 'title' | 'course_id' | 'text' | 'document'>>) {
    const note = this.value.note;
    if (!note || note.archived || this.value.loading || this.value.conflict) return;
    this.commit({ ...note, ...patch });
  }
  private commit(note: Note) {
    this.generation++; this.emit({ note, dirty: true, error: '' }); this.cache(); this.schedule();
  }
  changeSheet(sheet: Sheet, index: number) {
    const note = this.value.note; if (!note) return;
    const document = { ...note.document };
    if (index < 0 || index >= sheetsOf(document, 'answer').length) return;
    if (index === 0) { document.answer = sheet; document.image = imageOf(sheet); }
    else { document.answer_extra = [...(document.answer_extra || [])]; document.answer_extra[index - 1] = { sheet, image: imageOf(sheet) }; }
    this.patch({ document });
  }
  addPage(): number | null {
    const note = this.value.note; if (!note || note.archived || this.value.conflict || this.value.loading) return null;
    const count = sheetsOf(note.document, 'answer').length; if (count >= MAX_NOTE_PAGES) return null;
    this.patch({ document: { ...note.document, answer_extra: [...(note.document.answer_extra || []), { sheet: { strokes: [] }, image: '' }] } });
    return count;
  }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { void this.flush().catch(() => {}); }, 650); }
  flush = async (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.flight) { await this.flight; return this.flush(); }
    if (this.value.loading || this.value.conflict || !this.value.note) throw new Error(this.value.error || '笔记尚未载入');
    if (!this.value.dirty) return;
    const note = this.value.note, generation = this.generation;
    this.emit({ saving: true, error: '' });
    this.flight = (async () => {
      try {
        const saved = await request<{ revision: number; updated_at: number }>(`/notes/${this.id}`, 'PUT', note);
        this.emit({ note: { ...this.value.note!, revision: saved.revision, updated_at: saved.updated_at }, dirty: this.generation !== generation, saving: false });
        this.cache(); window.dispatchEvent(new CustomEvent('study-notes-changed', { detail: this.id }));
      } catch (e) {
        this.emit({ saving: false, error: (e as Error).message, conflict: (e as Error & { status?: number }).status === 409 }); this.cache(); throw e;
      }
    })();
    try { await this.flight; } finally { this.flight = undefined; }
    if (this.value.dirty) await this.flush();
  };
  async archive(archived: boolean) {
    await this.flush();
    if (!this.value.note) return;
    this.commit({ ...this.value.note, archived });
    await this.flush();
  }
  exportBackup() {
    const blob = new Blob([JSON.stringify(this.value.note, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `note-${this.id}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async reload() {
    if (this.value.dirty && !window.confirm('重新载入将替换本窗口的未保存内容，请先导出草稿备份。继续吗？')) return;
    clearTimeout(this.timer); if (this.flight) { try { await this.flight; } catch { /* Explicit reload was requested. */ } }
    try { localStorage.removeItem(this.key()); } catch { this.emit({ error: '本机临时存储暂时不可用，请先导出备份。' }); return; }
    this.emit({ loading: true, dirty: false, conflict: false, error: '' }); await this.load();
  }
}
const stores = new Map<string, NoteStore>();
export function noteStore(id: string, initial?: Note) { let value = stores.get(id); if (!value) { value = new NoteStore(id, initial); stores.set(id, value); } return value; }
window.addEventListener('beforeunload', event => {
  if ([...stores.values()].some(s => s.value.dirty || s.value.saving)) { event.preventDefault(); event.returnValue = ''; }
});
