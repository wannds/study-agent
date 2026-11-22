"""Isolated handwriting API/UI checks; uses only a deterministic local model."""
import argparse, base64, copy, io, json, os, socket, sqlite3, subprocess, threading, time, uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from PIL import Image, ImageDraw

ROOT=Path(__file__).resolve().parents[1]
class Model(BaseHTTPRequestHandler):
    fail=False
    seen=[]
    def log_message(self,*args):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path=='/fixture':
            Model.fail=body.get('fail',False);self.reply(200,{'ok':True});return
        Model.seen.append(body)
        if Model.fail:self.reply(400,{'error':{'message':'fixture: model does not support images'}});return
        system=body['messages'][0]['content']
        if '转录员' in system:answer={'text':'x + 2 = 5\nx = 3（本地测试转录）'}
        elif '练习设计者' in system:answer={'question':'求解 x + 2 = 5，写出计算过程。（隔离测试题）','reference_answer':'x = 3','rubric':'移项过程 50 分，结果 50 分。'}
        elif '学习评估者' in system:answer={'score':90,'feedback':'本地测试模型的固定反馈，用于检查保存和展示，不代表真实识别或评分效果。'}
        else:answer={'text':'fixture'}
        self.reply(200,{'choices':[{'message':{'content':json.dumps(answer,ensure_ascii=False)}}]})
    def reply(self,status,data):
        raw=json.dumps(data,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)

