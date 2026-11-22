"""Four wire protocols and task routing against local strict HTTP fixtures only."""
import io,json,threading,time,traceback
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from PIL import Image
from playwright.sync_api import sync_playwright,expect
from handwriting_smoke import Case,ROOT,document
PROTOCOLS=['chat_completions','responses','anthropic','gemini']
class Endpoint(BaseHTTPRequestHandler):
    events=[];failures=[];mode='ok'
    def log_message(self,*args):pass
    def reply(self,code,value):
        raw=json.dumps(value,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def protocol(self):return self.path.split('/')[1]
    def auth(self,p):
        token='fixture-'+p
        if p=='anthropic':assert self.headers.get('x-api-key')==token;assert self.headers.get('anthropic-version')=='2023-06-01';assert self.headers.get('Authorization') is None
        elif p=='gemini':assert self.headers.get('x-goog-api-key')==token;assert self.headers.get('Authorization') is None
        else:assert self.headers.get('Authorization')=='Bearer '+token
        assert token not in self.path
    def do_GET(self):
        try:
            p=self.protocol();self.auth(p);assert self.path.endswith('/models')
            if p=='gemini':value={'models':[{'name':'models/gemini-model','supportedGenerationMethods':['generateContent']},{'name':'models/embed','supportedGenerationMethods':['embedContent']}],'nextPageToken':'another-page'}
            else:value={'data':[{'id':p+'-model'}]}
            self.reply(200,value)
        except Exception as e:self.failures.append(str(e));self.reply(500,{'error':{'message':'Fixture model-list assertion failed'}})
    def do_POST(self):
        try:
            p=self.protocol();self.auth(p);body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));raw=json.dumps(body,ensure_ascii=False)
            if p=='chat_completions':assert self.path.endswith('/chat/completions');assert 'messages' in body;has_tools=bool(body.get('tools'));has_result=any(m['role']=='tool' for m in body['messages']);has_image='image_url' in raw
            elif p=='responses':
                assert self.path.endswith('/responses');assert body['store'] is False;assert 'input' in body and 'messages' not in body;has_tools=bool(body.get('tools'));has_result=any(m.get('type')=='function_call_output' for m in body['input']);has_image='input_image' in raw
                if has_tools:assert body['tools'][0]['type']=='function' and 'name' in body['tools'][0]
                if has_result:
                    assert any(i.get('type')=='reasoning' and i.get('encrypted_content')=='opaque-fixture' for i in body['input']);assert next(i for i in body['input'] if i.get('type')=='function_call_output')['call_id']=='call-fixture'
            elif p=='anthropic':
                assert self.path.endswith('/messages');assert body['max_tokens']>=128 and isinstance(body.get('system',[]),list);assert all(m['role'] in ['user','assistant'] for m in body['messages']);has_tools=bool(body.get('tools'));has_result='tool_result' in raw;has_image='"media_type": "image/png"' in raw
                if has_tools:assert 'input_schema' in body['tools'][0]
                if has_result:assert any(c.get('tool_use_id')=='tool-fixture' for m in body['messages'] for c in m['content'])
            else:
                assert self.path.endswith('/models/gemini-model:generateContent');assert body.get('contents');has_tools=bool(body.get('tools'));has_result='functionResponse' in raw;has_image='inlineData' in raw
                if has_tools:assert body['tools'][0]['functionDeclarations'];assert 'additionalProperties' not in json.dumps(body['tools'])
                if has_result:
                    parts=[x for m in body['contents'] for x in m['parts']];assert any(x.get('thoughtSignature')=='fixture-signature' for x in parts);fr=next(x['functionResponse'] for x in parts if 'functionResponse' in x);assert fr['name']=='get_learning_progress' and fr['id']=='gemini-fixture'
            phase='test'
            if '学习课程分析助手' in raw:phase='analysis';answer={'title':'单元','summary':'单元摘要','key_points':['知识点'],'difficulties':[],'objective':'解释概念','minutes':20}
            elif '汇总课程概览' in raw:phase='summary';answer={'summary':'课程概览'}
            elif '练习设计者' in raw:phase='quiz';answer={'question':'求 x+2=5','reference_answer':'x=3','rubric':'过程与答案'}
            elif '学习评估者' in raw:phase='image-grade' if has_image else 'grade';answer={'score':91,'feedback':'本地夹具批改结果'}
            elif '手写转录员' in raw:phase='recognize';assert has_image;answer={'text':'x = 3'}
            elif has_tools:phase='tool-result' if has_result else 'tool-call';answer='工具调用完成'
            else:answer='连接成功'
            model='gemini-model' if p=='gemini' else body['model'];assert model==p+'-model' or p=='gemini'
            self.events.append({'protocol':p,'phase':phase,'images':has_image,'model':model})
            if self.mode=='fail':self.reply(401,{'error':{'message':'fixture-'+p}});return
            if has_tools and not has_result:
                if p=='chat_completions':value={'choices':[{'finish_reason':'tool_calls','message':{'role':'assistant','content':None,'tool_calls':[{'id':'call-fixture','type':'function','function':{'name':'get_learning_progress','arguments':'{}'}}]}}]}
                elif p=='responses':value={'status':'completed','output':[{'type':'reasoning','id':'rs-fixture','encrypted_content':'opaque-fixture','summary':[]},{'type':'function_call','id':'fc-fixture','call_id':'call-fixture','name':'get_learning_progress','arguments':'{}'}]}
                elif p=='anthropic':value={'stop_reason':'tool_use','content':[{'type':'tool_use','id':'tool-fixture','name':'get_learning_progress','input':{}}]}
                else:value={'candidates':[{'finishReason':'STOP','content':{'role':'model','parts':[{'functionCall':{'id':'gemini-fixture','name':'get_learning_progress','args':{}},'thoughtSignature':'fixture-signature'}]}}]}
            else:
                text=json.dumps(answer,ensure_ascii=False) if isinstance(answer,dict) else answer
                if p=='chat_completions':value={'choices':[{'finish_reason':'stop','message':{'role':'assistant','content':text}}]}
                elif p=='responses':value={'status':'completed','output':[{'type':'message','role':'assistant','content':[{'type':'output_text','text':text}]}]}
                elif p=='anthropic':value={'stop_reason':'end_turn','content':[{'type':'text','text':text}]}
                else:value={'candidates':[{'finishReason':'STOP','content':{'role':'model','parts':[{'text':text}]}}]}
            self.reply(200,value)
        except Exception as e:self.failures.append(traceback.format_exc());self.reply(500,{'error':{'message':'Fixture protocol assertion failed'}})
