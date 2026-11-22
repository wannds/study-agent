"""Build an allowlisted Windows portable ZIP; never package user data or models."""
import hashlib,json,re,zipfile,argparse
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
version=re.search(r'^version = "([^"]+)"',(ROOT/'Cargo.toml').read_text(),re.M)[1]
output=ROOT/'dist';output.mkdir(exist_ok=True)
name=f'study-agent-{version}-windows-x64';archive=output/(name+'.zip')
parser=argparse.ArgumentParser();parser.add_argument('--bin-dir',type=Path,default=ROOT/'bin');args=parser.parse_args()
paths=[ROOT/f for f in ['README.md','LICENSE','THIRD-PARTY-NOTICES.md','THIRD-PARTY-LICENSES.txt','desktop.bat','start.bat','stop.bat','scripts/start.ps1','scripts/stop.ps1']]
runtime=ROOT/'runtime/video'
manifest=json.loads((runtime/'tools-manifest.json').read_text(encoding='utf-8'))
for relative,expected in manifest['files'].items():
    p=runtime/relative
    if not p.resolve().is_relative_to(runtime.resolve()):raise RuntimeError('Runtime manifest path escapes runtime')
    if hashlib.sha256(p.read_bytes()).hexdigest()!=expected:raise RuntimeError('Runtime tool checksum mismatch: '+relative)
    paths.append(p)
paths += [runtime/'tools-manifest.json',runtime/'bin/course2md.exe',ROOT/'vendor/course2md-engine/LICENSE']
if not all(p.is_file() for p in paths):raise RuntimeError('Build desktop, video runtime and dependency notices before packaging')
with zipfile.ZipFile(archive.with_suffix('.zip.part'),'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
    for exe in ('study-agent.exe','study-agent-desktop.exe'):z.write(args.bin_dir/exe,name+'/bin/'+exe)
    for p in sorted(set(paths)):z.write(p,name+'/'+p.relative_to(ROOT).as_posix())
archive.with_suffix('.zip.part').replace(archive)
digest=hashlib.sha256(archive.read_bytes()).hexdigest()
(output/'SHA256SUMS').write_text(f'{digest}  {archive.name}\n',encoding='ascii')
print(json.dumps({'archive':str(archive),'size_mb':round(archive.stat().st_size/1048576,1),'files':len(set(paths)),'models_and_user_data':False}))
