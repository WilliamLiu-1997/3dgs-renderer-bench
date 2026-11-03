"""Summarise raw harness runs into outputs/: report HTML, summary JSON/CSV and round-one captures."""

import base64
import csv
import datetime
import io
import json
import math
import shutil
from zoneinfo import ZoneInfo

import numpy as np
from common import (
    BACKEND_STYLE,
    FRAME_METRIC,
    OUTPUTS,
    ROOT,
    TIME_ZONE,
    frame_statistics,
    load_config,
    percentile,
    results_dir,
    run_files,
    scenario_name,
)
from PIL import Image

METRICS = {
    'fps': 'Per-run frames / sampled time (1000 / mean interval between consecutive animation-frame callbacks); rendering-loop throughput, not screen-present FPS',
    'frameP50': 'Per-run 50th percentile of the same frame intervals, milliseconds',
    'frameP95': 'Per-run 95th percentile of the same frame intervals, milliseconds',
    'cpuMemoryMiB': 'Sum of main + live Worker JS heaps, main + Worker ArrayBuffer/external backing storage, and Worker WASM capacity, MiB; accounting sum, not deduplicated physical memory',
    'gpuMiB': 'Explicit live GPU resource capacity excluding timing-query buffers, MiB; not physical VRAM',
    'workerP50': 'Native Worker sort execution, excluding message transfer, milliseconds',
    'rpcP50': 'Sort Worker request-to-response time including message transfer, milliseconds',
    'asyncP50': 'Native asynchronous sort completion; Radix includes GPU key projection/readback and Worker sort delivery, milliseconds',
    'gpuSortP50': 'First-to-last native GPU radix pass span, milliseconds',
    'memoryAggregation': 'Sum CPU components within each snapshot first, then take the maximum across sorted cases per run and median across three runs; GPU is aggregated separately',
}
# JavaScript and Python percentiles both interpolate linearly; allow only float noise.
TOLERANCE = 1e-9


def mib(value):
    return value / 2**20 if value is not None else None


def cpu_memory_mib(case):
    heap = case['heap']
    return mib(
        heap['usedSize']
        + heap['backingStorageSize']
        + heap['workerBackingStorageSize']
        + case['memory']['workerWasmBytes']
    )


def sort_span(row):
    passes = [p for p in row.get('passes', []) if p['stage'] == 'sort']
    return (max(p['end'] for p in passes) - min(p['start'] for p in passes)) / 1e6 if passes else None


def check_reported(name, case, stats):
    """The page computed the same statistics in JavaScript; they must agree exactly."""
    reported = {
        'fps': case['fps'],
        'frameP50': case['frameMs']['p50'],
        'frameP95': case['frameMs']['p95'],
    }
    for key, value in reported.items():
        if not math.isclose(value, stats[key], rel_tol=TOLERANCE, abs_tol=TOLERANCE):
            raise SystemExit(f'{name}: {key} mismatch (page {value}, recomputed {stats[key]})')


def case_row(run, case, config):
    rows = case['rows']
    stats = frame_statistics([r['frameMs'] for r in rows])
    check_reported(run['name'], case, stats)
    sort_rpc = [r for r in case['rpc'] if r['name'].startswith('sort')]
    return {
        'model': run['model'],
        'mode': run['mode'],
        'round': run['round'],
        'precision': 'full' if case['fast'] is False else 'default',
        'scenario': scenario_name(case),
        'variant': case['variant'],
        'n': stats['frames'],
        'visibleOrActive': case['visible'],
        'cpuP50': percentile([r['cpuSubmitMs'] for r in rows], 50),
        **{k: v for k, v in stats.items() if k not in ('frames', 'elapsedMs')},
        'gpuMiB': mib(case['memory']['gpuBytes']),
        'cpuMemoryMiB': cpu_memory_mib(case),
        'workerP50': percentile([r['workerMs'] for r in sort_rpc if r['workerMs'] is not None], 50),
        'asyncP50': percentile([j['ms'] for j in case['sortJobs']], 50),
        'rpcP50': percentile([r['roundTripMs'] for r in sort_rpc], 50),
    }


def sort_row(run, sort):
    rpc = [call for row in sort['rows'] for call in row['rpc'] if call['name'].startswith('sort')]
    jobs = [job for row in sort['rows'] for job in row['sortJobs']]
    spans = [sort_span(r) for r in sort['rows']]
    return {
        'model': run['model'],
        'mode': run['mode'],
        'round': run['round'],
        'precision': 'full' if sort['fast'] is False else 'default',
        'workerP50': percentile([r['workerMs'] for r in rpc if r['workerMs'] is not None], 50),
        'rpcP50': percentile([r['roundTripMs'] for r in rpc], 50),
        'asyncP50': percentile([j['ms'] for j in jobs], 50),
        'gpuSortP50': percentile([s for s in spans if s is not None], 50),
        'gpuSortPassSumP50': percentile([r['gpuSortMs'] for r in sort['rows'] if r.get('gpuSortMs', 0) > 0], 50),
        'cpuUpdateP50': percentile([r['updateMs'] for r in sort['rows']], 50),
        'gpuIsolation': sort['gpuIsolation'],
        'measuredAt': sort.get('measuredAt', run['started']),
        'diagnosticProtocol': sort.get('protocol', 'native-sort-diagnostic'),
    }


