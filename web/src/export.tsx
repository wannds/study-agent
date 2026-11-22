import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { localImage } from './media';

export type ExportLesson = { title: string; content: string; source_label: string; reading_status: string };
export type ExportCourse = { title: string; lessons: ExportLesson[] };
export type ExportOptions = { format: 'html' | 'md'; images: boolean; toc: boolean; progress: boolean };
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));

async function inlineImages(lessons: ExportLesson[]) {
  const paths = new Set<string>();
  lessons.forEach(l => { for (const match of l.content.matchAll(/!\[[^\]]*\]\((\/api\/video\/assets\/[^\s)]+)\)/g)) if (localImage(match[1])) paths.add(match[1]); });
  const images = new Map<string, string>(); let total = 0;
  for (const path of paths) {
    const response = await fetch(path); if (!response.ok) throw new Error('读取截图失败，请确认本地后台仍在运行');
    const blob = await response.blob(); total += blob.size;
    if (total > 64 * 1024 * 1024) throw new Error('截图超过 64 MB，请关闭“嵌入截图”或分课程导出');
    if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) throw new Error('截图格式不支持离线导出');
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('截图读取失败')); reader.readAsDataURL(blob); });
    images.set(path, data);
  }
  return images;
}

export function renderHtml(course: ExportCourse, options: ExportOptions, images: Map<string, string>) {
  const body = renderToStaticMarkup(<><header><p className="eyebrow">知行 · 学习笔记</p><h1>{course.title}</h1><p className="meta">{course.lessons.length} 个章节 · 离线 HTML · 可使用浏览器打印为 PDF</p></header><div className={options.toc ? 'layout' : 'layout single'}>{options.toc && <nav aria-label="章节目录"><h2>目录</h2>{course.lessons.map((l, i) => <a key={i} href={`#lesson-${i + 1}`}>{String(i + 1).padStart(2, '0')}　{l.title}</a>)}</nav>}<main>{course.lessons.map((l, i) => <section id={`lesson-${i + 1}`} key={i}><div className="meta">{l.source_label}{options.progress ? ` · ${l.reading_status === 'read' ? '已读' : '未完成阅读'}` : ''}</div><h2>{l.title}</h2><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a>, img: ({ src, alt }) => images.has(src || '') ? <figure><img loading="lazy" src={images.get(src || '')} alt={alt || '课程截图'} /><figcaption>{alt}</figcaption></figure> : <span className="omitted">[截图未嵌入：{alt || '图片'}]</span> }}>{l.content}</ReactMarkdown></section>)}</main></div><footer>由知行 Study Agent 导出 · 原始资料与 AI 解释应分别核对</footer></>);
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(course.title)} · 学习笔记</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f7f7fb;color:#292733;font:16px/1.85 'Microsoft YaHei',system-ui,sans-serif}header{padding:48px max(24px,calc((100% - 1180px)/2));background:white;border-bottom:1px solid #e4e0ee}h1{font-size:32px;line-height:1.4;margin:10px 0}h2{font-size:24px}h3{font-size:20px}.eyebrow{letter-spacing:3px;color:#6c55b6;font-size:12px}.meta,figcaption{font-size:12px;color:#767184}.layout{max-width:1180px;margin:30px auto;display:grid;grid-template-columns:230px minmax(0,1fr);gap:28px;padding:0 24px}.layout.single{display:block;max-width:920px}nav{align-self:start;position:sticky;top:20px;max-height:90vh;overflow:auto;background:white;border:1px solid #e4e0ee;border-radius:12px;padding:20px}nav h2{font-size:15px;margin-top:0}nav a{display:block;font-size:13px;text-decoration:none;padding:8px 0;border-bottom:1px solid #eee9f5}a{color:#674bb4}section{padding:32px;margin-bottom:24px;background:white;border:1px solid #e4e0ee;border-radius:12px;scroll-margin-top:20px;overflow-wrap:anywhere}section>h2{margin:10px 0 24px}img{max-width:100%;height:auto;border-radius:8px}figure{margin:24px 0}figcaption{text-align:center}pre{padding:18px;background:#f4f2f8;overflow:auto;border-radius:8px}code{font-family:Consolas,monospace;font-size:.9em}table{border-collapse:collapse;display:block;overflow:auto;width:100%}th,td{border:1px solid #dfdbe8;padding:10px 14px;text-align:left}th{background:#f4f1f9}blockquote{border-left:3px solid #a18acb;margin:20px 0;padding:1px 18px;background:#f8f5fc}.omitted{color:#888;font-size:12px}footer{text-align:center;color:#888;font-size:12px;padding:30px}@media(max-width:760px){.layout{display:block}nav{position:static;max-height:none;margin-bottom:20px}section{padding:22px}header{padding:30px 24px}}@media print{body{background:white;font-size:11pt}header{padding:0 0 20px}.layout,.layout.single{display:block;margin:0;padding:0;max-width:none}nav{display:none}section{border:none;padding:16px 0;break-inside:auto}img,pre,table{break-inside:avoid}footer{display:none}}
</style></head><body>${body}</body></html>`;
}

export async function exportCourseFile(course: ExportCourse, options: ExportOptions) {
  const data = options.format === 'html' ? renderHtml(course, options, options.images ? await inlineImages(course.lessons) : new Map()) : `# ${course.title}\n\n` + course.lessons.map(l => `## ${l.title}\n\n${l.source_label}\n\n${l.content.replace(/!\[([^\]]*)\]\(\/api\/video\/assets\/[^)]+\)/g, '[截图：$1，请使用 HTML 图文导出]')}\n\n---\n`).join('\n');
  const filename = (course.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 90) || '课程笔记') + '.' + options.format;
  const url = URL.createObjectURL(new Blob([data], { type: options.format === 'html' ? 'text/html;charset=utf-8' : 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); return filename;
}
