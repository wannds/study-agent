"""Collect installed dependency license texts for a Windows distribution."""
import json,os,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    command=['cargo','metadata','--locked','--format-version','1','--filter-platform','x86_64-pc-windows-msvc','--features','desktop']
    result=subprocess.run(command,cwd=ROOT,capture_output=True,text=True,encoding='utf-8')
    if result.returncode:raise RuntimeError(result.stderr[-2500:])
    meta=json.loads(result.stdout);active={n['id'] for n in meta['resolve']['nodes']}
    output=['Study Agent dependency notices\nGenerated from the locked Windows desktop dependency graph.\n']
    missing=[];count=0
    for p in sorted(meta['packages'],key=lambda p:(p['name'],p['version'])):
        if p['id'] not in active or p['name']=='study-agent':continue
        folder=Path(p['manifest_path']).parent
        files=[f for f in folder.iterdir() if f.is_file() and f.name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE','COPYRIGHT'))]
        if folder.joinpath('LICENSES').is_dir():files.extend(f for f in folder.joinpath('LICENSES').glob('*.txt'))
        if p['name'].startswith('c2m-'):files.append(ROOT/'vendor/course2md-engine/LICENSE')
        fallback=ROOT/'licenses/dependencies'/(p['name']+'-'+p['version']+'.txt')
        if fallback.is_file():files.append(fallback)
        if p.get('license_file'):
            f=folder/p['license_file']
            if f.is_file() and f not in files:files.append(f)
        output.append(f"\n{'='*72}\n{p['name']} {p['version']}\nLicense: {p.get('license') or 'See included license file'}\nSource: {p.get('repository') or 'https://crates.io/crates/'+p['name']+'/'+p['version']}\n")
        for f in sorted(files):output.append(f'\n--- {f.name} ---\n'+f.read_text(encoding='utf-8',errors='replace'))
        if not files:missing.append('Rust: '+p['name']+' '+p['version'])
        count+=1
    for manifest in sorted((ROOT/'web/node_modules').glob('**/package.json')):
        if 'node_modules' not in manifest.parts:continue
        try:p=json.loads(manifest.read_text(encoding='utf-8'))
        except (ValueError,OSError):continue
        if not p.get('name') or not p.get('version'):continue
        files=[f for f in manifest.parent.iterdir() if f.is_file() and f.name.upper().startswith(('LICENSE','LICENCE','COPYING','NOTICE','COPYRIGHT'))]
        if not files:continue
        output.append(f"\n{'='*72}\nNPM: {p['name']} {p['version']}\nLicense: {p.get('license','See license text')}\n")
        for f in sorted(files):output.append(f'\n--- {f.name} ---\n'+f.read_text(encoding='utf-8',errors='replace'))
        count+=1
    destination=ROOT/'THIRD-PARTY-LICENSES.txt';temp=destination.with_suffix('.txt.next');temp.write_text('\n'.join(output),encoding='utf-8');os.replace(temp,destination)
    print(json.dumps({'dependency_entries':count,'missing_rust_license_files':missing},ensure_ascii=False))
if __name__=='__main__':main()
