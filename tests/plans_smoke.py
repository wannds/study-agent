"""Isolated plan lifecycle plus actual local video conversion. No paid model calls."""
import argparse, collections, datetime, json, os, socket, sqlite3, subprocess, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

class Model(BaseHTTPRequestHandler):
    mode='normal'; calls=0; unit_calls=0; summary_calls=0; received=[]
    def log_message(self,*_): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        cls=type(self); cls.calls+=1; cls.received.append(body)
        system=body['messages'][0]['content']; is_summary='汇总课程概览' in system
        if is_summary: cls.summary_calls+=1
        else: cls.unit_calls+=1
        if cls.mode=='summary_failure' and is_summary:
            self.send(503,{'error':{'message':'intentional isolated summary failure'}}); return
        if cls.mode=='slow': time.sleep(2)
        if cls.mode=='invalid': answer={'title':'invalid incomplete fixture'}
        elif is_summary: answer={'summary':'测试夹具摘要：先理解概念，再通过作答与复习检查理解。此文本仅用于验证程序流程。'}
        else: answer={'title':'课程理解与实践（测试夹具）','summary':'本地测试模型返回的单元摘要，用于验证保存、来源关联和展示。','key_points':['区分阅读记录与理解证据','结合原文检查学习结论'],'difficulties':['避免把读过等同于掌握'],'objective':'用自己的话说明概念，并完成一道理解题。','minutes':35}
        self.send(200,{'choices':[{'message':{'role':'assistant','content':json.dumps(answer,ensure_ascii=False)}}]})
    def send(self,code,value):
        data=json.dumps(value,ensure_ascii=False).encode();self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
        try:self.wfile.write(data)
        except (BrokenPipeError,ConnectionResetError):pass

def free_port():
    with socket.socket() as s:s.bind(('127.0.0.1',0));return s.getsockname()[1]

