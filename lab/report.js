import { jsPDF } from 'jspdf';
import { BACKENDS, aggregate, isBest } from './config.js';

// PDF and preview share the same locally rendered pages.
export async function createReport(report) {
  const pages = [], width = 1120, height = 1584, margin = 64, bottom = height - 90;
  let canvas, ctx, y;
  const font = (size, weight = 400) => `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  const fmt = n => Number.isFinite(n) ? n.toFixed(2) : '—';
  const scenarioName = value => value === 'static' ? 'Static' : 'Orbit';
  function text(value, x, top, size = 16, color = '#222222', weight = 400, highlight = false) {
    ctx.font = font(size, weight);
    if (highlight) { ctx.fillStyle = '#e1eee5'; ctx.fillRect(x - 5, top - size - 2, ctx.measureText(String(value)).width + 10, size + 8); }
    ctx.fillStyle = color; ctx.fillText(String(value), x, top);
  }
  function wrap(value, size, maxWidth) {
    ctx.font = font(size);
    const rows = [];
    for (const line of String(value).split('\n')) {
      let row = '';
      for (const word of line.split(/(\s+)/)) {
        if (row && ctx.measureText(row + word).width > maxWidth) { rows.push(row.trimEnd()); row = ''; }
        if (!row && !word.trim()) continue;
        for (const char of word) {
          if (ctx.measureText(row + char).width > maxWidth) { rows.push(row); row = ''; }
          row += char;
        }
      }
      rows.push(row.trimEnd());
    }
    return rows;
  }
  function start() {
    canvas = document.createElement('canvas'); canvas.width = width * 1.5; canvas.height = height * 1.5;
    ctx = canvas.getContext('2d'); ctx.scale(1.5, 1.5); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    text('3DGS Renderer Bench', margin, 55, 16, '#222222', 600);
    ctx.fillStyle = '#dddddd'; ctx.fillRect(margin, 73, width - margin * 2, 1); y = 108;
  }
  function finish() {
    text('Frame completion time · Lower is better', margin, height - 40, 12, '#666666');
    text(pages.length + 1, width - margin - 18, height - 40, 12, '#666666');
    pages.push(canvas.toDataURL('image/jpeg', 0.94));
  }
  function ensure(space) {
    if (y + space <= bottom) return false;
    finish(); start(); return true;
  }
  function paragraph(value, size = 16, color = '#666666') {
    const rows = wrap(value, size, width - margin * 2), leading = size * 1.4;
    for (const row of rows) { ensure(leading); text(row, margin, y, size, color); y += leading; }
    y += 7;
  }
  function heading(title, reserve = 48) {
    ensure(50 + reserve);
    y += 12; text(title, margin, y, 22, '#222222', 600); y += 30;
  }
  function summaryHeader(scenario, continued = false) {
    heading(`${scenarioName(scenario)}${continued ? ' (continued)' : ''}`, 60);
    text('Renderer / backend', margin, y, 13, '#666666'); text('Rounds', 510, y, 13, '#666666');
    text('Frame P50 (ms)', 680, y, 13, '#666666'); text('Frame P95 (ms)', 875, y, 13, '#666666'); y += 29;
  }
  start();
  text('Benchmark results', margin, y, 28, '#222222', 600); y += 36;
  paragraph(report.source.name, 19, '#222222');
  paragraph(`${new Date(report.created).toLocaleString('en-GB')} · ${(report.source.bytes / 1048576).toFixed(1)} MiB · ${report.count?.toLocaleString() ?? '—'} splats · ${report.config.size.width} × ${report.config.size.height} pixels`, 14);
  paragraph(`${report.config.rounds} rounds · ${report.config.warmup}s warm-up · ${report.config.duration}s per scenario · ${report.complete ? 'Complete' : `Partial results. ${report.stopReason ?? 'See backend details.'}`}`, 14);
  for (const scenario of report.config.scenarios) {
    summaryHeader(scenario);
    const groups = report.config.backends.map(id => {
      return { backend: BACKENDS.find(b => b.id === id), ...aggregate(report.results.filter(r => r.backend === id), scenario) };
    });
    for (const { backend, rounds, metrics } of groups) {
      if (ensure(36)) summaryHeader(scenario, true);
      text(`${backend.name} / ${backend.backend}`, margin, y, 16);
      text(`${rounds}/${report.config.rounds}`, 510, y, 14, '#666666');
      if (metrics) {
        for (const [i, key] of ['p50', 'p95'].entries()) {
          const best = isBest(metrics[key], groups.map(g => g.metrics?.[key]));
          text(fmt(metrics[key]), 680 + i * 195, y, 16, best ? '#17613b' : '#222222', best ? 700 : 400, best);
        }
      } else text('Failed / incomplete', 680, y, 14, '#a8673c');
      y += 36;
    }
    y += 5;
  }
  paragraph('Green marks the lowest displayed value per metric and scenario; ties share the highlight. Values are medians across rounds. Fixed presets may produce different image quality. All backends use camera-axis depth sorting without post-processing.', 13);

  heading('Test conditions');
  paragraph(`${report.environment.platform} · ${report.environment.hardwareConcurrency} logical threads · Screen ${report.environment.screen.width} × ${report.environment.screen.height} · DPR ${report.environment.screen.dpr}`, 14);
  paragraph(report.environment.userAgent, 13);
  for (const [key, version] of Object.entries(report.config.versions)) {
    const source = report.config.versionSources[key];
    paragraph(`${key}: ${version}${version.includes('-') ? ' [prerelease]' : ''} · ${source.source}${source.url ? ` · ${source.url}` : ''}`, 13);
  }
  paragraph(`Camera · ${Object.entries(report.camera).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(' · ')}`, 13);
  if (report.source.conversion) paragraph(`SPZ → PLY: ${report.source.conversion.library}, ${fmt(report.source.conversion.ms)} ms, ${(report.source.conversion.outputBytes / 1048576).toFixed(1)} MiB output, SH retained. Converted locally; all backends load the same PLY. Native SPZ decoding is not compared.`, 13);

  heading('Measurement', 100);
  paragraph('Frame time runs from the draw call to a signaled WebGL fence (fenceSync / clientWaitSync) or GPUQueue.onSubmittedWorkDone() for WebGPU. The queue comes from the standard canvas configuration. One frame is in flight. requestAnimationFrame schedules samples outside the timer. CPU submission, GPU work and synchronization overhead are included; this is not isolated GPU execution time or display latency.', 13);
  paragraph('One backend runs at a time in a fresh iframe per round; order rotates or reverses. The draw call is renderer.render for Three.js, app.update + app.render for PlayCanvas. Camera updates are excluded. Native caching and async sorting remain active; pending worker results are not awaited. No LOD is generated. Orbit: ±45° (0.785 rad), 8 s period. Hiding the tab or resizing the window stops the test.', 13);
  paragraph('Load time runs from the public loader call to its completion signal, excluding package downloads, initialization, SPZ conversion and the first visible frame. Signals vary by library. Warm-up does not force sorting to finish. Dependencies and internal parameters are unchanged. Isolated GPU execution time, sort time and GPU memory are not measured.', 13);

  const roundColumns = [margin, 132, 420, 525, 650, 790, 920, 1010];
  function roundHeader(title, continued = false) {
    if (continued) heading(`${title} (continued)`, 60);
    const labels = ['Round', 'Started (UTC)', 'Scene', 'Load ms', 'Frame P50', 'Frame P95', 'Frames', 'Time s'];
    labels.forEach((label, i) => text(label, roundColumns[i], y, 12, '#666666')); y += 27;
  }
  for (const id of report.config.backends) {
    finish(); start();
    const backend = BACKENDS.find(b => b.id === id), rows = report.results.filter(r => r.backend === id);
    const title = `${backend.name} / ${backend.backend}`;
    const info = rows.find(r => r.info)?.info;
    const settings = info?.settings ?? report.config.parameters[backend.lib];
    const settingsX = 600, columnWidth = width - margin - settingsX;
    const settingsRows = Object.entries(settings).map(([key, value]) => wrap(`${key}: ${JSON.stringify(value)}`, 16, columnWidth));
    const image = rows.flatMap(r => r.cases).find(c => c.screenshot)?.screenshot;
    let img, imageHeight = 0;
    const imageWidth = width - margin * 2;
    if (image) { img = new Image(); img.src = image; await img.decode(); imageHeight = Math.min(600, imageWidth * img.height / img.width); }
    heading(title);
    paragraph(`Version ${report.config.versions[backend.lib]} · ${rows.filter(r => !r.error).length}/${report.config.rounds} rounds completed`, 14);
    if (img) {
      const w = imageHeight * img.width / img.height;
      ctx.drawImage(img, margin + (imageWidth - w) / 2, y, w, imageHeight);
      y += imageHeight + 20;
      text('Shared camera; capture time excluded.', margin, y, 12, '#666666'); y += 30;
    }
    text(info ? 'Effective public settings' : 'Requested settings', margin, y, 16, '#222222', 600); y += 28;
    for (let i = 0; i < settingsRows.length; i += 2) {
      const left = settingsRows[i], right = settingsRows[i + 1] ?? [];
      const rowHeight = Math.max(left.length, right.length) * 24;
      ensure(rowHeight);
      left.forEach((line, j) => text(line, margin, y + j * 24, 16, '#666666'));
      right.forEach((line, j) => text(line, settingsX, y + j * 24, 16, '#666666'));
      y += rowHeight;
    }
    y += 12;
    if (info) paragraph(`Module: ${info.moduleURL}`, 12);
    const methods = [...new Set(rows.flatMap(r => r.cases).map(c => c.completionMethod))];
    if (methods.length) paragraph(`Completion: ${methods.join(', ')}`, 12);
    if (ensure(58)) roundHeader(title, true); else roundHeader(title);
    for (const row of rows) {
      for (const c of row.cases) {
        if (ensure(27)) roundHeader(title, true);
        const values = [row.round, row.started, scenarioName(c.scenario), fmt(row.loadMs), fmt(c.frameMs.p50), fmt(c.frameMs.p95), c.frames, fmt(c.elapsedMs / 1000)];
        values.forEach((value, i) => text(value, roundColumns[i], y, i === 1 ? 12 : 14)); y += 27;
      }
      if (row.error) paragraph(`Round ${row.round} · ${row.started} · Load ${fmt(row.loadMs)} ms · Failed / stopped: ${row.error}`, 14, '#a8673c');
    }
    if (!rows.length) paragraph('This test was not run.', 14);
  }
  finish();
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  pdf.setProperties({ title: '3DGS Renderer Bench', subject: report.source.name, creator: '3DGS Renderer Bench', author: 'Local browser measurement' });
  pages.forEach((page, i) => { if (i) pdf.addPage(); pdf.addImage(page, 'JPEG', 0, 0, 210, 297); });
  return { blob: pdf.output('blob'), pages };
}