server=ThreadingHTTPServer(('127.0.0.1',0),Endpoint);threading.Thread(target=server.serve_forever,daemon=True).start();c=Case(ROOT/'target/release/study-agent.exe');checks=[];ids={}
def rows():return c.api('/connections')['items']
def item(id):return next(x for x in rows() if x['id']==id)
def draft(id):return dict(item(id),api_key='',clear_key=False)
def assign(values):
    r=c.api('/model-routes');return c.api('/model-routes','PUT',{'revision':r['revision'],'assignments':values})
def done(j):
    j=c.wait(j['id']);assert j['status']=='done',j['error'];return j

def shot(page,name):
    im=Image.open(io.BytesIO(page.screenshot()));im.thumbnail((1280,1280));im.convert('RGB').save(ROOT/'verification'/f'{name}.jpg',quality=82)
try:
    cid=c.fixture()
    for p in PROTOCOLS:
        d={'name':p+' 连接','provider':p if p in ['anthropic','gemini'] else 'custom','protocol':p,'base_url':f'http://127.0.0.1:{server.server_port}/{p}/'+('v1beta' if p=='gemini' else 'v1'),'model':p+'-model','api_key':'fixture-'+p,'options':{'supports_images':True},'activate':p=='chat_completions'}
        ids[p]=c.api('/connections','POST',d)['id'];listing=c.api('/connections/models','POST',draft(ids[p]));assert listing['models']==[p+'-model'];assert (not listing.get('truncated')) or p=='gemini';c.api('/connections/test','POST',draft(ids[p]))
    assert not Endpoint.failures,Endpoint.failures
    checks.append('All four protocols pass authenticated model discovery and non-persistent draft tests; Gemini pagination is reported')
    fixed={'analysis':ids['responses'],'practice':ids['anthropic'],'vision':ids['gemini']};assign(fixed)
    for p in PROTOCOLS:
        assign(dict(fixed,chat=ids[p]));start=len(Endpoint.events);done(c.api('/lessons/'+c.lesson+'/chat','POST',{'question':'检查学习进度 '+p}));events=Endpoint.events[start:];assert [e['phase'] for e in events]==['tool-call','tool-result'];assert all(e['protocol']==p for e in events)
    assign(fixed);start=len(Endpoint.events);eid=c.exercise();assert Endpoint.events[start]['protocol']=='anthropic'
    doc=document();c.api('/exercises/'+eid+'/ink','PUT',{'revision':0,'document':doc});c.api('/exercises/'+eid+'/ink/recognize','POST',{'revision':1});assert Endpoint.events[-1]['protocol']=='gemini' and Endpoint.events[-1]['phase']=='recognize'
    done(c.api('/exercises/'+eid+'/grade','POST',{'answer':'x=3','handwriting_revision':1,'handwriting_confirmed':True,'include_image':True}));assert Endpoint.events[-1]['protocol']=='gemini' and Endpoint.events[-1]['phase']=='image-grade'
    eid2=c.exercise();done(c.api('/exercises/'+eid2+'/grade','POST',{'answer':'x=3'}));assert Endpoint.events[-1]['protocol']=='anthropic' and Endpoint.events[-1]['phase']=='grade'
    plan=c.api('/courses/'+cid+'/plan','POST',{'daily_minutes':30});pid=plan['id']
    for _ in range(150):
        d=c.api('/plans/'+pid)
        if d['plan']['status'] in ['draft','failed']:break
        time.sleep(.1)
    assert d['plan']['status']=='draft',d;assert all(e['protocol']=='responses' for e in Endpoint.events if e['phase'] in ['analysis','summary'])
    checks.append('Real task flows route chat tools, analysis, quiz, text grading, handwriting recognition and image grading to the selected connections')
    before=c.api('/model-routes');c.api('/model-routes','PUT',{'revision':before['revision']-1,'assignments':{}},409);c.api('/model-routes','PUT',{'revision':before['revision'],'assignments':{'vision':'missing'}},400)
    c.api('/connections/'+ids['gemini']+'/delete','POST',{'revision':item(ids['gemini'])['revision']},400)
    c.api('/connections','POST',dict(draft(ids['gemini']),options={'supports_images':False}),400)
    a=draft(ids['chat_completions']);a['options']={'supports_images':False};c.api('/connections','POST',a);c.api('/model-routes','PUT',{'revision':before['revision'],'assignments':{'vision':ids['chat_completions']}},400)
    original=c.api('/settings');Endpoint.mode='fail';result=c.api('/connections/test','POST',draft(ids['responses']),502);assert 'fixture-responses' not in json.dumps(result);Endpoint.mode='ok';assert original==c.api('/settings')
    c.stop();c.start();assert c.api('/model-routes')==before
    checks.append('Stale route updates, dangling targets, deletion of assigned connections and text-only vision assignments are rejected; routing survives restart')
    with sync_playwright() as p:
        browser=p.chromium.launch(channel='msedge',headless=True);page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        try:
            page.goto(f'http://127.0.0.1:{c.port}');page.get_by_role('button',name='模型设置',exact=True).click();page.get_by_role('button',name='用途分配',exact=True).click();expect(page.get_by_label('图片与手写',exact=True)).to_have_value(ids['gemini']);expect(page.get_by_label('课程分析与学习计划',exact=True)).to_have_value(ids['responses']);shot(page,'model-routing-desktop')
            page.get_by_label('日常问答与讲解',exact=True).select_option(ids['responses']);page.get_by_role('button',name='连接管理',exact=True).click();expect(page.locator('.model-confirm')).to_be_visible();page.get_by_role('button',name='取消',exact=True).click();page.get_by_role('button',name='保存用途分配',exact=True).click();expect(page.locator('.model-routing-body .form-success')).to_contain_text('已保存');assert c.api('/settings')['model']=='responses-model'
            page.get_by_role('button',name='连接管理',exact=True).click();page.locator('.model-connection').filter(has_text='anthropic 连接').click();expect(page.get_by_label('接口协议',exact=True)).to_have_value('anthropic')
            page.get_by_text('高级参数 · 默认跟随服务商',exact=True).click();page.get_by_label('温度',exact=True).fill('0.4');page.get_by_label('最大输出 tokens',exact=True).fill('2048');page.get_by_role('button',name='保存连接',exact=True).click();expect(page.locator('.model-notice')).to_have_text('连接已保存。');assert item(ids['anthropic'])['options']['temperature']==.4
            page.get_by_role('button',name='添加连接',exact=True).click();page.get_by_label('服务商',exact=True).select_option('gemini');expect(page.get_by_label('接口协议',exact=True)).to_have_value('gemini');expect(page.get_by_label('接口地址',exact=True)).to_have_value('https://generativelanguage.googleapis.com/v1beta')
            page.get_by_label('服务商',exact=True).select_option('openai');page.get_by_label('接口协议',exact=True).select_option('responses');
            if not page.locator('.model-advanced').evaluate('(e)=>e.open'):page.get_by_text('高级参数 · 默认跟随服务商',exact=True).click()
            expect(page.get_by_label('推理等级',exact=True)).to_be_visible();page.get_by_label('推理等级',exact=True).select_option('high');expect(page.get_by_label('温度',exact=True)).to_have_value('');page.locator('.model-editor').evaluate('(e)=>e.scrollTop=0');shot(page,'model-protocol-selection')
            page.get_by_role('button',name='用途分配',exact=True).click();page.get_by_role('button',name='放弃修改并继续',exact=True).click();page.set_viewport_size({'width':620,'height':850});shot(page,'model-routing-narrow');assert page.locator('.model-settings').evaluate('(e)=>e.scrollWidth<=e.clientWidth')
            page.get_by_role('button',name='全部跟随默认',exact=True).click();page.get_by_role('button',name='保存用途分配',exact=True).click();expect(page.locator('.model-routing-body .form-success')).to_be_visible();assert c.api('/model-routes')['assignments']=={}
            page.get_by_role('button',name='关闭模型设置',exact=True).click();page.reload();page.get_by_role('button',name='模型设置',exact=True).click();page.get_by_role('button',name='用途分配',exact=True).click();expect(page.get_by_label('图片与手写',exact=True)).to_have_value('');assert not errors,errors
            checks.append('UI protocols, advanced parameters, role assignments, dirty-change confirmation, narrow layout, reset and reload pass')
        except Exception:shot(page,'model-routing-failure');raise
        finally:browser.close()
    assert not Endpoint.failures,Endpoint.failures
    report={'ok':True,'checks':checks,'requests':len(Endpoint.events),'mode':'isolated local protocol fixtures; no paid AI calls'};(ROOT/'verification/model-protocols-tests.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
finally:
    c.close();server.shutdown();server.server_close()
    if Endpoint.failures:print(json.dumps({'fixture_failures':Endpoint.failures},ensure_ascii=False))
