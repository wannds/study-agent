import { useEffect, useRef, useState } from 'react';
import { Link2, MonitorPlay, Youtube, RefreshCw, LogOut, QrCode, LoaderCircle, AlertCircle, ExternalLink, X, Settings2 } from 'lucide-react';

type Account = { state: string; name?: string; browser?: string; profile?: string; message?: string };
type Snapshot = { bilibili: Account; youtube: Account; engine_ready: boolean; shared: boolean };
type BrowserOption = { id: string; name: string; profiles: { id: string; name: string }[] };
type QR = { id: string; modules: boolean[][]; state: string; remaining: number; deadline: number; name?: string };
const labels: Record<string, string> = { disconnected: '未连接', saved: '已保存 · 待验证', configured: '已连接浏览器 · 待验证', connected: '已验证', expired: '登录已过期', error: '需要处理' };
async function request<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`/api/accounts${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  const v = await r.json(); if (!r.ok) throw new Error(v.error || '账号请求失败，请重试'); return v;
}
function Code({ modules }: { modules: boolean[][] }) {
  const size = modules.length + 8;
  const path = modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : [])).join('');
  return <svg className="account-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Bilibili 登录二维码" shapeRendering="crispEdges"><rect width={size} height={size} fill="white" /><path d={path} fill="black" /></svg>;
}

export default function AccountsPage({ onModelSettings }: { onModelSettings: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [qr, setQr] = useState<QR | null>(null); const qrRef = useRef(qr); qrRef.current = qr;
  const [remaining, setRemaining] = useState(0);
  const [choices, setChoices] = useState<BrowserOption[] | null>(null); const [browser, setBrowser] = useState(''); const [profile, setProfile] = useState('');
  const [disconnecting, setDisconnecting] = useState<'bilibili' | 'youtube' | null>(null);
  async function refresh() { setSnapshot(await request<Snapshot>('')); }
  useEffect(() => { let alive = true; request<Snapshot>('').then(v => { if (alive) setSnapshot(v); }).catch(e => { if (alive) setError(e.message); }); return () => { alive = false; const current = qrRef.current; if (current && ['waiting', 'confirm'].includes(current.state)) request(`/bilibili/qr/${current.id}/cancel`, {}).catch(() => {}); }; }, []);
  useEffect(() => {
    if (!qr || !['waiting', 'confirm'].includes(qr.state)) return;
    let stopped = false; let timer: ReturnType<typeof setTimeout>;
    const id = qr.id;
    async function poll() {
      try {
        const result = await request<{ state: string; remaining?: number; name?: string }>(`/bilibili/qr/${id}/poll`, {});
        if (stopped) return;
        setQr(current => current?.id === id ? { ...current, ...result, deadline: result.remaining === undefined ? current.deadline : Date.now() + result.remaining * 1000 } : current);
        if (result.state === 'connected') { setSnapshot(current => current ? { ...current, bilibili: result } : current); setNotice('Bilibili 已连接，后续视频转换将使用此账号状态。'); }
        else if (['waiting', 'confirm'].includes(result.state)) timer = setTimeout(poll, 2500);
        else if (result.state === 'failed') setError('登录未保存，请重新生成二维码。');
      } catch (e) { if (!stopped) { setError((e as Error).message); setQr(current => current?.id === id ? { ...current, state: 'error' } : current); } }
    }
    timer = setTimeout(poll, 2500);
    return () => { stopped = true; clearTimeout(timer); };
  }, [qr?.id, qr?.state]);
  useEffect(() => { if (!qr) return; const tick = () => setRemaining(Math.max(0, Math.ceil((qr.deadline - Date.now()) / 1000))); tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer); }, [qr?.deadline]);
  async function action(key: string, fn: () => Promise<void>) { setBusy(key); setError(''); setNotice(''); try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); } }
  async function startQr() { await action('qr', async () => { if (qr) { await request(`/bilibili/qr/${qr.id}/cancel`, {}); setQr(null); } const result = await request<Omit<QR, 'deadline'>>('/bilibili/qr', {}); setQr({ ...result, deadline: Date.now() + result.remaining * 1000 }); }); }
  async function cancelQr() { await action('cancel', async () => { if (qr) await request(`/bilibili/qr/${qr.id}/cancel`, {}); setQr(null); }); }
  async function loadBrowsers() { await action('browsers', async () => { const result = await request<{ browsers: BrowserOption[] }>('/youtube/browsers'); setChoices(result.browsers); setBrowser(''); setProfile(''); }); }
  async function check(platform: 'bilibili' | 'youtube') { await action(`check-${platform}`, async () => { const result = await request<Account>(`/${platform}/check`, {}); setSnapshot(s => s ? { ...s, [platform]: result } : s); setNotice(result.state === 'connected' ? '登录状态检查通过。' : '当前登录不可用，请重新连接。'); }); }
  async function connectYoutube() { await action('youtube', async () => { const result = await request<Account>('/youtube/connect', { browser, profile: profile || null }); setSnapshot(s => s ? { ...s, youtube: result } : s); setNotice('已检查并连接。以后转换 YouTube 视频时将使用所选浏览器的登录状态。'); setChoices(null); }); }
  async function disconnect() { if (!disconnecting) return; const platform = disconnecting; await action('disconnect', async () => { await request(`/${platform}/disconnect`, { confirm_shared: true }); if (platform === 'bilibili') setQr(null); setDisconnecting(null); await refresh(); setNotice('已断开本机共享连接。'); }); }
  const selected = choices?.find(b => b.id === browser);
  const accountState = (platform: 'bilibili' | 'youtube') => snapshot ? labels[snapshot[platform].state] || snapshot[platform].state : '读取状态…';
  return <main className="dashboard accounts-page">
    <div className="page-heading"><div><div className="eyebrow">VIDEO SOURCES & ACCOUNTS</div><h1>账号连接<span className="heading-dot">.</span></h1><p>连接视频来源账号，让课程转换使用你的登录状态。</p></div><button className="button secondary small" disabled={!!busy} onClick={() => action('refresh', refresh)}><RefreshCw size={16} />刷新状态</button></div>
    <div className="account-shared"><Link2 size={18} /><p>与本机 course2md 共用账号连接。连接或断开会同时影响两者；页面不会显示 Cookie 或密码。已保存的连接需点击检查，才能确认当前是否有效。</p></div>
    {error && <div className="form-error" role="alert"><AlertCircle size={17} />{error}</div>}
    {notice && <div className="account-notice" role="status">{notice}</div>}
    <section className="feature-panel account-card" aria-label="Bilibili 账号">
      <div className="account-card-heading"><div className="account-symbol"><MonitorPlay size={25} /></div><div><h2>Bilibili 账号</h2><p>用 B站手机客户端扫码并确认，随后可获取账号有权访问的视频与字幕。</p></div><span className="quiet-badge">{accountState('bilibili')}</span></div>
      {snapshot?.bilibili.name && <p className="account-identity">当前账号：{snapshot.bilibili.name}</p>}
      <div className="account-actions"><button className="button primary" disabled={!!busy || !!qr} onClick={startQr}><QrCode size={16} />{busy === 'qr' ? '获取二维码…' : '扫码连接 Bilibili'}</button><button className="button secondary" disabled={!!busy || !!qr} onClick={() => check('bilibili')}>检查登录状态</button>{snapshot && snapshot.bilibili.state !== 'disconnected' && <button className="button ghost" disabled={!!busy || !!qr} onClick={() => setDisconnecting('bilibili')}><LogOut size={15} />断开</button>}</div>
      {qr && <div className="account-qr-panel"><div>{['waiting', 'confirm'].includes(qr.state) && remaining > 0 ? <Code modules={qr.modules} /> : <div className="account-qr-placeholder"><QrCode size={40} /><span>{qr.state === 'connected' ? '登录完成' : '二维码已停止'}</span></div>}</div><div><h3>{qr.state === 'confirm' ? '请在手机上确认登录' : qr.state === 'connected' ? 'Bilibili 已连接' : qr.state === 'expired' || !remaining ? '二维码已过期' : qr.state === 'error' || qr.state === 'failed' ? '需要重新获取二维码' : '打开 B站 App 扫码'}</h3><p>{['waiting', 'confirm'].includes(qr.state) && remaining > 0 ? `有效期剩余 ${remaining} 秒。请在自己的手机上确认账号。` : '账号凭据由本机 course2md 账号模块保存。'}</p><div className="account-actions">{qr.state !== 'connected' && <button className="button secondary small" disabled={!!busy} onClick={startQr}>重新生成</button>}<button className="button ghost small" disabled={!!busy} onClick={cancelQr}><X size={14} />{qr.state === 'connected' ? '收起' : '取消扫码'}</button></div></div></div>}
    </section>
    <section className="feature-panel account-card" aria-label="YouTube 账号">
      <div className="account-card-heading"><div className="account-symbol youtube"><Youtube size={25} /></div><div><h2>YouTube 账号</h2><p>使用你选定浏览器中的 YouTube 登录，不在知行中输入 Google 密码。</p></div><span className="quiet-badge">{accountState('youtube')}</span></div>
      {snapshot?.youtube.browser && <p className="account-identity">连接浏览器：{snapshot.youtube.browser}{snapshot.youtube.profile ? ` · ${snapshot.youtube.profile}` : ' · 默认配置'}</p>}
      <div className="account-actions"><button className="button primary" disabled={!!busy || !!qr} onClick={loadBrowsers}><Link2 size={16} />选择浏览器连接</button><button className="button secondary" disabled={!!busy || !!qr || !snapshot?.youtube.browser} onClick={() => check('youtube')}>检查连接</button>{snapshot?.youtube.browser && <button className="button ghost" disabled={!!busy || !!qr} onClick={() => setDisconnecting('youtube')}><LogOut size={15} />断开</button>}<a className="button ghost" href="https://www.youtube.com/" target="_blank" rel="noopener noreferrer"><ExternalLink size={15} />打开 YouTube</a></div>
      {choices && <div className="youtube-connect"><p>先在下列浏览器中自行登录 YouTube，再点击“检查并连接”。只保存浏览器与配置选择；检查时由 yt-dlp 临时读取登录信息，不会显示到页面。</p>{choices.length ? <><div className="feature-fields"><label className="feature-field">浏览器<select aria-label="YouTube 浏览器" value={browser} disabled={!!busy} onChange={e => { setBrowser(e.target.value); setProfile(''); }}><option value="">请选择已登录的浏览器</option>{choices.map(b => <option value={b.id} key={b.id}>{b.name}</option>)}</select></label><label className="feature-field">浏览器配置<select aria-label="浏览器配置" value={profile} disabled={!!busy || !browser} onChange={e => setProfile(e.target.value)}><option value="">默认 / 自动选择</option>{selected?.profiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label></div><div className="account-actions"><button className="button primary" disabled={!!busy || !browser} onClick={connectYoutube}>{busy === 'youtube' && <LoaderCircle className="spin" size={16} />}检查并连接</button><button className="button ghost" disabled={!!busy} onClick={() => setChoices(null)}>取消</button></div><small>检查最多约两分钟。浏览器数据库被占用时，请关闭所选浏览器后重试。</small></> : <p role="status">未发现支持的浏览器。请安装 Edge、Chrome 或 Firefox，并登录 YouTube 后刷新。</p>}</div>}
    </section>
    <section className="feature-panel account-card"><div className="account-card-heading"><div className="account-symbol"><Settings2 size={24} /></div><div><h2>学习助教模型</h2><p>讲解、提问、出题与批改使用独立的模型配置。</p></div><button className="button secondary" onClick={onModelSettings}>打开模型设置</button></div></section>
    <p className="feature-hint">本地视频不需要平台账号。断开 YouTube 只清除软件中的浏览器选择，不会退出浏览器里的 Google 账号；正在执行的转换可能继续使用启动时取得的登录状态。</p>
    {busy && <div className="account-busy" role="status"><LoaderCircle className="spin" size={16} />正在处理账号请求…</div>}
    {disconnecting && <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label="确认断开账号"><div className="modal-header"><h2>断开 {disconnecting === 'bilibili' ? 'Bilibili' : 'YouTube'}？</h2></div><p className="account-confirm-text">知行与本机 course2md 共用连接，此操作会同时清除两者的这项连接。浏览器自身的登录不会被退出。</p><div className="account-actions"><button className="button secondary" disabled={!!busy} onClick={() => setDisconnecting(null)}>保留连接</button><button className="button primary" disabled={!!busy} onClick={disconnect}>确认断开共享连接</button></div></section></div>}
  </main>;
}
