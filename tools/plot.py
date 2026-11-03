"""Overview chart (PNG + SVG) of frame-interval P50 from outputs/benchmark-data.json."""

import json

import matplotlib
import numpy as np
from common import BACKEND_STYLE, FRAME_METRIC, OUTPUTS, median

matplotlib.use('Agg')
import matplotlib.pyplot as plt  # noqa: E402

INK, MUTED, LINE, BACKGROUND, BEST = '#182327', '#657071', '#d4d8d2', '#f6f5f1', '#17613b'
SCENARIOS = [
    ('moving', 'Moving · main view'),
    ('static', 'Static · main view'),
    ('close-moving', 'Moving · closer side view'),
    ('close', 'Static · closer side view'),
]


def main():
    data = json.loads((OUTPUTS / 'benchmark-data.json').read_text())
    if data.get('frameMetric') != FRAME_METRIC:
        raise SystemExit('Frame-interval measurements are required')
    plt.rcParams.update(
        {
            'font.family': 'DejaVu Sans',
            'font.size': 10,
            'axes.spines.top': False,
            'axes.spines.right': False,
            'axes.spines.left': False,
            'axes.facecolor': BACKGROUND,
            'figure.facecolor': BACKGROUND,
            'savefig.facecolor': BACKGROUND,
            'axes.labelcolor': INK,
            'text.color': INK,
            'xtick.color': MUTED,
            'ytick.color': INK,
        }
    )
    backends = [b['id'] for b in data['backends']]
    stochastic = sorted({c['mode'] for c in data['cases'] if c['variant'] == 'stochastic'}, key=backends.index)
    groups = [
        ('sorted', 'Depth-sorted rendering', backends, 0),
        ('stochastic', 'Raw stochastic rendering', stochastic, len(backends) + 1.2),
    ]
    models = [(k, v) for k, v in data['models'].items() if any(c['model'] == k for c in data['cases'])]
    fig, axes = plt.subplots(4, len(models), figsize=(9 * len(models), 26), squeeze=False)
    fig.subplots_adjust(left=0.15, right=0.97, top=0.88, bottom=0.07, wspace=0.55, hspace=0.42)
    for col, (model, info) in enumerate(models):
        for row, (scenario, view) in enumerate(SCENARIOS):
            ax = axes[row, col]
            extents, annotations, positions, tick_labels = [], [], [], []
            for variant, group, modes, offset in groups:
                cases = {
                    mode: [
                        c
                        for c in data['cases']
                        if c['model'] == model
                        and c['mode'] == mode
                        and c['precision'] == 'default'
                        and c['scenario'] == scenario
                        and c['variant'] == variant
                    ]
                    for mode in modes
                }
                runs = [[c['frameP50'] for c in cases[m]] for m in modes]
                values = [median(r) for r in runs]
                low = [v - min(r) for v, r in zip(values, runs, strict=True)]
                high = [max(r) - v for v, r in zip(values, runs, strict=True)]
                pos = np.arange(len(modes)) + offset
                ax.barh(
                    pos,
                    values,
                    color=[BACKEND_STYLE[m]['color'] for m in modes],
                    height=0.62,
                    zorder=3,
                    xerr=[low, high],
                    error_kw={'ecolor': INK, 'capsize': 2, 'lw': 1},
                )
                ax.text(0, offset - 0.85, group, fontsize=9, color=MUTED, va='center')
                best = min(round(v, 2) for v in values)
                annotations.extend((y, v, e, round(v, 2) == best) for y, v, e in zip(pos, values, high, strict=True))
                extents.extend(v + e for v, e in zip(values, high, strict=True))
                positions.extend(pos)
                tick_labels.extend(BACKEND_STYLE[m]['short'] for m in modes)
            maximum = max(extents)
            ax.set_yticks(positions, tick_labels, fontsize=9)
            ax.set_ylim(len(backends) + 4, -1.6)
            ax.tick_params(axis='y', length=0, pad=8)
            ax.grid(axis='x', alpha=0.2, zorder=0)
            ax.set_xlabel('Frame interval P50 (ms) · lower is better')
            ax.set_title(
                f'{view}\n{info["name"]} / {info["count"]:,} splats', loc='left', fontweight='bold', fontsize=13, pad=20
            )
            ax.set_xlim(0, maximum * 1.38)
            ax.axhline(len(backends) + 0.1, color=LINE, lw=0.8)
            for y, value, error, best in annotations:
                label = f'{value:.2f} ms' + ('  BEST' if best else '')
                ax.text(
                    value + error + maximum * 0.02,
                    y,
                    label,
                    va='center',
                    fontsize=9,
                    fontweight='bold' if best else 'normal',
                    color=BEST if best else INK,
                )
    dates = ' – '.join(dict.fromkeys([data['testDates'][0], data['testDates'][-1]]))
    versions = data['versions']
    fig.text(0.045, 0.966, '3DGS Renderer Bench', fontsize=30, weight='bold')
    fig.text(
        0.045,
        0.947,
        f'Tested {dates} ({data["testTimeZone"]}) · Gaussian Splat Lite {versions["gsl"]} · Spark {versions["spark"]} · '
        f'PlayCanvas {versions["playcanvas"]} · SuperSplat Viewer {versions["viewer"]} · Radix {versions["radix"]}',
        fontsize=11,
        color=MUTED,
    )
    fig.text(
        0.045,
        0.934,
        'Apple M5 Pro · 16 GPU cores · 48 GiB · 3024 × 1964 physical pixels · DPR 2 · Full PLY / SH3',
        fontsize=11,
        color=MUTED,
    )
    notes = [
        'Median of independent runs; whiskers show run min/max. One GPU frame in flight. Sorted and raw stochastic groups have separate winners.',
        'Aligned rendering presets; real-time orbit ±45° / 8 s. Raw stochastic: no spatial resolve or temporal accumulation.',
        'Gaussian Splat Lite retains default 16-bit front-to-back stochastic sorting. PlayCanvas raw stochastic skips depth sorting.',
    ]
    for i, note in enumerate(notes):
        fig.text(0.045, 0.045 - 0.013 * i, note, fontsize=10, color=MUTED)
    for extension in ['png', 'svg']:
        fig.savefig(OUTPUTS / f'benchmark-overview.{extension}', dpi=180)
    plt.close(fig)
    svg = OUTPUTS / 'benchmark-overview.svg'
    svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines()) + '\n')


if __name__ == '__main__':
    main()
