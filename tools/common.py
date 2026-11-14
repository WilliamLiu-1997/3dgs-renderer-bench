"""Paths, backend metadata and frame statistics shared by the report tools."""

import json
import math
import os
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
HARNESS = ROOT / 'harness'
OUTPUTS = ROOT / 'outputs'
REPORT = ROOT / 'report'
PUBLISHED_RESULTS = HARNESS / 'results'
TIME_ZONE = 'Australia/Sydney'
FRAME_METRIC = 'frame-interval-ms'

# Display metadata in harness/config.json backend order. `name` is used by the HTML report,
# `short` by the overview chart.
BACKEND_STYLE = {
    'spark-gl': {'name': 'Spark · WebGL2', 'short': 'Spark / WebGL2', 'color': '#a75e2d'},
    'radix-gpu': {'name': 'Radix · WebGPU', 'short': 'Radix / WebGPU', 'color': '#b59527'},
    'radix-gl': {'name': 'Radix · WebGL2', 'short': 'Radix / WebGL2', 'color': '#6b8b9d'},
    'gsl-gpu': {'name': 'Gaussian Splat Lite · WebGPU', 'short': 'Gaussian Splat Lite / WebGPU', 'color': '#7454a1'},
    'gsl-gl': {'name': 'Gaussian Splat Lite · WebGL2', 'short': 'Gaussian Splat Lite / WebGL2', 'color': '#3976ae'},
    'viewer-gpu': {'name': 'SuperSplat Viewer · WebGPU', 'short': 'SuperSplat Viewer / WebGPU', 'color': '#b24b72'},
    'pc-gpu': {'name': 'PlayCanvas · WebGPU', 'short': 'PlayCanvas / WebGPU', 'color': '#558c29'},
    'pc-gl': {'name': 'PlayCanvas · WebGL2', 'short': 'PlayCanvas / WebGL2', 'color': '#287c62'},
    'aholo-gl': {'name': 'Aholo Viewer · WebGL2', 'short': 'Aholo Viewer / WebGL2', 'color': '#4a4f57'},
}
SCENARIOS = ['moving', 'static', 'close-moving', 'close']


def load_config():
    config = json.loads((HARNESS / 'config.json').read_text())
    if list(BACKEND_STYLE) != config['backends']:
        raise SystemExit('tools/common.py BACKEND_STYLE must list harness/config.json backends in order')
    return config


def results_dir():
    return (HARNESS / os.environ.get('RESULTS_DIR', 'results-current')).resolve()


def source_format(run):
    return run.get('format', 'ply')


def run_pair(run):
    return source_format(run), run['model'], run['mode']


def load_failure(run):
    return (
        source_format(run) == 'sog'
        and run.get('failure')
        and run.get('debug', {}).get('phase') == 'loading'
        and not run.get('initial')
        and not run['cases']
        and not run['sort']
    )


def exclusions(runs):
    # A renderer/model pair needs all rounds to participate in ranking.
    return {
        run_pair(run): {
            'format': source_format(run),
            'model': run['model'],
            'mode': run['mode'],
            'reason': run['failure'],
        }
        for run in runs
        if load_failure(run)
    }


def run_name(model, mode, round, format):
    return f'{model}{"-" + format if format != "ply" else ""}-{mode}-r{round}'


def check_config(run, config):
    if run['config'] != config:
        raise ValueError('Stale configuration: ' + run['name'])
    if source_format(run) not in config['formats']:
        raise ValueError('Unknown input format: ' + run['name'])


def run_files(folder):
    """Run JSON files, skipping macOS AppleDouble files on external volumes."""
    return sorted(p for p in folder.glob('*.json') if not p.name.startswith('._'))


def scenario_name(case):
    if case['view'] == 'second':
        return 'close-moving' if case['moving'] else 'close'
    return 'moving' if case['moving'] else 'static'


def percentile(values, p):
    return float(np.percentile(values, p)) if len(values) else None


def median(values):
    values = [v for v in values if v is not None and math.isfinite(v)]
    return float(np.median(values)) if values else None


def frame_statistics(intervals):
    """Mirror of lab/frame-timing.js frameStatistics, recomputed from raw intervals."""
    elapsed = float(sum(intervals))
    return {
        'frames': len(intervals),
        'elapsedMs': elapsed,
        'fps': 1000 * len(intervals) / elapsed,
        'frameP50': percentile(intervals, 50),
        'frameP95': percentile(intervals, 95),
    }


def expected_parameters(mode):
    """Effective renderer settings each backend must report (see PRESETS in lab/config.js)."""
    shared = {'preBlurAmount': 0.3, 'blurAmount': 0, 'clipXY': 1.25, 'focalAdjustment': 2, 'minAlpha': 1 / 255}
    if mode == 'spark-gl':
        return {**shared, 'minPixelRadius': 2, 'maxPixelRadius': 512}
    if mode.startswith('gsl'):
        return {**shared, 'minPixelRadius': 1}
    if mode.startswith('aholo'):
        return {
            'packType': 'Compressed',
            'pack': {
                'highPrecisionEnabled': True,
                'precalculateEnabled': True,
                'cameraRelativeEnabled': False,
                'repackEnabled': True,
            },
            'raster': {
                'preBlurAmount': 0.3,
                'blurAmount': 0,
                'focalAdjustment': 2,
                'maxStdDev': math.sqrt(8),
                'maxPixelRadius': 512,
                'detailCullingThreshold': math.pi * (1 - math.exp(-4)) * 0.5,
                'detailCullingAlphaEnabled': False,
            },
            'sort': {
                'radial': True,
                'minIntervalMs': 0,
                'sortCameraDistance': 1e-4,
                'sortCameraCoorient': 1 - 1e-6,
                'sortSplatDistance': 1e-4,
                'sortSplatCoorient': 1 - 1e-6,
            },
        }
    if mode.startswith('radix'):
        return {
            'method': 'ewa',
            'sortBits': 24,
            'sourceType': 'extSplats',
            'sortMode': 'gpu' if mode == 'radix-gpu' else 'cpu',
        }
    return {
        'minPixelSize': 2,
        'minContribution': 0,
        'alphaClipForward': 1 / 255,
        'antiAlias': False,
        'colorUpdateAngle': 0,
        'radialSorting': True,
        'dataFormat': 'large',
    }
