"""Serve current frontend assets over an isolated test backend; never use user data."""
import json,threading,urllib.request,urllib.error
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from handwriting_smoke import Case,ROOT

class LayoutFixture:
    def __init__(self,exe=None):
        self.case=Case(exe or ROOT/'bin/study-agent.exe')
        self.cid=self.case.fixture();self.case.model_config();self.eid=self.case.exercise()
        backend=f'http://127.0.0.1:{self.case.port}'
        class Handler(SimpleHTTPRequestHandler):
            def __init__(self,*args,**kw):super().__init__(*args,directory=str(ROOT/'web/dist'),**kw)
            def log_message(self,*args):pass
            def forward(self):
                body=self.rfile.read(int(self.headers.get('Content-Length','0'))) or None
                headers={'Content-Type':self.headers.get('Content-Type','application/json')}
                if self.headers.get('Origin'):headers['Origin']=backend
                req=urllib.request.Request(backend+self.path,data=body,method=self.command,headers=headers)
                try:r=urllib.request.urlopen(req,timeout=100)
                except urllib.error.HTTPError as e:r=e
                with r:
                    data=r.read();self.send_response(r.status);self.send_header('Content-Type',r.headers.get('Content-Type','application/json'));self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            def do_GET(self):
                if self.path.startswith('/api/'):self.forward()
                else:super().do_GET()
            def do_POST(self):self.forward()
            def do_PUT(self):self.forward()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=self.server.serve_forever,daemon=True).start();self.url=f'http://127.0.0.1:{self.server.server_port}'
    def close(self):self.server.shutdown();self.server.server_close();self.case.close()
