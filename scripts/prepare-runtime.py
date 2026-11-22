"""Prepare pinned Windows video tools. Does not install course2md or download models."""
import argparse,hashlib,json,os,shutil,tempfile,zipfile
from pathlib import Path,PurePosixPath
from urllib.request import Request,urlopen

ROOT=Path(__file__).resolve().parents[1]
URL='https://github.com/mizorewww/course2md/releases/download/v3.0.0-alpha.9/course2md-desktop-windows-AMD64.zip'
SHA256='b69fd247cec49d2de6f38a83c78d5db7647b1c71a824caa4939ee7c1921b3c78'
def digest(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        while b:=f.read(1024*1024):h.update(b)
    return h.hexdigest()
def prepare(destination,archive=None):
    archive=archive or ROOT/'.cache/runtime/course2md-desktop-windows-AMD64.zip'
    archive.parent.mkdir(parents=True,exist_ok=True)
    if not archive.exists():
        partial=archive.with_suffix('.zip.part')
        print('Downloading pinned video tools (119 MB)…',flush=True)
        with urlopen(Request(URL,headers={'User-Agent':'study-agent-build'}),timeout=90) as response,partial.open('wb') as out:
            shutil.copyfileobj(response,out,1024*1024)
        if digest(partial)!=SHA256:raise RuntimeError('Runtime archive checksum mismatch; no files installed')
        os.replace(partial,archive)
    if digest(archive)!=SHA256:raise RuntimeError('Cached runtime archive checksum mismatch')
    destination.mkdir(parents=True,exist_ok=True)
    installed=[]
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            if entry.is_dir():continue
            parts=PurePosixPath(entry.filename).parts
            if len(parts)<2 or '..' in parts:raise RuntimeError('Invalid archive path')
            relative=PurePosixPath(*parts[1:]);name=relative.as_posix();target=None
            if name in ('ffmpeg.exe','ffprobe.exe'):target=Path('tools/ffmpeg-bin')/name
            elif name in ('aria2c.exe','uv.exe'):target=Path('bin')/name
            elif name.startswith('llama.cpp/'):target=Path('tools/llama')/Path(*relative.parts[1:])
            elif name.startswith('yt-dlp/'):target=Path('bin')/Path(*relative.parts)
            elif len(relative.parts)==1 and (name.startswith('LICENSE') or name in ('THIRD-PARTY-LICENSES.txt','ffmpeg-build.txt')):target=Path('licenses')/name
            if target is None:continue
            output=destination/target
            if not output.resolve().is_relative_to(destination.resolve()):raise RuntimeError('Unsafe destination')
            output.parent.mkdir(parents=True,exist_ok=True)
            tmp=output.with_suffix(output.suffix+'.next')
            with z.open(entry) as source,tmp.open('wb') as out:shutil.copyfileobj(source,out)
            os.replace(tmp,output);installed.append(target.as_posix())
    required=['tools/ffmpeg-bin/ffmpeg.exe','tools/ffmpeg-bin/ffprobe.exe','tools/llama/llama-server.exe','bin/yt-dlp/yt-dlp.exe']
    if not all((destination/p).is_file() for p in required):raise RuntimeError('Pinned archive is missing required tools')
    manifest={'source':URL,'archive_sha256':SHA256,'files':{p:digest(destination/p) for p in sorted(installed)}}
    tmp=destination/'tools-manifest.json.next';tmp.write_text(json.dumps(manifest,indent=2),encoding='utf-8');os.replace(tmp,destination/'tools-manifest.json')
    print(f'Prepared {len(installed)} runtime files; model weights are not bundled.',flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--destination',type=Path,default=ROOT/'runtime/video');p.add_argument('--archive',type=Path);a=p.parse_args();prepare(a.destination.resolve(),a.archive)
