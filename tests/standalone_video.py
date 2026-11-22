"""Smoke-test the actual portable ZIP from an unrelated cwd, with an empty cache."""
import argparse,json,os,socket,subprocess,tempfile,time,zipfile,threading
from pathlib import Path
from urllib.request import Request,urlopen
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser();parser.add_argument('--archive',type=Path,default=ROOT/'dist/study-agent-0.12.0-windows-x64.zip');parser.add_argument('--asr',action='store_true',help='Download the real weights and run local speech recognition');args=parser.parse_args()
requests=[]
class Mirror(BaseHTTPRequestHandler):
    def do_GET(self):requests.append(self.path);self.send_error(404)
    do_HEAD=do_GET
    def log_message(self,*args):pass
with tempfile.TemporaryDirectory(prefix='Study Agent portable ') as td:
    temp=Path(td);mirror=ThreadingHTTPServer(('127.0.0.1',0),Mirror);threading.Thread(target=mirror.serve_forever,daemon=True).start()
    with zipfile.ZipFile(args.archive) as z:z.extractall(temp)
    app=next(temp.glob('study-agent-*'));runtime=app/'runtime/video';assert not (runtime/'models').exists()
    env=dict(os.environ,STUDY_DATA_DIR=str(temp/'fresh-data'),STUDY_SEED='0',XDG_CONFIG_HOME=str(temp/'config'),XDG_CACHE_HOME=str(temp/'cache'))
    for k in ('STUDY_COURSE2MD_DIR','STUDY_VIDEO_RUNTIME'):env.pop(k,None)
    if not args.asr:env['HF_ENDPOINT']=f'http://127.0.0.1:{mirror.server_port}'
    with socket.socket() as sock:sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    env['STUDY_PORT']=str(port);clip=temp/'sample.mp4'
    subprocess.run([str(runtime/'tools/ffmpeg-bin/ffmpeg.exe'),'-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=blue:s=320x240:r=4','-f','lavfi','-i','sine=frequency=500:sample_rate=16000','-t','3','-c:v','mpeg4','-c:a','aac',str(clip)],check=True)
    sub=clip.with_suffix('.srt');sub.write_text('1\n00:00:00,000 --> 00:00:02,500\nPortable subtitle test.\n',encoding='utf-8')
    proc=subprocess.Popen([app/'bin/study-agent.exe'],cwd=temp,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def api(path,body=None):
        with urlopen(Request(f'http://127.0.0.1:{port}/api'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json'}),timeout=10) as r:return json.load(r)
    def convert(mode):
        task=api('/video/tasks',{'source':str(clip),'transcript_source':mode,'auto_plan':False,'threads':2})['id'];deadline=time.monotonic()+(3600 if args.asr else 120)
        while time.monotonic()<deadline:
            t=next(x for x in api('/video/tasks') if x['id']==task)
            if t['status'] in ('done','failed','cancelled'):return t
            time.sleep(.25)
        api('/video/tasks/'+task+'/cancel',{});raise AssertionError('conversion timed out')
    try:
        for i in range(80):
            try:status=api('/video/status');break
            except OSError:time.sleep(.2)
        assert Path(status['root']).resolve()==runtime.resolve() and all(t['ready'] for t in status['tools']),status
        t=convert('auto');assert t['status']=='done',t['error'];assert 'Portable subtitle test' in str(api('/courses/'+t['course_id']))
        assert not requests and not list(runtime.rglob('*.gguf'));print('PASS portable subtitle import without model download',flush=True)
        sub.unlink();t=convert('asr')
        if args.asr:assert t['status']=='done',t['error']
        else:
            assert requests and t['status']=='failed',(requests,t['error']);print('PASS model fetch initiated against local mirror, failure reported',flush=True)
    finally:proc.terminate();proc.wait(timeout=10);mirror.shutdown();mirror.server_close()
