"""HTTP integration checks against an isolated database and local model fixture.

No real API key is used. No paid service is contacted.
Usage: python tests/smoke.py --exe bin/study-agent.exe
"""
import argparse
import json
import os
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen


class ModelFixture(BaseHTTPRequestHandler):
    lesson_id = ""
    other_lesson_id = ""
    failed_once = False
    calls = 0
    cross_scope_blocked = False

    def log_message(self, *_):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls += 1
        messages = body["messages"]
        system = messages[0].get("content", "")
        last_user = next((m.get("content", "") for m in reversed(messages) if m["role"] == "user"), "")
        if "FAIL_ONCE" in last_user and not type(self).failed_once:
            type(self).failed_once = True
            self.respond(503, {"error": {"message": "fixture intentional transient failure"}})
            return
        if "练习设计者" in system:
            text = json.dumps({"question": "请解释为什么阅读状态和作答证据要分别保存？", "reference_answer": "阅读行为不能单独证明理解，作答提供可核验依据。", "rubric": "说明两者差别50分，解释作答证据作用50分。"}, ensure_ascii=False)
        elif "学习评估者" in system:
            text = json.dumps({"score": 88, "feedback": "这是本地联调夹具的固定反馈，用于检验保存和展示，不是真实模型评分。"}, ensure_ascii=False)
        elif body.get("tools"):
            if messages[-1]["role"] != "tool":
                target = self.other_lesson_id if "READ_OTHER_COURSE" in last_user else self.lesson_id
                self.respond(200, {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [{"id": "fixture-read", "type": "function", "function": {"name": "read_lesson", "arguments": json.dumps({"lesson_id": target})}}]}}]})
                return
            result = json.loads(messages[-1]["content"])
            if "READ_OTHER_COURSE" in last_user:
                type(self).cross_scope_blocked = result.get("error") == "只能读取当前课程的章节"
                assert "PRIVATE_OTHER_COURSE" not in messages[-1]["content"]
            text = "联调测试回答：已经完成工具调用，并将结果保存到当前章节。"
        else:
            text = "连接成功（本地测试夹具）"
        self.respond(200, {"choices": [{"message": {"role": "assistant", "content": text}}]})

    def respond(self, status, value):
        data = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def run(exe):
    checks = []
    fixture = ThreadingHTTPServer(("127.0.0.1", 0), ModelFixture)
    threading.Thread(target=fixture.serve_forever, daemon=True).start()
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    proc = None
    with tempfile.TemporaryDirectory(prefix="study-agent-smoke-") as tmp:
        env = {**os.environ, "STUDY_DATA_DIR": tmp, "STUDY_PORT": str(port), "STUDY_SEED": "0"}
        log = open(Path(tmp) / "server.log", "w", encoding="utf-8")

        def start():
            p = subprocess.Popen([str(exe)], cwd=exe.parent, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            for _ in range(80):
                if p.poll() is not None:
                    raise AssertionError("server exited: " + (Path(tmp) / "server.log").read_text(encoding="utf-8", errors="replace"))
                try:
                    if request("/health")["ok"]:
                        return p
                except OSError:
                    time.sleep(0.1)
            p.terminate()
            raise AssertionError("server did not start")

        def request(path, method="GET", body=None, expected=200, extra_headers=None):
            headers = {"Content-Type": "application/json", **(extra_headers or {})}
            data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
            try:
                r = urlopen(Request(base + "/api" + path, data=data, headers=headers, method=method), timeout=10)
            except HTTPError as error:
                r = error
            raw = r.read().decode()
            assert r.code == expected, (path, r.code, expected, raw)
            if "json" in r.headers.get("Content-Type", ""):
                return json.loads(raw)
            return raw

        def finished(job_id, expected="done"):
            for _ in range(100):
                job = next(j for j in request("/jobs") if j["id"] == job_id)
                if job["status"] not in ("queued", "running"):
                    assert job["status"] == expected, job
                    return job
                time.sleep(0.1)
            raise AssertionError("job timeout")

        try:
            proc = start()
            assert not request("/settings")["ready"]
            assert "知行" in urlopen(base).read().decode()
            checks.append("embedded UI and health")
            imported = request("/courses", "POST", {"title": "集成测试课程", "format": "markdown", "content": "# 测试\n\n## 第一节\n阅读状态与作答证据分别保存。\n\n## 第二节\n工具返回可核验的原文。"})
            course = request("/courses/" + imported["id"])
            assert len(course["lessons"]) == 2
            lesson = course["lessons"][0]["id"]
            ModelFixture.lesson_id = lesson
            request(f"/lessons/{lesson}/progress", "PUT", {"status": "read"})
            request(f"/lessons/{lesson}/progress", "PUT", {"status": "mastered"}, expected=400)
            request("/courses", "POST", {"title": "空课程", "format": "text", "content": " "}, expected=400)
            checks.append("course import, splitting and reading state")
            json_course = request("/courses", "POST", {"title": "转录测试", "format": "course2md", "content": json.dumps({"sections": [{"t": 75, "speech": [{"text": "测试文字稿"}]}]})})
            assert "01:15" in request("/courses/" + json_course["id"])["lessons"][0]["source_label"]
            checks.append("course2md JSON import with timestamps")
            request(f"/lessons/{lesson}/chat", "POST", {"question": "你好"}, expected=503)
            assert not request("/jobs")
            checks.append("unconfigured model returns explicit error without fake answer")
            request("/settings", "PUT", {"base_url": f"http://127.0.0.1:{fixture.server_port}/v1", "model": "local-test-fixture", "api_key": "fixture-key-not-a-real-secret"})
            conf = request("/settings")
            assert conf["has_api_key"] and "api_key" not in conf
            assert request("/settings/test", "POST")["ok"]
            checks.append("model configuration, secret redaction and connection test")
            job = request(f"/lessons/{lesson}/chat", "POST", {"question": "请解释资料内容"})
            finished(job["id"])
            assert request(f"/jobs/{job['id']}/events")[0]["tool"] == "read_lesson"
            assert len(request(f"/lessons/{lesson}/messages")) == 2
            checks.append("agent tool-call loop and persisted conversation")
            other = request("/courses", "POST", {"title": "其他课程", "format": "text", "content": "PRIVATE_OTHER_COURSE"})
            ModelFixture.other_lesson_id = request("/courses/" + other["id"])["lessons"][0]["id"]
            job = request(f"/lessons/{lesson}/chat", "POST", {"question": "READ_OTHER_COURSE"})
            finished(job["id"])
            assert ModelFixture.cross_scope_blocked
            checks.append("tool cannot read another course")
            job = request(f"/lessons/{lesson}/exercises", "POST")
            finished(job["id"])
            exercise = request(f"/lessons/{lesson}/exercises")[0]
            assert exercise["reference_answer"] == "" and exercise["score"] is None
            request(f"/exercises/{exercise['id']}/draft", "PUT", {"answer": "阅读过不等于能解释，作答可以提供证据。"})
            job = request(f"/exercises/{exercise['id']}/grade", "POST", {"answer": "阅读过不等于能解释，作答可以提供证据。"})
            finished(job["id"])
            graded = request(f"/lessons/{lesson}/exercises")[0]
            assert graded["status"] == "graded" and graded["score"] == 88 and graded["reference_answer"]
            assert request("/exercises")[0]["course_title"] == "集成测试课程"
            assert request("/stats")["graded"] == 1
            checks.append("exercise, draft, grading, reference disclosure and history")
            job = request(f"/lessons/{lesson}/chat", "POST", {"question": "FAIL_ONCE"})
            failed = finished(job["id"], "failed")
            assert "503" in failed["error"]
            request(f"/jobs/{job['id']}/retry", "POST")
            finished(job["id"])
            assert sum(m["role"] == "user" and m["content"] == "FAIL_ONCE" for m in request(f"/lessons/{lesson}/messages")) == 1
            checks.append("failed job retry without duplicate user message")
            request("/settings", "PUT", {}, expected=403, extra_headers={"Origin": "https://unrelated.example"})
            request("/health", expected=403, extra_headers={"Host": "unrelated.example"})
            checks.append("local host and write-origin checks")
            proc.terminate()
            proc.wait(timeout=10)
            proc = None
            with closing(sqlite3.connect(Path(tmp) / "study.db")) as conn:
                now = int(time.time() * 1000)
                conn.execute("INSERT INTO jobs(id,lesson_id,kind,status,stage,payload,created_at,updated_at) VALUES(?,?,'chat','running','test','{}',?,?)", ("interrupted-fixture", lesson, now, now))
                conn.commit()
            calls_before = ModelFixture.calls
            proc = start()
            assert request("/courses/" + imported["id"])["lessons"][0]["reading_status"] == "read"
            assert request(f"/lessons/{lesson}/exercises")[0]["score"] == 88
            assert next(j for j in request("/jobs") if j["id"] == "interrupted-fixture")["status"] == "interrupted"
            assert ModelFixture.calls == calls_before
            checks.append("restart persistence and interrupted tasks without automatic charges")
        finally:
            if proc is not None and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=10)
            log.close()
            fixture.shutdown()
            fixture.server_close()
    return {"ok": True, "mode": "isolated database + local deterministic model fixture; no paid API calls", "checks": checks, "model_requests": ModelFixture.calls}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--exe", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    report = run(args.exe.resolve())
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        temp = args.out.with_suffix(".tmp")
        temp.write_text(text, encoding="utf-8")
        temp.replace(args.out)
    print(text)
