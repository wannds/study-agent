import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ChevronRight, Eye, EyeOff, Globe, HardDrive, KeyRound, LoaderCircle, Plus, RefreshCw, Save, Server, Settings2, Trash2, X, Zap } from 'lucide-react';
import './model-settings.css';
import ModelAssignments from './ModelAssignments';

type Protocol='chat_completions'|'responses'|'anthropic'|'gemini';
export type ModelOptions={temperature?:number|null;top_p?:number|null;max_output_tokens?:number|null;supports_images?:boolean|null;reasoning_effort?:string|null};
export type Connection = { id: string; name: string; provider: string; base_url: string; model: string; has_api_key: boolean; revision: number; protocol:Protocol;options:ModelOptions };
type Listing = { items: Connection[]; active_id: string | null };
type Draft = { id?: string; revision: number; name: string; provider: string; base_url: string; model: string; api_key: string; clear_key: boolean;protocol:Protocol;options:ModelOptions };
const protocols:Record<Protocol,{name:string;hint:string}>={chat_completions:{name:'OpenAI Chat Completions',hint:'发送到 /chat/completions，支持采用这一格式的兼容服务。'},responses:{name:'OpenAI Responses',hint:'发送到 /responses；与 Chat Completions 是不同协议。'},anthropic:{name:'Anthropic Messages',hint:'发送到 /messages，使用 x-api-key；官方根地址包含 /v1。'},gemini:{name:'Gemini 原生',hint:'使用 generateContent 和 x-goog-api-key；官方根地址包含 /v1beta。'}};
const presets: {id:string;name:string;base:string;protocol:Protocol;hint:string}[] = [
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', protocol:'chat_completions',hint: '已填入官方接口地址，填写密钥后获取可用模型。' },
  { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', protocol:'chat_completions',hint: '按模型要求选择 Chat Completions 或 Responses。' },
  { id: 'anthropic', name: 'Anthropic / Claude', base: 'https://api.anthropic.com/v1',protocol:'anthropic', hint: '官方 Messages 接口；模型列表与对话均使用此连接的密钥。' },
  { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta',protocol:'gemini', hint: 'Gemini 原生接口。使用兼容入口时，请相应修改地址和协议。' },
  { id: 'qwen', name: '通义千问 / 百炼', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1',protocol:'chat_completions', hint: '中国内地地域预设；其他地域请使用对应地址和密钥。' },
  { id: 'moonshot', name: 'Kimi / Moonshot', base: 'https://api.moonshot.cn/v1',protocol:'chat_completions', hint: 'Moonshot API 预设，不等同于订阅或 Coding Plan 接口。' },
  { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4',protocol:'chat_completions', hint: '通用 API 预设；专用套餐请按服务商文档修改地址。' },
  { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1',protocol:'chat_completions', hint: '获取模型列表后选择所需模型，费用与能力以实际模型为准。' },
  { id: 'ollama', name: 'Ollama · 本地', base: 'http://localhost:11434/v1',protocol:'chat_completions', hint: '先启动本机 Ollama 并安装模型；本地默认服务可不填密钥。' },
  { id: 'custom', name: '自定义兼容接口', base: '',protocol:'chat_completions', hint: '填写实际 API 地址，并选择该网关真正支持的协议。' },
];
const fresh = (): Draft => ({ revision: 0, name: 'DeepSeek', provider: 'deepseek', base_url: presets[0].base, model: '', api_key: '', clear_key: false,protocol:'chat_completions',options:{} });
const fromConnection = (c: Connection): Draft => ({ id: c.id, revision: c.revision, name: c.name, provider: c.provider, base_url: c.base_url, model: c.model, api_key: '', clear_key: false,protocol:c.protocol||'chat_completions',options:c.options||{} });
function baseURL(raw: string) { return raw.trim().replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages|models)$/, '').replace(/\/models\/[^/]+:generateContent$/,''); }
async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/connections${path}`, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`); return data;
}

export default function ModelSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [section,setSection]=useState<'connections'|'routes'>('connections');
  const [routesDirty,setRoutesDirty]=useState(false);
  const [list, setList] = useState<Listing>({ items: [], active_id: null });
  const [draft, setDraft] = useState<Draft>(fresh);
  const [baseline, setBaseline] = useState(() => JSON.stringify(fresh()));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [proof, setProof] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelSearch, setModelSearch] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [confirm, setConfirm] = useState<{ text: string; label: string; run: () => void } | null>(null);
  const panel = useRef<HTMLElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const feedback = useRef<HTMLDivElement>(null);
  const confirmationButton = useRef<HTMLButtonElement>(null);
  const beforeConfirm = useRef<HTMLElement | null>(null);
  const current = list.items.find(c => c.id === list.active_id);
  const selected = list.items.find(c => c.id === draft.id);
  const dirty = section==='routes'?routesDirty:JSON.stringify(draft) !== baseline;
  const valid = !!draft.name.trim() && !!draft.base_url.trim() && !!draft.model.trim();
  const locked = !!busy || loading;
  const provider = presets.find(p => p.id === draft.provider) || presets[presets.length-1];
  const addressChanged = !!selected?.has_api_key && baseURL(selected.base_url) !== baseURL(draft.base_url);
  const needsNewKey = addressChanged && !draft.api_key.trim() && !draft.clear_key;
  const canRequest = !!draft.base_url.trim() && !needsNewKey && !locked;
  const filtered = models.filter(m => m.toLowerCase().includes(modelSearch.toLowerCase()));
  const proofReset = () => { setError(''); setNotice(''); setProof(''); };
  function edit(patch: Partial<Draft>) { setDraft(d => ({ ...d, ...patch })); proofReset(); if ('base_url' in patch || 'api_key' in patch || 'clear_key' in patch || 'protocol' in patch) { setModels([]); setModelSearch(''); } if ('api_key' in patch) setShowKey(false); }
  function select(c?: Connection) { editor.current?.scrollTo({ top: 0 }); const d = c ? fromConnection(c) : fresh(); setDraft(d); setBaseline(JSON.stringify(d)); setModels([]); setModelSearch(''); setShowKey(false); setConfirm(null); proofReset(); }
  function ask(text: string, label: string, run: () => void) { beforeConfirm.current = document.activeElement as HTMLElement; setConfirm({ text, label, run }); }
  function cancelConfirm() { setConfirm(null); beforeConfirm.current?.focus(); }
  function guard(run: () => void) { if (locked) return; if (dirty) ask('此连接有未保存的修改，是否放弃这些修改？', '放弃修改并继续', run); else run(); }
  async function load() { setLoading(true); setError(''); try { const data = await request<Listing>(''); setList(data); select(data.items.find(c => c.id === data.active_id) || data.items[0]); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } }
  useEffect(() => { void load(); const original = document.activeElement as HTMLElement; panel.current?.querySelector<HTMLButtonElement>('button')?.focus(); return () => { original?.focus(); }; }, []);
  useEffect(() => { if (proof || error) feedback.current?.scrollIntoView({ block: 'nearest' }); }, [proof, error]);
  useEffect(() => { if (confirm) confirmationButton.current?.focus(); }, [confirm]);
  useEffect(() => {
    const fn = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); if (confirm) cancelConfirm(); else guard(onClose); }
      if (e.key === 'Tab') {
        const nodes = Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]') || []).filter(n => n.getClientRects().length > 0);
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', fn); return () => document.removeEventListener('keydown', fn);
  });
  async function action(kind: 'models' | 'test' | 'save' | 'use' | 'activate' | 'delete') {
    setBusy(kind); setError(''); setNotice(''); setConfirm(null);
    try {
      const payload = { ...draft, base_url: baseURL(draft.base_url) };
      if (kind === 'models') {
        const data = await request<{ models: string[];truncated?:boolean }>('/models', payload); setModels(data.models); setModelSearch('');
        setNotice(data.models.length ? `读取到 ${data.models.length} 个模型，请在下方选择。${data.truncated?'服务还有后续列表，未列出的模型可手填。':''}` : '服务返回了空列表，可直接填写模型 ID。');
      } else if (kind === 'test') {
        setProof(''); const result = await request<{ latency_ms: number; response: string }>('/test', payload);
        setProof(`文字连接成功 · ${(result.latency_ms / 1000).toFixed(1)} 秒。${result.response}`);
      } else {
        let id = draft.id;
        if (kind === 'activate') await request(`/${draft.id}/activate`, { revision: draft.revision });
        else if (kind === 'delete') await request(`/${draft.id}/delete`, { revision: draft.revision });
        else { const saved = await request<{ id: string }>('', { ...payload, activate: kind === 'use' }); id = saved.id; }
        const data = await request<Listing>(''); setList(data); select(data.items.find(c => c.id === id) || data.items.find(c => c.id === data.active_id) || data.items[0]);
        await onSaved();
        setNotice(kind === 'delete' ? '连接已删除。' : kind === 'activate' || kind === 'use' ? '已设为默认连接，跟随默认的用途会在后续请求中使用它。' : '连接已保存。');
      }
    } catch (e) { setError((e as Error).message); if (kind === 'test') setProof(''); }
    finally { setBusy(''); }
  }
  function chooseProvider(id: string) {
    const p = presets.find(x => x.id === id)!;
    edit({ provider: id, base_url: p.base, model: '', api_key: '', clear_key: false, protocol:p.protocol, options:{}, name: draft.id ? draft.name : p.name }); setModels([]); setShowKey(false);
  }
  return <div className="modal-backdrop model-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) guard(onClose); }}>
    <section ref={panel} className="model-settings" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
      <header className="model-header"><div className="model-title-icon"><Settings2 size={22} /></div><div><h2 id="model-settings-title">AI 模型连接</h2><p>选择服务商，连接模型，再开始学习。</p></div><button className="icon-button" aria-label="关闭模型设置" disabled={!!busy} onClick={() => guard(onClose)}><X size={21} /></button></header>
      <div className="model-current"><span className={`model-status-dot ${current ? 'configured' : ''}`} /><span>{current ? <>默认连接 <strong>{current.name}</strong><span className="current-model-id">{current.model}</span></> : '尚未设置默认连接'}</span><span className="model-protocol">{current?protocols[current.protocol||'chat_completions'].name:'选择协议连接'}</span></div>
      <nav className="model-tabs" aria-label="模型配置分类"><button aria-pressed={section==='connections'} disabled={locked} className={section==='connections'?'selected':''} onClick={()=>{if(section!=='connections')guard(()=>setSection('connections'))}}>连接管理</button><button aria-pressed={section==='routes'} disabled={locked} className={section==='routes'?'selected':''} onClick={()=>{if(section!=='routes')guard(()=>{select(selected);setSection('routes')})}}>用途分配</button></nav>
      {confirm && <div className="model-confirm" role="alert"><p>{confirm.text}</p><div><button ref={confirmationButton} className="button secondary" onClick={cancelConfirm}>取消</button><button className="button primary" onClick={() => { const run = confirm.run; setConfirm(null); run(); }}>{confirm.label}</button></div></div>}
      {section==='routes'?<div className="model-routing-shell" inert={confirm?true:undefined}><ModelAssignments items={list.items} activeId={list.active_id} onDirty={setRoutesDirty} onBusy={v=>setBusy(v?'routing':'')} onSaved={onSaved}/></div>:<><div className="model-layout" inert={confirm ? true : undefined}>
        <aside className="model-connections"><div className="model-list-heading"><h3>我的连接</h3><span>{list.items.length}</span></div><button className="button secondary model-add" disabled={locked} onClick={() => guard(() => select())}><Plus size={16} />添加连接</button>
          <div className="model-connection-list">{list.items.map(c => <button key={c.id} className={`model-connection ${draft.id === c.id ? 'selected' : ''}`} disabled={locked} onClick={() => guard(() => select(c))} aria-pressed={draft.id === c.id}>
            {c.provider === 'ollama' ? <HardDrive size={17} /> : <Globe size={17} />}<span><strong>{c.name}</strong><small>{c.model}</small>{c.id === list.active_id && <em><Check size={11} />当前使用</em>}</span><ChevronRight size={14} />
          </button>)}</div>{!loading && !list.items.length && <p className="model-empty">保存常用接口，下次直接切换，无需重新填写密钥。</p>}<p className="model-local"><HardDrive size={14} />连接保存在这台电脑</p>
        </aside>
        <div ref={editor} className="model-editor">
          {loading ? <div className="model-loading"><LoaderCircle className="spin" size={22} />正在读取连接…</div> : <>
            <div className="model-editor-heading"><div><h3>{draft.id ? '编辑连接' : '添加模型连接'}</h3><p>{draft.id === list.active_id ? '默认连接，保存后用于跟随默认的后续请求。' : '先保存为备用，或保存并立即使用。'}</p></div><span className="model-draft-tag">{dirty ? '未保存修改' : draft.id ? '已保存' : '新连接'}</span></div>
            <fieldset disabled={locked} className="model-fields">
              <div className="model-form-row"><label className="model-field">服务商<select aria-label="服务商" value={draft.provider} onChange={e => chooseProvider(e.target.value)}>{presets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="model-field">连接名称<input aria-label="连接名称" value={draft.name} maxLength={80} onChange={e => edit({ name: e.target.value })} placeholder="例如：日常学习 / 备用接口" /></label></div>
              <p className="model-field-help">{provider.hint}</p>
              <label className="model-field">接口协议<select aria-label="接口协议" value={draft.protocol} onChange={e=>edit({protocol:e.target.value as Protocol,options:{...draft.options,reasoning_effort:null,temperature:null,top_p:null}})}>{Object.entries(protocols).map(([id,p])=><option key={id} value={id}>{p.name}</option>)}</select><small>{protocols[draft.protocol].hint}</small></label>
              <label className="model-field">接口地址 <span className="model-field-english">Base URL</span><input aria-label="接口地址" value={draft.base_url} onChange={e => edit({ base_url: e.target.value })} onBlur={() => { if (draft.base_url !== baseURL(draft.base_url)) edit({ base_url: baseURL(draft.base_url) }); }} autoComplete="off" spellCheck={false} placeholder="https://api.example.com/v1" /><small>填写 API 根地址；完整的对话端点地址会自动整理，查询参数请移除。</small></label>
              <div className="model-field"><label htmlFor="model-secret">API Key {selected?.has_api_key && !draft.clear_key && !draft.api_key && <span className="model-key-saved"><KeyRound size={12} />已保存</span>}</label><div className="model-secret"><input id="model-secret" type={showKey ? 'text' : 'password'} value={draft.api_key} onChange={e => edit({ api_key: e.target.value, clear_key: false })} autoComplete="new-password" spellCheck={false} placeholder={selected?.has_api_key ? '留空保留此连接的密钥；输入新值替换' : draft.provider === 'ollama' ? '本地默认服务可留空' : '粘贴服务商提供的 API Key'} />{draft.api_key && <button type="button" className="icon-button" aria-label={showKey ? '隐藏新密钥' : '显示新密钥'} onClick={() => setShowKey(x => !x)}>{showKey ? <EyeOff size={17} /> : <Eye size={17} />}</button>}</div><small>已保存的密钥不回显。密钥保存在本机数据库中。</small>{selected?.has_api_key && <label className="model-clear-key"><input type="checkbox" checked={draft.clear_key} onChange={e => edit({ clear_key: e.target.checked, api_key: '' })} />清除这个连接的已保存密钥</label>}</div>
              {needsNewKey && <div className="model-warning"><AlertCircle size={15} />地址已改变，请重新填写密钥；不需要密钥时勾选清除。</div>}
              <div className="model-model-heading"><h4><Server size={16} />选择模型</h4><button type="button" className="button secondary small" disabled={!canRequest} onClick={() => action('models')}>{busy === 'models' ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}获取模型列表</button></div>
              {models.length > 0 && <div className="model-picker"><input aria-label="搜索模型" placeholder={`搜索 ${models.length} 个模型…`} value={modelSearch} onChange={e => setModelSearch(e.target.value)} /><select aria-label="可用模型" value={models.includes(draft.model) && filtered.includes(draft.model) ? draft.model : ''} onChange={e => { if (e.target.value) edit({ model: e.target.value }); }}><option value="">{filtered.length ? '选择服务返回的模型' : '没有匹配的模型，可在下方手填'}</option>{filtered.map(m => <option key={m} value={m}>{m}</option>)}</select></div>}
              <label className="model-field">模型 ID<input aria-label="模型 ID" value={draft.model} maxLength={200} onChange={e => edit({ model: e.target.value })} placeholder="从列表选择，或填写完整模型名称" autoComplete="off" spellCheck={false} /><small>列表不可用时可手动填写。请选择支持对话的模型；手写识别还需要图像输入能力。</small></label>
              <label className="model-field">图片输入能力<select aria-label="图片输入能力" value={draft.options.supports_images===true?'yes':draft.options.supports_images===false?'no':'unknown'} onChange={e=>edit({options:{...draft.options,supports_images:e.target.value==='yes'?true:e.target.value==='no'?false:null}})}><option value="unknown">未确认 · 以实际调用结果为准</option><option value="yes">支持图片与手写</option><option value="no">仅文字</option></select><small>这是能力声明，文字连接测试不会验证识图能力。</small></label>
              <details className="model-advanced"><summary>高级参数 · 默认跟随服务商</summary><p>留空时不发送该参数。模型不支持的参数可能被服务拒绝；温度与 Top P 二选一。</p><div className="model-form-row"><label className="model-field">温度<input aria-label="温度" type="number" min="0" max={draft.protocol==='anthropic'?1:2} step="0.1" value={draft.options.temperature??''} onChange={e=>edit({options:{...draft.options,temperature:e.target.value===''?null:+e.target.value,top_p:null,reasoning_effort:null}})}/></label><label className="model-field">Top P<input aria-label="Top P" type="number" min="0.01" max="1" step="0.05" value={draft.options.top_p??''} onChange={e=>edit({options:{...draft.options,top_p:e.target.value===''?null:+e.target.value,temperature:null,reasoning_effort:null}})}/></label></div><label className="model-field">最大输出 tokens<input aria-label="最大输出 tokens" type="number" min="128" max="131072" step="1" value={draft.options.max_output_tokens??''} onChange={e=>edit({options:{...draft.options,max_output_tokens:e.target.value===''?null:+e.target.value}})}/><small>{draft.protocol==='anthropic'?'Messages 必须指定上限，留空时使用 4096。':'留空使用服务默认值。'}</small></label>{draft.protocol==='responses'&&<label className="model-field">推理等级<select aria-label="推理等级" value={draft.options.reasoning_effort||''} onChange={e=>edit({options:{...draft.options,reasoning_effort:e.target.value||null,temperature:null,top_p:null}})}><option value="">服务默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select><small>仅用于支持 reasoning.effort 的 Responses 模型。</small></label>}</details>
            </fieldset>
            <div className="model-test-row"><button className="button secondary" disabled={!canRequest || !draft.model.trim()} onClick={() => action('test')}>{busy === 'test' ? <LoaderCircle className="spin" size={16} /> : <Zap size={16} />}测试连接</button><p>发送一条简短文字请求，可能产生费用。测试不会保存或切换当前连接。</p></div>
            {proof && <div ref={feedback} className="form-success" role="status"><CheckCircle2 size={16} /><div>{proof}<small className="model-test-scope">已验证文字应答；尚未测试工具调用和图片识别。</small></div></div>}
          </>}
          {error && <div ref={feedback} className="form-error" role="alert"><AlertCircle size={16} /><div>{error}<button className="text-button" disabled={locked} onClick={() => guard(load)}>重新读取连接</button></div></div>}
          {notice && <div className="model-notice" role="status"><CheckCircle2 size={15} />{notice}</div>}
        </div>
      </div>
      <footer className="model-footer" inert={confirm ? true : undefined}><p>学习资料会发送到用途分配最终选择的服务。</p><div className="model-footer-actions">{draft.id && draft.id !== list.active_id && <button className="button ghost" aria-label="删除连接" disabled={locked} onClick={() => ask(`删除“${draft.name}”？此连接的设置和密钥也会删除。`, '删除连接', () => { void action('delete'); })}><Trash2 size={15} /></button>}{draft.id && draft.id !== list.active_id && !dirty && <button className="button primary" disabled={locked} onClick={() => action('activate')}><Check size={16} />使用此连接</button>}{(!draft.id || dirty || draft.id === list.active_id) && <><button className={`button ${draft.id === list.active_id ? 'primary' : 'secondary'}`} disabled={locked || !valid || needsNewKey || (!!draft.id && !dirty)} onClick={() => action('save')}><Save size={15} />保存连接</button>{draft.id !== list.active_id && <button className="button primary" disabled={locked || !valid || needsNewKey} onClick={() => action('use')}>{busy === 'use' ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}保存并使用</button>}</>}{busy && <span className="model-working" role="status"><LoaderCircle className="spin" size={14} />处理中…</span>}</div></footer></>}
    </section>
  </div>;
}