def capture_images(run, folder, data):
    """Round-one captures: full PNG, embedded thumbnail and the change against normal sorting."""
    reference = np.asarray(Image.open(folder / f'{run["name"]}-sorted.png').convert('RGB'), dtype=np.float32)
    variants = sorted({c['variant'] for c in run['cases']}, key=lambda v: v != 'sorted')
    for variant in variants:
        source = folder / f'{run["name"]}-{variant}.png'
        if not source.exists():
            continue
        shutil.copy2(source, OUTPUTS / 'images' / source.name)
        image = Image.open(source).convert('RGB')
        thumbnail = image.copy()
        thumbnail.thumbnail((1280, 832))
        encoded = io.BytesIO()
        thumbnail.save(encoded, format='JPEG', quality=88)
        data['images'].append(
            {
                'model': run['model'],
                'mode': run['mode'],
                'variant': variant,
                'path': 'images/' + source.name,
                'thumb': 'data:image/jpeg;base64,' + base64.b64encode(encoded.getvalue()).decode(),
            }
        )
        delta = np.asarray(image, dtype=np.float32) - reference
        mse = float(np.mean(delta**2))
        data['quality'].append(
            {
                'model': run['model'],
                'mode': run['mode'],
                'variant': variant,
                'mae': float(np.mean(abs(delta))),
                'psnr': 10 * math.log10(255**2 / mse) if mse else None,
            }
        )


def main():
    config = load_config()
    folder = results_dir()
    files = run_files(folder)
    if not files:
        raise SystemExit(f'No runs in {folder}')
    OUTPUTS.mkdir(exist_ok=True)
    shutil.rmtree(OUTPUTS / 'images', ignore_errors=True)
    (OUTPUTS / 'images').mkdir()
    data = {
        'generated': datetime.datetime.now().astimezone().isoformat(timespec='seconds'),
        'frameMetric': FRAME_METRIC,
        'protocol': config['protocol'],
        'sampleSeconds': config['sampleSeconds'],
        'warmupSeconds': config['warmupSeconds'],
        'metrics': METRICS,
        'backends': [{'id': mode, **BACKEND_STYLE[mode]} for mode in config['backends']],
        'models': config['models'],
        'commits': config.get('commits', {}),
        'versions': config['versions'],
        'rounds': 0,
        'cases': [],
        'sort': [],
        'memory': [],
        'images': [],
        'quality': [],
        'runs': [],
    }
    for file in files:
        run = json.loads(file.read_text())
        if run['config'] != config:
            raise SystemExit('Stale configuration: ' + file.name)
        if run.get('failure'):
            print('FAILED', file.name, run['failure'])
            continue
        initial = run['initial']
        data['browser'] = run['browser']
        data['rounds'] = max(run['round'], data['rounds'])
        data['runs'].append(
            {
                'name': run['name'],
                'model': run['model'],
                'mode': run['mode'],
                'round': run['round'],
                'started': run['started'],
                'loadMs': initial['loadMs'],
                'gpuInfo': initial['gpuInfo'],
                'resolution': initial['resolution'],
                'dpr': initial['dpr'],
                'camera': initial['camera'],
                'renderParameters': initial['state'].get('renderParameters'),
                'sortRadial': initial['state'].get('sortRadial'),
                'order': run['order'],
            }
        )
        for case in run['cases']:
            if case.get('metric') != FRAME_METRIC:
                raise SystemExit('Wrong frame metric: ' + file.name)
            data['cases'].append(case_row(run, case, config))
        sorted_cases = [c for c in run['cases'] if c['variant'] == 'sorted']
        data['memory'].append(
            {
                'model': run['model'],
                'mode': run['mode'],
                'round': run['round'],
                'precision': 'default',
                'scenario': 'memory',
                'gpuMiB': max(mib(c['memory']['gpuBytes']) for c in sorted_cases),
                'cpuMemoryMiB': max(cpu_memory_mib(c) for c in sorted_cases),
            }
        )
        data['sort'].extend(sort_row(run, sort) for sort in run['sort'])
        if run['round'] == 1:
            capture_images(run, folder, data)
    if not all(
        r['resolution'] == [config['width'], config['height']] and r['dpr'] == config['dpr'] for r in data['runs']
    ):
        raise SystemExit('Unexpected capture resolution')
    data['testTimeZone'] = TIME_ZONE
    data['testDates'] = sorted(
        {
            datetime.datetime.fromisoformat(r['started']).astimezone(ZoneInfo(TIME_ZONE)).date().isoformat()
            for r in data['runs']
        }
    )

    summary = {**data, 'images': [{k: v for k, v in image.items() if k != 'thumb'} for image in data['images']]}
    (OUTPUTS / 'benchmark-data.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    with open(OUTPUTS / 'benchmark-summary.csv', 'w', encoding='utf-8-sig', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=data['cases'][0].keys(), lineterminator='\n')
        writer.writeheader()
        writer.writerows(data['cases'])
    template = (ROOT / 'tools/report_template.html').read_text()
    embedded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    (OUTPUTS / '3DGS-Renderer-Bench.html').write_text(template.replace('__BENCHMARK_DATA__', embedded))
    print('Generated', len(data['runs']), 'runs', len(data['cases']), 'cases', len(data['images']), 'images')
    for model in config['models']:
        for mode in config['backends']:
            rows = [
                r
                for r in data['cases']
                if r['model'] == model and r['mode'] == mode and r['scenario'] == 'moving' and r['variant'] == 'sorted'
            ]
            print(
                f'{model:9} {mode:11} moving',
                'FPS',
                [round(r['fps'], 1) for r in rows],
                'P95',
                [round(r['frameP95'], 1) for r in rows],
            )


if __name__ == '__main__':
    main()
