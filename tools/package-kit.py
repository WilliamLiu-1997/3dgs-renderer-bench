from pathlib import Path
import hashlib
import subprocess
import zipfile

root = Path(__file__).resolve().parent.parent
out = root / 'release'
out.mkdir(exist_ok=True)
files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
kit = out / 'renderer-benchmark-kit.zip'
with zipfile.ZipFile(kit, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for name in sorted(filter(None, files)):
        archive.write(root / name, 'renderer-benchmark-kit/' + name)
(out / 'SHA256SUMS.txt').write_text(hashlib.sha256(kit.read_bytes()).hexdigest() + '  ' + kit.name + '\n')
print(f'{kit.name}: {kit.stat().st_size / 2**20:.1f} MiB')
