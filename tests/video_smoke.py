"""Exercise the real installed course2md engine against an isolated Study Agent DB."""
import argparse
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid

p = argparse.ArgumentParser()
p.add_argument('--exe', required=True)
p.add_argument('--out', required=True)
p.add_argument('--asr', action='store_true')
args = p.parse_args()
root = Path(__file__).resolve().parents[1]
out = Path(args.out).resolve()
data = root / 'verification' / ('video-smoke-' + uuid.uuid4().hex[:8])
data.mkdir(parents=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
base = f'http://127.0.0.1:{port}'
checks = []


def check(label):
    checks.append(label)
    print('PASS ' + label, flush=True)


def api(path, payload=None, method=None, content_type=None, expected=200):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(base + '/api' + path, data=body, method=method or ('POST' if body is not None else 'GET'), headers={'Content-Type': content_type or 'application/json'})
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        raw = response.read()
        assert response.status == expected, (path, response.status, raw[:800])
        return json.loads(raw) if 'json' in response.headers.get('content-type', '') else raw


def wait_task(task_id, terminal=('done', 'failed', 'cancelled'), timeout=150):
    deadline = time.time() + timeout
    last_stage = ''
    while time.time() < deadline:
        task = next(t for t in api('/video/tasks') if t['id'] == task_id)
        if task['stage'] != last_stage:
            last_stage = task['stage']
            print('VIDEO ' + task['status'] + ': ' + last_stage, flush=True)
        if task['status'] in terminal:
            return task
        time.sleep(.5)
    raise AssertionError('Video task timed out: ' + task_id)


def submit(source, **extra):
    return api('/video/tasks', {'title': '视频集成测试', 'source': source, 'transcript_source': 'subtitle', **extra})['id']


env = dict(os.environ, STUDY_PORT=str(port), STUDY_DATA_DIR=str(data), STUDY_SEED='0')
log = open(data / 'server.log', 'wb')
proc = subprocess.Popen([str(Path(args.exe).resolve())], cwd=root, env=env, stdout=log, stderr=log)
report = {'ok': False, 'mode': 'real local course2md CLI; isolated database; no cloud model calls', 'data_dir': str(data), 'checks': checks}
try:
    for _ in range(80):
        if proc.poll() is not None:
            raise RuntimeError('Server exited')
        try:
            api('/health')
            break
        except (OSError, urllib.error.URLError):
            time.sleep(.2)
    assert api('/video/status')['ready']
    check('engine discovery and empty task list')
    api('/video/tasks', {'source': '--help'}, expected=400)
    api('/video/tasks', {'source': 'E:/course2md/samples/test.mp4', 'threads': 0}, expected=400)
    check('invalid source and processing options rejected')

    first = wait_task(submit('E:/course2md/samples/test.mp4'))
    assert first['status'] == 'done', first
    course = api('/courses/' + first['course_id'])
    assert len(course['lessons']) == 2, course
    assert any('测试字幕' in l['content'] for l in course['lessons'])
    images = re.findall(r'\]\((/api/video/assets/[^)]+)\)', course['lessons'][0]['content'])
    assert images
    screenshot = api(images[0][4:])
    assert screenshot[:2] == b'\xff\xd8'
    check('real subtitle conversion imports timed lessons and serves actual screenshots')
    api('/video/assets/' + first['id'] + '/frames/%2E%2E/manifest.json', expected=400)
    check('screenshot path traversal rejected')

    boundary = '----StudyAgent' + uuid.uuid4().hex
    parts = []
    for name, filename, mime, contents in [
        ('options', None, 'application/json', json.dumps({'title': '上传视频验证', 'transcript_source': 'subtitle'}).encode()),
        ('video', 'test.mp4', 'video/mp4', Path('E:/course2md/samples/test.mp4').read_bytes()),
        ('subtitle', 'test.srt', 'text/plain', Path('E:/course2md/samples/test.srt').read_bytes()),
    ]:
        disposition = f'Content-Disposition: form-data; name="{name}"' + (f'; filename="{filename}"' if filename else '')
        parts.append(f'--{boundary}\r\n{disposition}\r\nContent-Type: {mime}\r\n\r\n'.encode() + contents + b'\r\n')
    body = b''.join(parts) + f'--{boundary}--\r\n'.encode()
    uploaded = api('/video/upload', body, content_type='multipart/form-data; boundary=' + boundary)
    upload_task = wait_task(uploaded['id'])
    assert upload_task['status'] == 'done', upload_task
    check('multipart video and subtitle upload converts into a course')

    # A video without a sidecar subtitle must fail honestly, then allow a manual retry.
    failed = wait_task(submit('E:/course2md/samples/speech.mp4'))
    assert failed['status'] == 'failed', failed
    api('/video/tasks/' + failed['id'] + '/retry', method='POST')
    retried = wait_task(failed['id'])
    assert retried['status'] == 'failed'
    check('missing subtitles produce a real failure and support manual retry')

    if args.asr:
        assert api('/video/status')['local_asr_ready']
        asr_id = submit('E:/course2md/samples/speech.mp4', title='本地语音识别验证', transcript_source='asr')
        wait_task(asr_id, terminal=('running', 'failed'), timeout=20)
        queued_id = submit('E:/course2md/samples/test.mp4', title='取消排队验证')
        api('/video/tasks/' + queued_id + '/cancel', method='POST')
        assert wait_task(queued_id)['status'] == 'cancelled'
        check('queued video cancellation')
        asr = wait_task(asr_id, timeout=480)
        assert asr['status'] == 'done', asr
        lessons = api('/courses/' + asr['course_id'])['lessons']
        assert any('没有识别到文字' not in l['content'] and len(l['content']) > 60 for l in lessons)
        report['asr_course_id'] = asr['course_id']
        check('real local CPU ASR produces saved course text without cloud calls')
        cancel_id = submit('E:/course2md/samples/speech.mp4', title='运行中取消验证', transcript_source='asr')
        wait_task(cancel_id, terminal=('running', 'failed'), timeout=20)
        time.sleep(1)
        api('/video/tasks/' + cancel_id + '/cancel', method='POST')
        assert wait_task(cancel_id, timeout=30)['status'] == 'cancelled'
        check('running conversion cancellation leaves server responsive')
    else:
        report['asr'] = 'not run'
    report['course_id'] = first['course_id']
    report['ok'] = True
finally:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    log.close()
    out.parent.mkdir(parents=True, exist_ok=True)
    temp = out.with_suffix('.tmp')
    temp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    temp.replace(out)
    print('Report: ' + str(out), flush=True)
