"""Check raw harness runs against the protocol in harness/config.json and write outputs/validation.json.

Flags: --<model> limits the models, --single expects one round, --partial skips completeness and
execution-order checks.
"""

import datetime
import json
import math
import sys
from zoneinfo import ZoneInfo

from common import (
    FRAME_METRIC,
    OUTPUTS,
    TIME_ZONE,
    expected_parameters,
    frame_statistics,
    load_config,
    results_dir,
    run_files,
)

config = load_config()
folder = results_dir()
models = [m for m in config['models'] if '--' + m in sys.argv] or list(config['models'])
round_count = 1 if '--single' in sys.argv else 3
partial = '--partial' in sys.argv
backends = config['backends']
variants_for = {
    mode: ['sorted', 'stochastic'] if mode in config['stochasticBackends'] else ['sorted'] for mode in backends
}


def round_order(base, round):
    """Mirror of lab/config.js roundOrder."""
    shift = ((round - 1) // 2) % len(base)
    order = base[shift:] + base[:shift]
    return order[::-1] if round % 2 == 0 else order


expected = {f'{model}-{mode}-r{r}' for model in models for mode in backends for r in range(1, round_count + 1)}
actual = {f.stem for f in run_files(folder) if any(f.stem.startswith(model + '-') for model in models)}
if not partial:
    assert actual == expected, f'Missing: {sorted(expected - actual)}; extra: {sorted(actual - expected)}'


def check_case(name, mode, case, parameters):
    state = case['state']
    moving = case['moving']
    assert case['metric'] == FRAME_METRIC and case['variant'] in variants_for[mode], name
    assert case['framesInFlight'] == 1, name
    assert case['motionAmplitudeDegrees'] == (config['motionAmplitudeDegrees'] if moving else 0), name
    assert case['motionPeriodSeconds'] == config['motionPeriodSeconds'], name
    if moving:
        amplitude = math.radians(config['motionAmplitudeDegrees'])
        angles = [r['cameraAngle'] for r in case['rows']]
        assert abs(min(angles) - (case['angle'] - amplitude)) < 0.04, name
        assert abs(max(angles) - (case['angle'] + amplitude)) < 0.04, name
        for r in case['rows']:
            phase = r['motionSeconds'] * 2 * math.pi / config['motionPeriodSeconds']
            assert math.isclose(r['cameraAngle'], case['angle'] - amplitude * math.sin(phase), abs_tol=1e-9), name
    assert not case['errors'], name
    assert not case['memory']['unknownFormats'], (name, case['memory']['unknownFormats'])

    # Sampling windows and the frame statistics the page reported.
    duration = config['sampleSeconds']['moving' if moving else 'static'] * 1000
    rows = case['rows']
    assert case['warm']['frames'] > 0 and case['warm']['ms'] >= config['warmupSeconds'] * 1000, name
    assert case['elapsedMs'] >= duration and case['frames'] == len(rows) > 1, name
    assert all(math.isfinite(r['frameMs']) and r['frameMs'] > 0 for r in rows), name
    assert math.isclose(case['elapsedMs'], sum(r['frameMs'] for r in rows), rel_tol=1e-9), name
    assert all(
        math.isclose(b['startMs'] - a['startMs'], a['frameMs'], abs_tol=1e-6)
        for a, b in zip(rows, rows[1:], strict=False)
    ), name
    assert all('gpuMs' not in r and 'passes' not in r and 'completionMs' not in r for r in rows), name
    stats = frame_statistics([r['frameMs'] for r in rows])
    assert math.isclose(case['fps'] * case['frameMs']['mean'], 1000, rel_tol=1e-9), name
    assert math.isclose(case['fps'], stats['fps'], rel_tol=1e-9), name
    assert math.isclose(case['frameMs']['p50'], stats['frameP50'], rel_tol=1e-9), name
    assert math.isclose(case['frameMs']['p95'], stats['frameP95'], rel_tol=1e-9), name

    # Memory snapshot integrity.
    heap = case['heap']
    isolates = [heap['main'], *heap['workers']]
    assert case['memory']['gpuBytes'] > 0 and heap['usedSize'] > 0, name
    assert len({i['isolateId'] for i in isolates}) == len(isolates), name
    assert len(heap['workers']) == sum(w['alive'] for w in case['memory']['workers']), name
    assert all(i['usedSize'] > 0 and i['backingStorageSize'] >= 0 for i in isolates), name
    assert heap['usedSize'] == sum(i['usedSize'] for i in isolates), name
    assert heap['workerUsedSize'] == sum(i['usedSize'] for i in heap['workers']), name
    assert heap['workerBackingStorageSize'] == sum(i['backingStorageSize'] for i in heap['workers']), name
    assert heap['backingStorageSize'] == heap['main']['backingStorageSize'], name

    # Rendering state.
    assert state['stochastic'] == (case['variant'] == 'stochastic'), name
    assert state['sortRadial'] is (not mode.startswith('aholo-')), name
    assert matches(state['renderParameters'], parameters), name
    if mode.startswith('gsl'):
        assert state['spatialResolve'] is False, name
        assert state['fastSort'] is True and case['fast'] is True, name
        assert state['stochasticSort'] is True, name
        assert state['sortBits'] == (16 if case['variant'] == 'stochastic' else 24), name
    if mode == 'pc-gpu' and case['variant'] == 'stochastic':
        assert state['sorting'] == 'none' and state['dither'] == 'bluenoise', name
        assert state['spatialResolve'] is False and state['temporalResolve'] is False, name
    return len(rows)


def matches(actual, expected):
    """Expected settings, recursing into groups; floats may differ by rounding across languages."""
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(k in actual and matches(actual[k], v) for k, v in expected.items())
    if isinstance(expected, float):
        return math.isclose(actual, expected, rel_tol=1e-12)
    return actual == expected


def check_sort(name, mode, run, sort):
    if sort.get('protocol') == 'radix-sort-diagnostic-v1':
        assert mode.startswith('radix-') and sort['browser'] == run['browser'] and sort['warmupSamples'] == 4, name
        assert not sort['consoleErrors'], name
        assert sort['order'] == [m for m in run['order'] if m.startswith('radix-')], name
    if mode.startswith('gsl'):
        assert sort['fast'] is True, name
    assert len(sort['rows']) == 16, name
    for row in sort['rows']:
        if mode == 'aholo-gl':
            assert row['sortJobs'] and all(j['ms'] > 0 for j in row['sortJobs']), name
        elif mode in ['spark-gl', 'gsl-gl', 'pc-gl', 'radix-gl']:
            calls = [r for r in row['rpc'] if r['name'].startswith('sort')]
            assert calls and all(r['workerMs'] > 0 for r in calls), name
            assert row['sortJobs'] and all(j['ms'] > 0 for j in row['sortJobs']), name
        else:
            passes = [p for p in row['passes'] if p['stage'] == 'sort']
            assert passes and all(p['end'] > p['start'] for p in passes), name


def check_run(name, run):
    mode, initial = run['mode'], run['initial']
    state = initial['state']
    assert not run.get('failure'), (name, run.get('failure'))
    assert not run['consoleErrors'], (name, run['consoleErrors'])
    assert run['config'] == config, name
    assert initial['resolution'] == [config['width'], config['height']] and initial['dpr'] == config['dpr'], name
    assert state['sourceCount'] == config['models'][run['model']]['count'] and state['sh'] == 3, name
    assert len(run['order']) == len(set(run['order'])) and mode in run['order'], name
    assert state['sortRadial'] is (not mode.startswith('aholo-')), name
    parameters = expected_parameters(mode)
    assert matches(state['renderParameters'], parameters), name
    camera = config['models'][run['model']]
    assert initial['camera']['position'] == [a + b for a, b in zip(camera['target'], camera['offset'], strict=True)], (
        name
    )
    if mode.startswith('gsl'):
        assert state['reversedDepthBuffer'] is True, name
    if mode == 'spark-gl':
        assert 'ExtSplats' in state['sourceType'] and state['accumulatorExtended'], name
        assert state['lodEnabled'] is True and state['hasLodData'] is False, name
    if mode == 'viewer-gpu':
        assert state['engineVersion'] == config['versions']['playcanvas'], name
        assert state['engineCommit'] == config['commits']['playcanvas'], name
    if mode == 'gsl-gpu' or mode.startswith('radix-'):
        assert state['workingColorSpace'] == 'srgb' and state['outputColorSpace'] == 'srgb', name
    if mode == 'gsl-gpu':
        assert state['deviceConfiguration'] == 'three-default', name
        assert 'timestamp-query' in state['deviceFeatures'], name
        assert state['compatibilityMode'] == ('core-features-and-limits' not in state['deviceFeatures']), name
    expected_cases = {(v, m, view) for v in variants_for[mode] for m in [False, True] for view in ['main', 'second']}
    assert {(c['variant'], c['moving'], c['view']) for c in run['cases']} == expected_cases, name
    second = {'angle': 0, 'scale': 1, **camera['secondView']}
    for case in run['cases']:
        view = second if case['view'] == 'second' else {'angle': 0, 'scale': 1}
        assert (case['angle'], case['scale']) == (view['angle'], view['scale']), name
    assert len(run['cases']) == len(expected_cases) and len(run['sort']) == 1, name
    frames = sum(check_case(name, mode, case, parameters) for case in run['cases'])
    for sort in run['sort']:
        check_sort(name, mode, run, sort)
    return frames


frames = groups = sort_groups = 0
browsers, test_dates = set(), set()
initial_orders, execution, sort_execution, retried = {}, [], [], set()
for name in sorted(actual):
    run = json.loads((folder / (name + '.json')).read_text())
    frames += check_run(name, run)
    groups += len(run['cases'])
    sort_groups += len(run['sort'])
    browsers.add(run['browser'])
    test_dates.add(datetime.datetime.fromisoformat(run['started']).astimezone(ZoneInfo(TIME_ZONE)).date().isoformat())
    if not run.get('retry'):
        execution.append((run['started'], run['round'], run['model'], run['mode']))
    else:
        retried.add((run['round'], run['model'], run['mode']))
    sort_execution.extend(
        (s['measuredAt'], run['round'], run['model'], run['mode'])
        for s in run['sort']
        if s.get('protocol') == 'radix-sort-diagnostic-v1' and not run.get('retry')
    )
    # Every round derives its order from round one's order for the same model.
    model = run['model']
    if run['round'] == 1:
        assert initial_orders.setdefault(model, run['order']) == run['order'], name
    if model in initial_orders:
        assert run['order'] == round_order(initial_orders[model], run['round']), name

if not partial:
    expected_execution = [
        (r, model, mode)
        for r in range(1, round_count + 1)
        for model in config['models']
        if model in models
        for mode in round_order(initial_orders[model], r)
        if (r, model, mode) not in retried
    ]
    assert all(set(initial_orders[m]) == set(backends) for m in models)
    assert [entry[1:] for entry in sorted(execution)] == expected_execution, (
        'Execution order does not match the schedule'
    )
    if sort_execution:
        assert [entry[1:] for entry in sorted(sort_execution)] == [
            e for e in expected_execution if e[2].startswith('radix-')
        ], 'Radix sort supplement order mismatch'

summary = {
    'protocol': config['protocol'],
    'complete': actual == expected,
    'runs': len(actual),
    'performanceGroups': groups,
    'measuredFrames': frames,
    'sortGroups': sort_groups,
    'sortSamples': 16 * sort_groups,
    'frameMetric': FRAME_METRIC,
    'fpsMatchesMeanFrameInterval': True,
    'frameStatisticsRecomputedFromIntervals': True,
    'warmupSeconds': config['warmupSeconds'],
    'sampleSeconds': config['sampleSeconds'],
    'motionAmplitudeDegrees': config['motionAmplitudeDegrees'],
    'motionPeriodSeconds': config['motionPeriodSeconds'],
    'interleavedExecutionOrderVerified': not partial,
    'radixSortSupplementRuns': len(sort_execution),
    'radixDefaultSortBits': 24,
    'renderingSettingsAdjustedAsCloselyAsPossible': True,
    'allSortedCasesRadial': True,
    'fourViewsPerVariant': True,
    'stochasticBackends': config['stochasticBackends'],
    'gslStochasticFrontToBackSort': True,
    'sparkExtendedSourceAndAccumulator': True,
    'sparkDefaultLodWithoutHierarchy': True,
    'cameraMatchesConfig': True,
    'gslWebGPUViewerColorSpace': 'srgb',
    'consoleErrors': 0,
    'unknownGpuFormats': 0,
    'browsers': sorted(browsers),
    'physicalResolution': [config['width'], config['height']],
    'dpr': config['dpr'],
    'testDates': sorted(test_dates),
    'testTimeZone': TIME_ZONE,
    'memoryMetric': 'JS heap + ArrayBuffer/external backing + Worker WASM accounting sum; explicit GPU allocation separate',
}
print(json.dumps(summary, ensure_ascii=False, indent=2))
if not partial:
    suffix = ('-' + '-'.join(models) if len(models) < len(config['models']) else '') + (
        '-single' if round_count == 1 else ''
    )
    OUTPUTS.mkdir(exist_ok=True)
    (OUTPUTS / f'validation{suffix}.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