class Case:
    def __init__(self,exe,port=0):
        self.case=ROOT/'verification'/('handwriting-'+uuid.uuid4().hex[:8]);self.case.mkdir(parents=True)
        self.model=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=self.model.serve_forever,daemon=True).start()
        with socket.socket() as sock:sock.bind(('127.0.0.1',port));self.port=sock.getsockname()[1]
        self.env=dict(os.environ,STUDY_DATA_DIR=str(self.case/'data'),STUDY_PORT=str(self.port),STUDY_SEED='0',XDG_CONFIG_HOME=str(self.case/'config'),XDG_CACHE_HOME=str(self.case/'cache'))
        self.exe=exe;self.log=open(self.case/'server.log','wb');self.proc=None;self.start()
    def start(self):
        self.proc=subprocess.Popen([str(self.exe)],cwd=ROOT,env=self.env,stdout=self.log,stderr=self.log,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        for _ in range(100):
            try:self.api('/health');return
            except OSError:time.sleep(.1)
        raise AssertionError('server startup timeout')
    def stop(self):
        if self.proc and self.proc.poll() is None:self.proc.terminate();self.proc.wait(timeout=10)
    def close(self):self.stop();self.model.shutdown();self.model.server_close();self.log.close()
    def api(self,path,method='GET',body=None,expected=200):
        req=Request(f'http://127.0.0.1:{self.port}/api'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'},method=method)
        try:r=urlopen(req,timeout=100)
        except HTTPError as e:r=e
        with r:
            data=json.load(r);assert r.status==expected,(path,r.status,data);return data
    def model_config(self):self.api('/settings','PUT',{'base_url':f'http://127.0.0.1:{self.model.server_port}/v1','model':'handwriting-local-fixture','api_key':'','clear_key':True})
    def wait(self,jid):
        for _ in range(200):
            j=next(j for j in self.api('/jobs') if j['id']==jid)
            if j['status'] in ('done','failed','interrupted'):return j
            time.sleep(.1)
        raise AssertionError('job timeout')
    def fixture(self):
        c=self.api('/courses','POST',{'title':'手写练习演示（隔离测试）','format':'markdown','content':'# 一元一次方程\n等式两边进行相同运算，等式保持成立。例：x + 2 = 5，移项得 x = 3。'})
        self.lesson=self.api('/courses/'+c['id'])['lessons'][0]['id'];return c['id']
    def exercise(self):
        self.wait(self.api(f'/lessons/{self.lesson}/exercises','POST',{})['id']);return self.api(f'/lessons/{self.lesson}/exercises')[0]['id']

def document():
    im=Image.new('RGB',(1200,900),'white');ImageDraw.Draw(im).line([(100,100),(250,240),(450,100)],fill='black',width=5)
    data=io.BytesIO();im.save(data,format='PNG')
    return {'answer':{'strokes':[{'tool':'pen','points':[[100,100,.5],[250,240,.5],[450,100,.5]]}]},'scratch':{'strokes':[{'tool':'pen','points':[[999,777,.6],[998,776,.7]]}]},'image':'data:image/png;base64,'+base64.b64encode(data.getvalue()).decode()}

def run(c):
    checks=[];c.fixture();c.model_config();eid=c.exercise();p=f'/exercises/{eid}'
    assert c.api(p+'/ink')['revision']==0
    c.api('/exercises/not-existing/ink',expected=404)
    d=document();assert c.api(p+'/ink','PUT',{'revision':0,'document':d})['revision']==1
    assert c.api(p+'/ink')['document']==d
    c.api(p+'/ink','PUT',{'revision':0,'document':d},409)
    broken=copy.deepcopy(d);broken['scratch']['strokes'][0]['points'][0][0]=1201
    c.api(p+'/ink','PUT',{'revision':1,'document':broken},400)
    broken=copy.deepcopy(d);broken['image']='https://example.com/remote.png'
    c.api(p+'/ink','PUT',{'revision':1,'document':broken},400)
    checks.append('per-exercise persistence, stale-version conflicts, coordinate and image validation')
    c.api('/settings','PUT',{'base_url':'','model':'','api_key':'','clear_key':True})
    c.api(p+'/ink/recognize','POST',{'revision':1},400);assert c.api(p+'/ink')['document']==d
    c.model_config();Model.fail=True;c.api(p+'/ink/recognize','POST',{'revision':1},400);Model.fail=False
    result=c.api(p+'/ink/recognize','POST',{'revision':1});assert 'x = 3' in result['text']
    msg=Model.seen[-1]['messages'][-1]['content'];assert len(msg)==2 and msg[1]['image_url']['url']==d['image']
    assert 'scratch' not in json.dumps(Model.seen[-1]) and '999' not in msg[0]['text']
    n=len(Model.seen);c.api(p+'/ink/recognize','POST',{'revision':1});assert len(Model.seen)==n
    checks.append('missing/incompatible model preserves original; retry works; recognition cache avoids duplicate calls; scratch excluded')
    d['scratch']['strokes']=[];c.api(p+'/ink','PUT',{'revision':1,'document':d});assert c.api(p+'/ink')['recognized_revision']==2
    c.api(p+'/grade','POST',{'answer':result['text'],'handwriting_revision':2},400)
    c.api(p+'/grade','POST',{'answer':result['text'],'handwriting_revision':1,'handwriting_confirmed':True},409)
    job=c.api(p+'/grade','POST',{'answer':result['text'],'handwriting_revision':2,'handwriting_confirmed':True,'include_image':True})
    assert c.wait(job['id'])['status']=='done'
    assert Model.seen[-1]['messages'][-1]['content'][1]['image_url']['url']==d['image']
    c.api(p+'/ink','PUT',{'revision':2,'document':d},409)
    c.api(p+'/grade','POST',{'answer':'new'},400)
    checks.append('scratch edits preserve transcription; confirmation and current revision required; image grading and frozen original')
    c.stop();c.start();assert c.api(p+'/ink')['document']==d
    assert next(x for x in c.api(f'/lessons/{c.lesson}/exercises') if x['id']==eid)['score']==90
    checks.append('restart retains original, transcription and grade')
    other=c.exercise();q=f'/exercises/{other}';c.api(q+'/ink','PUT',{'revision':0,'document':document()})
    c.api(q+'/ink/recognize','POST',{'revision':1});new=document();new['answer']['strokes'][0]['points'][0][0]=120
    im=Image.new('RGB',(1200,900),'white');f=io.BytesIO();im.save(f,format='PNG');new['image']='data:image/png;base64,'+base64.b64encode(f.getvalue()).decode()
    c.api(q+'/ink','PUT',{'revision':1,'document':new});assert c.api(q+'/ink')['recognized_revision']==-1
    Model.fail=True;job=c.api(q+'/grade','POST',{'answer':'人工转录','handwriting_revision':2,'handwriting_confirmed':True});assert c.wait(job['id'])['status']=='failed'
    c.api(q+'/ink','PUT',{'revision':2,'document':new},409);Model.fail=False
    c.api('/jobs/'+job['id']+'/retry','POST',{});assert c.wait(job['id'])['status']=='done'
    assert isinstance(Model.seen[-1]['messages'][-1]['content'],str)
    checks.append('answer edits invalidate recognition; manual transcription and text-only grade; failed grading retries frozen input')
    return checks

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('--exe',type=Path,default=ROOT/'target/release/study-agent.exe');ap.add_argument('--serve',action='store_true');args=ap.parse_args()
    c=Case(args.exe.resolve(),8735 if args.serve else 0)
    try:
        if args.serve:
            c.fixture();c.model_config();eid=c.exercise()
            info={'port':c.port,'pid':c.proc.pid,'case':str(c.case),'model_port':c.model.server_port,'exercise_id':eid,'lesson_id':c.lesson}
            (ROOT/'verification/handwriting-ui-session.json').write_text(json.dumps(info),encoding='utf-8');print(json.dumps(info),flush=True)
            while c.proc.poll() is None:time.sleep(1)
        else:
            checks=run(c);report={'ok':True,'checks':checks,'model':'local deterministic fixture; no paid calls','case':str(c.case)}
            (ROOT/'verification/handwriting-smoke.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps(report,ensure_ascii=False,indent=2))
    finally:c.close()
