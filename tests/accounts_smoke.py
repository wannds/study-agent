"""Account API checks in an isolated config, using a fake yt-dlp (no real browser cookies).
--live-qr additionally requests/cancels a real Bilibili QR; never scans or logs in.
"""
import argparse, json, os, socket, subprocess, time, urllib.request, urllib.error, uuid
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
p.add_argument('--out', required=True)
p.add_argument('--live-qr', action='store_true')
args = p.parse_args()
root = Path(__file__).resolve().parents[1]
case = root / 'verification' / ('accounts-' + uuid.uuid4().hex[:8])
case.mkdir(parents=True)
engine = case / 'engine' / 'bin'
engine.mkdir(parents=True)
state_file = case / 'fixture-state.txt'
state_file.write_text('signed-in')
fixture = case / 'fake_ytdlp.rs'
fixture.write_text(r'''
use std::{env,fs};
fn main() {
 let args: Vec<String> = env::args().collect();
 let state = fs::read_to_string(env::var("FIXTURE_YT_STATE_FILE").unwrap()).unwrap();
 if state.trim() == "failure" { eprintln!("NEVER_EXPOSE_TEST_COOKIE"); std::process::exit(1); }
 let position = args.iter().position(|v| v == "--cookies").unwrap();
 let jar = &args[position + 1];
 let body = if state.trim() == "signed-in" {
  "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1999999999\tSAPISID\tNEVER_EXPOSE_TEST_COOKIE\n"
 } else { "# Netscape HTTP Cookie File\n" };
 fs::write(jar,body).unwrap();
}
''', encoding='utf-8')
subprocess.run(['E:/rust/cargo/bin/rustc.exe', '--edition', '2021', str(fixture), '-o', str(engine/'yt-dlp.exe')], check=True, capture_output=True)
(engine/'course2md.exe').write_bytes(b'fixture marker; not executed')
browser_dir = case/'local'/'Microsoft'/'Edge'/'User Data'
(browser_dir/'Default').mkdir(parents=True)
(browser_dir/'Default'/'Cookies').write_bytes(b'isolated fixture marker; not a real database')
(browser_dir/'Local State').write_text(json.dumps({'profile':{'info_cache':{'Default':{'name':'Isolated test profile'}}}}))
browser_marker = browser_dir/'Default'/'browser-marker.txt'
browser_marker.write_text('not an actual cookie database')
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
env = dict(os.environ, STUDY_PORT=str(port), STUDY_DATA_DIR=str(case/'data'), STUDY_SEED='0',
           STUDY_COURSE2MD_DIR=str(case/'engine'), XDG_CONFIG_HOME=str(case/'config'),
           XDG_CACHE_HOME=str(case/'cache'), LOCALAPPDATA=str(case/'local'), APPDATA=str(case/'roaming'),
           FIXTURE_YT_STATE_FILE=str(state_file))
checks=[]
report={'ok':False,'case':str(case),'checks':checks,'mode':'isolated browser metadata and fake yt-dlp; no real browser credentials read'}
log=open(case/'server.log','wb'); proc=None
def check(label):
    checks.append(label); print('PASS '+label,flush=True)
def call(path, body=None, expected=200, origin=None, content_type='application/json'):
    headers={'Content-Type':content_type}
    if origin: headers['Origin']=origin
    data=None if body is None else json.dumps(body).encode()
    request=urllib.request.Request(base+'/api/accounts'+path, data=data,headers=headers)
    try: response=urllib.request.urlopen(request,timeout=155)
    except urllib.error.HTTPError as e: response=e
    with response:
        raw=response.read(); assert response.status==expected,(path,response.status,raw[:300])
        assert b'NEVER_EXPOSE_TEST_COOKIE' not in raw
        assert response.headers.get('Cache-Control')=='no-store' or expected==403
        try: return json.loads(raw)
        except json.JSONDecodeError: return raw.decode()
def start():
    global proc
    proc=subprocess.Popen([str(Path(args.exe).resolve())],cwd=root,env=env,stdout=log,stderr=log)
    for _ in range(80):
        if proc.poll() is not None: raise RuntimeError('Server exited')
        try: call(''); return
        except (OSError, urllib.error.URLError): time.sleep(.2)
    raise RuntimeError('Server failed to start')
