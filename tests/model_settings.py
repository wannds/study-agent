"""Model connection API/UI tests with local fixtures, no external model requests."""
import io,json,time,threading,sqlite3
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,ROOT
class Endpoint(BaseHTTPRequestHandler):
    seen=[];mode='ok'
    def log_message(self,*args):pass
    def reply(self,status,data):
        raw=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_GET(self):
        self.seen.append(('GET',self.path,self.headers.get('Authorization')))
        if self.mode=='error':self.reply(401,{'error':{'message':'fixture denied'}});return
        if self.mode=='empty':self.reply(200,{'data':[]});return
        self.reply(200,{'data':[{'id':'z-vision'},{'id':'a-chat'},{'id':'a-chat'},{'id':'reasoning-chat'}]})
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers['Content-Length'])));self.seen.append(('POST',self.path,self.headers.get('Authorization'),data))
        if self.mode=='error':self.reply(401,{'error':{'message':'fixture rejected secret-original'}});return
        self.reply(200,{'choices':[{'message':{'role':'assistant','content':'连接成功'}}]})
server=ThreadingHTTPServer(('127.0.0.1',0),Endpoint);threading.Thread(target=server.serve_forever,daemon=True).start()
base=f'http://127.0.0.1:{server.server_port}/v1';checks=[];c=Case(ROOT/'bin/study-agent.exe')
def listing():return c.api('/connections')
def draft(item,**kw):return dict(id=item['id'],revision=item['revision'],name=item['name'],provider=item['provider'],base_url=item['base_url'],model=item['model'],api_key='',clear_key=False,**kw)
def item(id):return next(x for x in listing()['items'] if x['id']==id)
def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=83)
try:
    c.api('/settings','PUT',{'base_url':base,'model':'a-chat','api_key':'secret-original','clear_key':False})
    c.stop();c.exe=ROOT/'target/release/study-agent.exe';c.start()
    lst=listing();assert len(lst['items'])==1 and lst['active_id'];a=lst['items'][0];aid=a['id'];assert a['has_api_key'] and a['model']=='a-chat';assert 'secret-original' not in json.dumps(lst)
    original=c.api('/settings');d=draft(a)
    assert c.api('/connections/models','POST',d)['models']==['a-chat','reasoning-chat','z-vision']
    assert Endpoint.seen[-1][2]=='Bearer secret-original'
    assert c.api('/connections/test','POST',d)['scope']=='text';assert c.api('/settings')==original and listing()==lst
    Endpoint.mode='error';result=c.api('/connections/test','POST',d,502);assert 'secret-original' not in json.dumps(result)
    c.api('/connections/models','POST',d,400);assert c.api('/settings')==original
    Endpoint.mode='ok';before=len(Endpoint.seen);changed=dict(d,base_url=base+'/changed')
    c.api('/connections/models','POST',changed,400);c.api('/connections/test','POST',changed,400);assert len(Endpoint.seen)==before
    c.api('/connections/models','POST',dict(changed,clear_key=True));assert Endpoint.seen[-1][2] is None
    bid=c.api('/connections','POST',{'name':'备用接口','provider':'custom','base_url':base+'/chat/completions/','model':'z-vision','api_key':'secret-backup','activate':False})['id'];assert listing()['active_id']==aid and item(bid)['base_url']==base
    c.api('/connections/'+aid+'/delete','POST',{'revision':a['revision']},400)
    c.api('/connections','POST',dict(d,name='主学习接口'));c.api('/connections','POST',dict(d,name='过期修改'),409)
    checks.append('Legacy migration, redacted secrets, draft-only discovery/test, normalized URLs, endpoint-bound keys, active-delete protection and stale-write conflicts')
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True);ctx=browser.new_context(viewport={'width':1440,'height':1050});page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto(f'http://127.0.0.1:{c.port}');page.get_by_role('button',name='模型设置').first.click();expect(page.get_by_role('dialog',name='AI 模型连接')).to_be_visible();expect(page.get_by_label('连接名称',exact=True)).to_have_value('主学习接口')
            expect(page.get_by_label('API Key',exact=False).first).to_have_value('');assert 'secret-original' not in page.content()
            page.get_by_role('button',name='获取模型列表',exact=True).click();expect(page.get_by_label('可用模型',exact=True)).to_be_visible();page.get_by_label('搜索模型',exact=True).fill('vision');page.get_by_label('可用模型',exact=True).select_option('z-vision');expect(page.get_by_label('模型 ID',exact=True)).to_have_value('z-vision')
            page.get_by_role('button',name='测试连接',exact=True).click();expect(page.get_by_text('已验证文字应答；尚未测试工具调用和图片识别。',exact=True)).to_be_visible();assert c.api('/settings')['model']=='a-chat'
            page.get_by_role('button',name='保存连接',exact=True).click();expect(page.locator('.model-notice')).to_have_text('连接已保存。');assert c.api('/settings')['model']=='z-vision'
            page.get_by_role('button',name='添加连接',exact=True).click();expect(page.get_by_label('服务商',exact=True)).to_have_value('deepseek');expect(page.get_by_label('接口地址',exact=True)).to_have_value('https://api.deepseek.com/v1')
            page.get_by_label('服务商',exact=True).select_option('ollama');expect(page.get_by_label('接口地址',exact=True)).to_have_value('http://localhost:11434/v1')
            page.get_by_label('服务商',exact=True).select_option('custom');page.get_by_label('连接名称',exact=True).fill('课程专用 API');page.get_by_label('接口地址',exact=True).fill(base+'/chat/completions');page.get_by_label('API Key',exact=False).first.fill('new-draft-key')
            page.get_by_role('button',name='显示新密钥',exact=True).click();expect(page.locator('#model-secret')).to_have_attribute('type','text');page.locator('#model-secret').fill('new-draft-key2');expect(page.locator('#model-secret')).to_have_attribute('type','password')
            page.get_by_role('button',name='获取模型列表',exact=True).click();expect(page.get_by_label('可用模型',exact=True)).to_be_visible();expect(page.get_by_label('接口地址',exact=True)).to_have_value(base)
            page.get_by_label('可用模型',exact=True).select_option('reasoning-chat');Endpoint.mode='error';page.get_by_role('button',name='测试连接',exact=True).click();expect(page.get_by_role('alert').last).to_contain_text('HTTP 401');assert listing()['active_id']==aid
            shot(page,'ai-settings-failure');Endpoint.mode='ok';page.get_by_role('button',name='测试连接',exact=True).click();expect(page.locator('.model-editor .form-success')).to_contain_text('文字连接成功')
            shot(page,'ai-settings-desktop');page.locator('.model-editor').evaluate('(e)=>e.scrollTop=0');shot(page,'ai-settings-overview')
            page.get_by_role('button',name='保存并使用',exact=True).click();expect(page.locator('.model-current')).to_contain_text('课程专用 API');cid=listing()['active_id'];assert cid!=aid and c.api('/settings')['model']=='reasoning-chat'
            page.get_by_label('连接名称',exact=True).fill('未保存的名字');page.get_by_role('button',name='关闭模型设置',exact=True).click();expect(page.locator('.model-confirm')).to_be_visible();page.get_by_role('button',name='取消',exact=True).click();expect(page.get_by_label('连接名称',exact=True)).to_have_value('未保存的名字')
            page.locator('.model-connection').filter(has_text='备用接口').click();page.get_by_role('button',name='放弃修改并继续',exact=True).click();expect(page.get_by_label('连接名称',exact=True)).to_have_value('备用接口');page.get_by_role('button',name='使用此连接',exact=True).click();expect(page.locator('.model-current')).to_contain_text('备用接口');assert listing()['active_id']==bid
            page.locator('.model-connection').filter(has_text='课程专用 API').click();page.get_by_role('button',name='删除连接',exact=True).click();page.locator('.model-confirm').get_by_role('button',name='删除连接',exact=True).click();expect(page.locator('.model-notice')).to_have_text('连接已删除。');assert cid not in [x['id'] for x in listing()['items']]
            page.set_viewport_size({'width':620,'height':850});shot(page,'ai-settings-narrow');assert page.locator('.model-settings').evaluate('(e)=>e.scrollWidth <= e.clientWidth')
            page.get_by_role('button',name='关闭模型设置',exact=True).click();page.reload();page.get_by_role('button',name='模型设置').first.click();expect(page.locator('.model-current')).to_contain_text('备用接口');expect(page.get_by_label('连接名称',exact=True)).to_have_value('备用接口')
            assert not errors,errors;assert 'secret-backup' not in page.content()
            page.get_by_role('button',name='关闭模型设置',exact=True).click();c.stop();c.start();assert listing()['active_id']==bid
            c.api('/connections/test','POST',draft(item(bid)));assert Endpoint.seen[-1][2]=='Bearer secret-backup'
            checks.append('UI provider presets, fetched model search, manual input, draft key visibility, failed-test preservation, save/activate/delete, dirty-close guard, narrow layout and restart persistence')
        except Exception:
            shot(page,'ai-settings-unexpected-failure');raise
        finally:browser.close()
    active_before=c.api('/settings');inactive=item(aid);c.api('/connections','POST',dict(draft(inactive),clear_key=True));assert not item(aid)['has_api_key'];assert c.api('/settings')==active_before
    empty=Case(ROOT/'target/release/study-agent.exe')
    try: assert empty.api('/connections')=={'items':[],'active_id':None}
    finally: empty.close()
    checks.append('Clearing an inactive key leaves the active key unchanged; a fresh installation starts with no fabricated connection')
    result={'ok':True,'checks':checks,'model':'local deterministic fixture; no external AI requests'};(ROOT/'verification/ai-settings-tests.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(result,ensure_ascii=False,indent=2))
finally:c.close();server.shutdown();server.server_close()
