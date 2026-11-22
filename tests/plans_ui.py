"""Run an isolated UI review server with a local model fixture. Ctrl+C stops it."""
import json, os, socket, subprocess, threading, time, urllib.request, uuid
from pathlib import Path
from http.server import ThreadingHTTPServer
from plans_smoke import Model

root=Path(__file__).resolve().parents[1]
case=root/'verification'/('plans-ui-'+uuid.uuid4().hex[:8]);case.mkdir(parents=True)
server=ThreadingHTTPServer(('127.0.0.1',0),Model)
threading.Thread(target=server.serve_forever,daemon=True).start()
port=8734
with socket.socket() as sock:sock.bind(('127.0.0.1',port))
env=dict(os.environ,STUDY_PORT=str(port),STUDY_DATA_DIR=str(case/'data'),STUDY_SEED='0',XDG_CONFIG_HOME=str(case/'config'),XDG_CACHE_HOME=str(case/'cache'))
log=open(case/'server.log','wb')
proc=subprocess.Popen([str(root/'target/release/study-agent.exe')],cwd=root,env=env,stdout=log,stderr=log)
def api(path,body=None,method=None):
    req=urllib.request.Request(f'http://127.0.0.1:{port}/api'+path,data=None if body is None else json.dumps(body).encode(),method=method or ('POST' if body is not None else 'GET'),headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
try:
    for _ in range(100):
        try:api('/health');break
        except OSError:time.sleep(.1)
    api('/courses',{'title':'学习方法演示（隔离测试）','format':'markdown','content':'# 学习目标\n用自己的话说明概念，并用作答检查理解。\n## 复习与反馈\n阅读进度和练习结果分别记录，复习时回顾易错点。'})
    api('/settings',{'base_url':f'http://127.0.0.1:{server.server_port}/v1','model':'local-ui-fixture','api_key':'','clear_key':True},'PUT')
    session={'port':port,'pid':proc.pid,'case':str(case),'model_port':server.server_port,'mode':'isolated UI fixture'}
    (root/'verification'/'plans-ui-session.json').write_text(json.dumps(session),encoding='utf-8')
    print(json.dumps(session),flush=True)
    while proc.poll() is None:time.sleep(1)
finally:
    if proc.poll() is None:proc.terminate();proc.wait(timeout=10)
    server.shutdown();log.close()