def stop():
    if proc is not None and proc.poll() is None:
        proc.terminate()
        try: proc.wait(timeout=10)
        except subprocess.TimeoutExpired: proc.kill(); proc.wait()
try:
    start()
    initial=call('')
    assert initial['bilibili']['state']=='disconnected' and initial['youtube']['state']=='disconnected'
    check('disconnected metadata and no-store responses')
    call('/bilibili/qr',{},expected=403,origin='https://unrelated.example')
    call('/bilibili/qr',{'password':'not accepted'},expected=422)
    call('/youtube/connect',{'browser':'--exec=anything'},expected=400)
    call('/youtube/connect',{'browser':'edge','profile':'../../elsewhere'},expected=400)
    call('/youtube/connect',{'browser':'edge','cookies':'not accepted'},expected=422)
    check('cross-origin requests and arbitrary credentials/profile paths rejected')
    rows=call('/youtube/browsers')['browsers']
    assert [r['id'] for r in rows]==['edge'],rows
    assert rows[0]['profiles']==[{'id':'Default','name':'Isolated test profile'}]
    check('browser and profile discovery stays inside isolated metadata')
    connected=call('/youtube/connect',{'browser':'edge','profile':'Default'})
    assert connected['state']=='connected'
    assert call('/youtube/check',{})['state']=='connected'
    saved=case/'config'/'course2md'/'auth'/'youtube.json'
    assert json.loads(saved.read_text())=={'browser':'edge','profile':'Default'}
    assert not list((case/'cache').rglob('cookies.txt'))
    check('verified browser choice saved without cookies; temporary jar removed')
    state_file.write_text('signed-out')
    call('/youtube/connect',{'browser':'edge'},expected=400)
    assert json.loads(saved.read_text())['profile']=='Default'
    state_file.write_text('failure')
    call('/youtube/check',{},expected=502)
    assert saved.is_file()
    check('signed-out and unreadable sessions preserve prior choice and redact errors')
    stop(); start()
    assert call('')['youtube']['state']=='configured'
    check('restart preserves choice and reports it as not yet verified')
    call('/youtube/disconnect',{'confirm_shared':False},expected=400)
    assert saved.exists()
    call('/youtube/disconnect',{'confirm_shared':True})
    assert not saved.exists() and browser_marker.read_text()=='not an actual cookie database'
    check('confirmed disconnect removes only app connection, not browser files')
    assert call('/bilibili/check',{})['state']=='disconnected'
    cookie=case/'config'/'course2md'/'auth'/'bilibili.cookies.txt'
    cookie.write_text('# Netscape HTTP Cookie File\n# isolated sentinel NEVER_EXPOSE_TEST_COOKIE\n')
    assert call('')['bilibili']['state']=='saved'
    call('/bilibili/disconnect',{'confirm_shared':True})
    assert not cookie.exists()
    call('/bilibili/qr/missing/poll',{},expected=410)
    call('/bilibili/qr/missing/cancel',{})
    call('/unknown/disconnect',{'confirm_shared':True},expected=400)
    check('Bilibili metadata/disconnect and stale QR handling avoid credential exposure')
    if args.live_qr:
        qr=call('/bilibili/qr',{})
        assert qr['remaining']>0 and len(qr['modules'])>=21
        assert all(len(row)==len(qr['modules']) and all(isinstance(v,bool) for v in row) for row in qr['modules'])
        result=call('/bilibili/qr/'+qr['id']+'/poll',{})
        assert result['state']=='waiting',result['state']
        call('/bilibili/qr/'+qr['id']+'/cancel',{})
        call('/bilibili/qr/'+qr['id']+'/poll',{},expected=410)
        assert not cookie.exists()
        check('real Bilibili QR generation, waiting and cancellation; no login performed')
    report['ok']=True
finally:
    stop(); log.close()
    out=Path(args.out).resolve();out.parent.mkdir(exist_ok=True,parents=True)
    tmp=out.with_suffix('.tmp');tmp.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8');tmp.replace(out)
    print('Report: '+str(out),flush=True)
