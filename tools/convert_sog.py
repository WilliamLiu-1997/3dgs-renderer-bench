"""Convert configured PLY inputs to SOG v2, retaining SH3 and recording source/output hashes."""

import hashlib
import json
import subprocess
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / 'harness'
MANIFEST = ROOT / 'models/sog-manifest.json'
CONVERTER = ROOT / 'node_modules/@playcanvas/splat-transform'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda: file.read(1 << 24), b''):
            digest.update(block)
    return digest.hexdigest()


def record(model, info, elapsed=None):
    source = (HARNESS / info['path']).resolve()
    output = (HARNESS / info['path']).with_suffix('.sog')
    with zipfile.ZipFile(output) as archive:
        meta = json.loads(archive.read('meta.json'))
        assert archive.testzip() is None, output
    assert meta['version'] == 2 and meta['count'] == info['count'] and meta['shN']['bands'] == 3, output
    return {
        'model': model,
        'sourceSha256': sha256(source),
        'file': output.name,
        'sha256': sha256(output),
        'bytes': output.stat().st_size,
        'splats': meta['count'],
        'version': meta['version'],
        'shBands': meta['shN']['bands'],
        'codebookEntries': meta['shN']['count'],
        'generator': meta['asset']['generator'],
        'shIterations': 10,
        'gpu': 0,
        'conversionSeconds': elapsed,
    }


def main():
    models = json.loads((HARNESS / 'config.json').read_text())['models']
    selected = sys.argv[1:] or list(models)
    unknown = set(selected) - models.keys()
    if unknown:
        raise SystemExit(f'Unknown models: {sorted(unknown)}')
    records = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    version = json.loads((CONVERTER / 'package.json').read_text())['version']
    for model in selected:
        info = models[model]
        source = HARNESS / info['path']
        output = source.with_suffix('.sog')
        old = records.get(model)
        if old and output.exists() and old['generator'] == f'splat-transform v{version}':
            if old['sourceSha256'] == sha256(source) and old['sha256'] == sha256(output):
                print('SKIP verified', output.name, flush=True)
                continue
        start = time.monotonic()
        # SOG v2 (3.8+ defaults to v3, which not every renderer reads); -w replaces an earlier conversion.
        subprocess.run(
            ['node', str(CONVERTER / 'bin/cli.mjs'), '-w', '-g', '0', '-i', '10', '--sog-version', '2']
            + [str(source), str(output)],
            cwd=ROOT,
            check=True,
        )
        records[model] = record(model, info, time.monotonic() - start)
        MANIFEST.write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
