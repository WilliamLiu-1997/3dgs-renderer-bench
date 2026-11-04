"""Publish a validated run: outputs/ -> report/, raw results -> harness/results/, refreshed input manifest.

Run after validate.py, analyze.py and plot.py (tools/report.py --publish does all four).
"""

import datetime
import hashlib
import json
import platform
import shutil
import subprocess
from zoneinfo import ZoneInfo

from common import HARNESS, OUTPUTS, PUBLISHED_RESULTS, REPORT, TIME_ZONE, load_config, results_dir, run_files

ARTIFACTS = [
    'benchmark-data.json',
    'benchmark-summary.csv',
    'benchmark-overview.png',
    'benchmark-overview.svg',
    'validation.json',
]
# The report lives in report/; its full-size captures are the published raw results.
IMAGE_PREFIX = '../harness/results/'
PROTOCOL = (
    'Three fresh Chrome processes per backend and model; paired forward/reverse backend order with a rotating '
    'starting backend. Full original PLY/SH3 inputs, matched cameras and resolution, rendering settings adjusted '
    'as closely as possible, radial sorting in all depth-sorted groups except Aholo Viewer (view depth only) and native caching. Every backend measures '
    'static and moving (±45°, 8 s real-time orbit) main and second views (a closer side view; WillaGlobalPoland: its entrance side); PlayCanvas WebGPU and both Gaussian Splat Lite '
    'backends add raw stochastic rendering without spatial resolve or temporal accumulation. Frames are sampled '
    'with the lab sampler and one GPU frame in flight: each frame is submitted after the '
    'previous frame completes on the GPU; samples are intervals between submissions, FPS = frames / sampled time, '
    'with P50/P95 frame intervals. '
    'Sort latency uses a separate diagnostic with explicit completion. Memory records post-GC main and live '
    'Worker V8 heaps, external backing and WASM capacity.'
)


def sha256(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 24), b''):
            digest.update(block)
    return digest.hexdigest()


def hardware():
    if platform.system() != 'Darwin':
        return {'machine': platform.machine(), 'system': platform.platform()}
    info = json.loads(subprocess.check_output(['system_profiler', 'SPHardwareDataType', '-json']))
    item = info['SPHardwareDataType'][0]
    keys = ['machine_name', 'machine_model', 'chip_type', 'number_processors', 'physical_memory']
    return {**{k: item.get(k) for k in keys}, 'macOS': platform.mac_ver()[0]}


def manifest(config, runs):
    models = []
    for key, model in config['models'].items():
        path = (HARNESS / model['path']).resolve()
        print('Hashing', path.name)
        models.append(
            {
                'model': key,
                'file': path.name,
                'bytes': path.stat().st_size,
                'splats': model['count'],
                'sha256': sha256(path),
                'camera': {'target': model['target'], 'offset': model['offset']},
            }
        )
    dates = {
        datetime.datetime.fromisoformat(r['started']).astimezone(ZoneInfo(TIME_ZONE)).date().isoformat() for r in runs
    }
    return {
        'hardware': hardware(),
        'models': models,
        'config': config,
        'protocol': PROTOCOL,
        'testDates': sorted(dates),
        'testTimeZone': TIME_ZONE,
        'browser': sorted({r['browser'] for r in runs}),
    }


def main():
    config = load_config()
    source = results_dir()
    files = run_files(source)
    runs = [json.loads(f.read_text()) for f in files]
    validation = json.loads((OUTPUTS / 'validation.json').read_text())
    if not validation['complete'] or validation['protocol'] != config['protocol']:
        raise SystemExit('Publish requires a complete validation of the current protocol')

    # Raw results: every run JSON, the retried originals and activity log, plus the round-one captures.
    shutil.rmtree(PUBLISHED_RESULTS, ignore_errors=True)
    PUBLISHED_RESULTS.mkdir()
    for f in files:
        shutil.copy2(f, PUBLISHED_RESULTS / f.name)
    if (source / 'outliers').is_dir():
        (PUBLISHED_RESULTS / 'outliers').mkdir()
        for f in run_files(source / 'outliers'):
            shutil.copy2(f, PUBLISHED_RESULTS / 'outliers' / f.name)
    if (source / 'activity.log').exists():
        shutil.copy2(source / 'activity.log', PUBLISHED_RESULTS / 'activity.log')
    for capture in source.glob('*-r1-*.png'):
        if not capture.name.startswith('._') and not capture.name.endswith('-failure.png'):
            shutil.copy2(capture, PUBLISHED_RESULTS / capture.name)

    REPORT.mkdir(exist_ok=True)
    for name in ARTIFACTS:
        shutil.copy2(OUTPUTS / name, REPORT / name)
    data = json.loads((REPORT / 'benchmark-data.json').read_text())
    for image in data['images']:
        image['path'] = image['path'].replace('images/', IMAGE_PREFIX, 1)
    (REPORT / 'benchmark-data.json').write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    html = (OUTPUTS / '3DGS-Renderer-Bench.html').read_text()
    html = html.replace('"path":"images/', f'"path":"{IMAGE_PREFIX}').replace('href="harness/', 'href="../harness/')
    (REPORT / '3DGS-Renderer-Bench.html').write_text(html)
    (REPORT / 'input-manifest.json').write_text(json.dumps(manifest(config, runs), ensure_ascii=False, indent=2) + '\n')
    print(f'Published {len(files)} runs to {PUBLISHED_RESULTS.relative_to(HARNESS.parent)} and the report to report/')


if __name__ == '__main__':
    main()
