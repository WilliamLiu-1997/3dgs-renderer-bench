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
    'starting backend within each format. Full original PLY/SH3 inputs and matched SOG/SH3 conversions, matched cameras and resolution, rendering settings adjusted '
    'as closely as possible, radial sorting in all depth-sorted groups and native caching. Every backend measures '
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


def copy_result(source, target):
    if source.resolve() == target.resolve() or (target.exists() and source.read_bytes() == target.read_bytes()):
        return
    shutil.copy2(source, target)


def manifest(config, runs):
    models = []
    sog_inputs = json.loads((OUTPUTS / 'benchmark-data.json').read_text())['sogInputs']
    for key, model in config['models'].items():
        path = (HARNESS / model['path']).resolve()
        print('Hashing', path.name)
        source_hash = sha256(path)
        sog = sog_inputs[key]
        if sog['sourceSha256'] != source_hash or sog['sha256'] != sha256((HARNESS / model['path']).with_suffix('.sog')):
            raise SystemExit('SOG input hashes do not match the converted model: ' + key)
        models.append(
            {
                'model': key,
                'file': path.name,
                'bytes': path.stat().st_size,
                'splats': model['count'],
                'sha256': source_hash,
                'camera': {'target': model['target'], 'offset': model['offset']},
            }
        )
    dates = {
        datetime.datetime.fromisoformat(r['started']).astimezone(ZoneInfo(TIME_ZONE)).date().isoformat()
        for r in runs
        if r.get('started')
    }
    return {
        'hardware': hardware(),
        'models': models,
        'sogInputs': sog_inputs,
        'cohorts': json.loads((OUTPUTS / 'benchmark-data.json').read_text())['cohorts'],
        'config': config,
        'protocol': PROTOCOL,
        'testDates': sorted(dates),
        'testTimeZone': TIME_ZONE,
        'browser': sorted({r['browser'] for r in runs if r.get('browser')}),
    }


def main():
    config = load_config()
    source = results_dir()
    files = run_files(source)
    runs = [json.loads(f.read_text()) for f in files]
    validation = json.loads((OUTPUTS / 'validation.json').read_text())
    if (
        not validation['complete']
        or validation['protocol'] != config['protocol']
        or validation.get('formats') != config['formats']
        or validation['records'] != len(runs)
    ):
        raise SystemExit('Publish requires a complete validation of the current protocol')
    input_manifest = manifest(config, runs)

    # Raw results: every run JSON, the retried originals and activity log, plus the round-one captures. The published
    # folder mirrors this run, so records of an earlier cohort do not linger.
    PUBLISHED_RESULTS.mkdir(exist_ok=True)
    keep = {f.name for f in files} | {'activity.log', 'outliers'}
    keep |= {c.name for c in source.glob('*-r1-*.png') if not c.name.endswith('-failure.png')}
    keep_outliers = {f.name for f in run_files(source / 'outliers')} if (source / 'outliers').is_dir() else set()
    # macOS AppleDouble files (._*) on external volumes disappear with their data file.
    for f in list(PUBLISHED_RESULTS.iterdir()):
        if not f.name.startswith('._') and f.name not in keep:
            f.unlink(missing_ok=True)
    for f in list((PUBLISHED_RESULTS / 'outliers').glob('*')) if (PUBLISHED_RESULTS / 'outliers').is_dir() else []:
        if not f.name.startswith('._') and f.name not in keep_outliers:
            f.unlink(missing_ok=True)
    for f in files:
        copy_result(f, PUBLISHED_RESULTS / f.name)
    if (source / 'outliers').is_dir():
        (PUBLISHED_RESULTS / 'outliers').mkdir(exist_ok=True)
        for f in run_files(source / 'outliers'):
            copy_result(f, PUBLISHED_RESULTS / 'outliers' / f.name)
    if (source / 'activity.log').exists():
        copy_result(source / 'activity.log', PUBLISHED_RESULTS / 'activity.log')
    for capture in source.glob('*-r1-*.png'):
        if not capture.name.startswith('._') and not capture.name.endswith('-failure.png'):
            copy_result(capture, PUBLISHED_RESULTS / capture.name)

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
    (REPORT / 'input-manifest.json').write_text(json.dumps(input_manifest, ensure_ascii=False, indent=2) + '\n')
    print(
        f'Published {len(files)} records to {PUBLISHED_RESULTS.relative_to(HARNESS.parent)} and the report to report/'
    )


if __name__ == '__main__':
    main()