def main():
    p=argparse.ArgumentParser();p.add_argument('--exe',required=True);p.add_argument('--out',required=True);p.add_argument('--video',action='store_true');args=p.parse_args()
    root=Path(__file__).resolve().parents[1];case=root/'verification'/('plans-'+uuid.uuid4().hex[:8]);case.mkdir(parents=True)
    port=free_port();base=f'http://127.0.0.1:{port}/api';checks=[];proc=None
    model=ThreadingHTTPServer(('127.0.0.1',0),Model);threading.Thread(target=model.serve_forever,daemon=True).start()
    env=dict(os.environ,STUDY_PORT=str(port),STUDY_DATA_DIR=str(case/'data'),STUDY_SEED='0',XDG_CONFIG_HOME=str(case/'config'),XDG_CACHE_HOME=str(case/'cache'))
    log=open(case/'server.log','wb');report={'ok':False,'case':str(case),'checks':checks,'model':'local deterministic fixture; no user key or paid service used'}
    def api(path,body=None,method=None,status=200,headers=None):
        request=Request(base+path,data=None if body is None else json.dumps(body).encode(),method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json',**(headers or {})})
        try:r=urlopen(request,timeout=30)
        except HTTPError as e:r=e
        with r:
            raw=r.read();assert r.status==status,(path,r.status,raw[:600]);return json.loads(raw) if raw.startswith((b'{',b'[')) else raw.decode()
    def check(label):checks.append(label);print('PASS '+label,flush=True)
    def stop():
        nonlocal proc
        if proc and proc.poll() is None:proc.terminate();proc.wait(timeout=15)
    def start():
        nonlocal proc
        proc=subprocess.Popen([str(Path(args.exe).resolve())],cwd=root,env=env,stdout=log,stderr=log)
        for _ in range(100):
            try:api('/health');return
            except OSError:time.sleep(.1)
        raise AssertionError('Server startup failed')
    def course(title,text):return api('/courses',{'title':title,'content':text,'format':'markdown'})['id']
    def wait_plan(id,wanted):
        for _ in range(240):
            d=api('/plans/'+id)
            if d['plan']['status'] in wanted:return d
            if d['plan']['status']=='failed' and 'failed' not in wanted:raise AssertionError(d['plan'])
            time.sleep(.1)
        raise AssertionError('Plan timed out')
    def generate(cid):return api('/courses/'+cid+'/plan',{'daily_minutes':20})['id']
    try:
        start();assert api('/plans')==[]
        cid=course('待配置课程','# 学习课程\n\n阅读和作答分别记录。')
        pid=generate(cid);d=wait_plan(pid,{'waiting_model'});assert not d['tasks'] and Model.calls==0
        api('/plans/'+pid+'/confirm',{'start_date':'2026-11-18','daily_minutes':20},status=409)
        api('/courses/'+cid+'/plan',{},status=403,headers={'Origin':'https://unrelated.example'})
        check('missing model waits without external calls; draft confirmation and origin guards enforced')
        api('/settings',{'base_url':f'http://127.0.0.1:{model.server_port}/v1','model':'fixture','api_key':'','clear_key':True},method='PUT')
        api('/plans/'+pid+'/retry',{});d=wait_plan(pid,{'draft'})
        assert d['analysis']['summary'] and d['analysis']['units'] and not d['tasks']
        before=Model.calls;assert generate(cid)==pid;assert Model.calls==before
        api('/plans/'+pid+'/confirm',{'start_date':'not-a-date','daily_minutes':20},status=400)
        api('/plans/'+pid+'/confirm',{'start_date':'2026-11-18','daily_minutes':0},status=400)
        api('/plans/'+pid+'/confirm',{'start_date':'2026-11-18','daily_minutes':20})
        d=api('/plans/'+pid);assert d['plan']['status']=='active'
        totals=collections.Counter()
        for t in d['tasks']:totals[t['due_date']]+=t['minutes']
        assert max(totals.values())<=20 and len([t for t in d['tasks'] if t['kind']=='review'])==3
        assert sum(t['minutes'] for t in d['tasks'] if t['kind']=='study')==35
        api('/plans/'+pid+'/confirm',{'start_date':'2026-11-18','daily_minutes':20},status=409)
        assert len(api('/plans/'+pid)['tasks'])==len(d['tasks'])
        check('analysis creates a draft; confirmation schedules within budget and cannot duplicate tasks')
        for t in d['tasks']:api('/plan-tasks/'+t['id'],{'done':True},method='PUT')
        assert api('/plans/'+pid)['plan']['status']=='completed'
        api('/plan-tasks/'+d['tasks'][0]['id'],{'done':False},method='PUT');assert api('/plans/'+pid)['plan']['status']=='active'
        saved=api('/plans/'+pid);stop();start();assert api('/plans/'+pid)==saved
        check('task completion, undo and restart persistence work without changing reading progress')

        Model.mode='summary_failure';cid2=course('长课程续跑','# 单元\n'+('学习证据。'*2300)+'\nEND_OF_TRANSCRIPT\n![不发送的截图](/api/video/assets/a/frames/b.jpg)')
        pid2=generate(cid2);failed=wait_plan(pid2,{'failed'});units=len(failed['analysis']['units']);assert units>=2
        assert any('END_OF_TRANSCRIPT' in m['messages'][1]['content'] for m in Model.received)
        assert not any('/api/video/assets' in m['messages'][1]['content'] for m in Model.received)
        unit_calls=Model.unit_calls;Model.mode='normal';api('/plans/'+pid2+'/retry',{});resumed=wait_plan(pid2,{'draft'})
        assert len(resumed['analysis']['units'])==units and Model.unit_calls==unit_calls
        lessons={l['id'] for l in api('/courses/'+cid2)['lessons']}
        assert all(s['lesson_id'] in lessons for u in resumed['analysis']['units'] for s in u['sources'])
        check('full transcript chunks and valid source references; summary retry reuses saved units and excludes images')
        Model.mode='invalid';pid3=generate(course('错误响应课程','# 测试\n检查错误结果。'));invalid=wait_plan(pid3,{'failed'});assert not invalid['tasks']
        Model.mode='normal';api('/plans/'+pid3+'/retry',{});wait_plan(pid3,{'draft'})
        empty=generate(course('无文字截图课程','![图](/api/video/assets/x/frames/z.jpg)\n本节没有识别到文字，请结合截图阅读。'));empty_result=wait_plan(empty,{'failed'});assert '没有可分析的文字' in empty_result['plan']['error']
        check('malformed model output and screenshot-only courses fail honestly and allow recovery')
        stop()
        db=sqlite3.connect(case/'data'/'study.db');db.execute("UPDATE learning_plans SET status='running' WHERE id=?",(pid3,));db.commit();db.close();start()
        assert api('/plans/'+pid3)['plan']['status']=='interrupted'
        before=Model.unit_calls;api('/plans/'+pid3+'/retry',{});wait_plan(pid3,{'draft'});assert Model.unit_calls==before
        check('interrupted analysis is explicit after restart and resumes without repeating saved unit calls')
        if args.video:
            video=api('/video/tasks',{'source':'E:/course2md/samples/test.mp4','title':'自动分析视频测试','transcript_source':'subtitle','auto_plan':True,'daily_minutes':25})['id']
            for _ in range(240):
                v=next(t for t in api('/video/tasks') if t['id']==video)
                if v['status'] in ('done','failed'):break
                time.sleep(.5)
            assert v['status']=='done',v
            matches=[p for p in api('/plans') if p['course_id']==v['course_id']];assert len(matches)==1
            vd=wait_plan(matches[0]['id'],{'draft'});assert vd['plan']['daily_minutes']==25 and vd['analysis']['units'] and not vd['tasks']
            check('actual local video conversion automatically creates one AI-analyzed plan draft')
            video2=api('/video/tasks',{'source':'E:/course2md/samples/test.mp4','title':'关闭自动分析视频测试','transcript_source':'subtitle','auto_plan':False})['id']
            for _ in range(240):
                v2=next(t for t in api('/video/tasks') if t['id']==video2)
                if v2['status'] in ('done','failed'):break
                time.sleep(.5)
            assert v2['status']=='done',v2
            assert not any(p['course_id']==v2['course_id'] for p in api('/plans'))
            check('disabling automatic analysis preserves conversion without creating a plan')
        report['ok']=True
    except Exception as e:report['error']=str(e);raise
    finally:
        stop();log.close();model.shutdown();Path(args.out).resolve().write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');print('Report: '+str(Path(args.out).resolve()),flush=True)

if __name__=='__main__':main()
