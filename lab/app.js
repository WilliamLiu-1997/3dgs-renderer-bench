import { BACKENDS, PACKAGES, PRESETS, exactVersion, aggregate, isBest } from './config.js';
const $ = id => document.getElementById(id);
const repos = { spark: 'sparkjsdev/spark', playcanvas: 'playcanvas/engine', gsl: 'WilliamLiu-1997/Gaussian-Splat-Lite', three: 'mrdoob/three.js' };
const state = { file: null, source: null, pose: null, running: false, loading: false, cancelled: false, results: [], statuses: {}, report: null, frame: null, closing: null, pending: new Map(), serial: 0, conversion: null, download: null };
const versionCatalog = {};
let toastTimer, pdfURL, checkingVersions = false;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500); }
function status(message) { $('viewport-status').textContent = message; $('viewport-status').hidden = !message; }
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

for (const key of ['spark', 'gsl', 'playcanvas']) {
  const pkg = PACKAGES[key], name = BACKENDS.find(b => b.lib === key).name;
  const div = document.createElement('div'); div.className = 'package-card';
  div.innerHTML = `<div class="package-title"><strong>${name}</strong><a href="https://github.com/${repos[key]}/releases" target="_blank" rel="noopener" class="text-button">GitHub</a></div><label class="version-label">Version<input id="version-${key}" value="${pkg.version}" list="versions-${key}" autocomplete="off"><datalist id="versions-${key}"><option value="${pkg.version}">Bundled${pkg.version.includes('-') ? ' prerelease' : ''}</option></datalist></label><div class="backend-options">${BACKENDS.filter(b => b.lib === key).map(b => `<label><input type="checkbox" id="enable-${b.id}" checked>${b.backend}</label>`).join('')}</div>`;
  $('package-settings').append(div);
}
for (const backend of BACKENDS) $('preview-backend').add(new Option(`${backend.name} / ${backend.backend}`, backend.id));
$('preview-backend').value = 'gsl-gl';
$('version-three').value = PACKAGES.three.version;

function getConfig() {
  const versions = Object.fromEntries(Object.keys(PACKAGES).map(k => [k, $(`version-${k}`).value.trim()]));
  for (const [key, value] of Object.entries(versions)) if (!exactVersion(value)) throw Error(`${PACKAGES[key].name} requires an exact version (including beta / rc)`);
  const parameters = structuredClone(PRESETS);
  const backends = BACKENDS.filter(b => $(`enable-${b.id}`).checked).map(b => b.id);
  const [width, height] = $('resolution').value.split('x').map(Number);
  return { versions, versionSources: Object.fromEntries(Object.entries(versions).map(([k, v]) => [k, versionCatalog[k]?.find(entry => entry.version === v) ?? { version: v, source: 'manual / bundled' }])), parameters, size: { width, height }, rounds: +$('rounds').value, duration: +$('duration').value, warmup: +$('warmup').value, scenarios: ['static', 'moving'].filter(id => $(id).checked), backends };
}
function updateControls() {
  const locked = state.running || state.loading;
  document.querySelectorAll('.settings input,.settings select,.settings button,#preview-backend,#resolution,.camera-grid input,.camera-grid select').forEach(el => { el.disabled = locked; });
  $('apply-preview').disabled = locked || !state.file;
  $('fit').disabled = locked || !state.frame || !state.pose;
  $('apply-camera').disabled = locked || !state.file || !state.pose;
  $('run').disabled = locked || checkingVersions || !state.file || !state.pose;
  $('refresh-versions').disabled = locked || checkingVersions;
  $('run').hidden = locked; $('stop').hidden = !locked;
  $('report').disabled = locked || !state.report || !state.results.length;
  $('download-json').disabled = locked || !state.report || !state.results.length;
}
function updateCamera(value) {
  state.pose = value;
  for (let i = 0; i < 3; i++) { $(`cam-${'xyz'[i]}`).value = value.position[i].toFixed(5); $(`target-${'xyz'[i]}`).value = value.target[i].toFixed(5); }
  $('fov').value = value.fov; $('up').value = String(value.up[1]);
  $('camera-status').textContent = 'Shared by all renderers';
}
function fitFrame() {
  if (!state.frame) return;
  const width = Number(state.frame.width), height = Number(state.frame.height);
  const scale = $('frame-host').clientWidth / width;
  state.frame.style.transform = `scale(${scale})`;
  $('viewport').style.aspectRatio = `${width}/${height}`;
}
new ResizeObserver(fitFrame).observe($('frame-host'));
function settleRequest(id, result, error) {
  const entry = state.pending.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  state.pending.delete(id);
  error ? entry.reject(Error(error)) : entry.resolve(result);
}
function rejectPending(reason) {
  for (const id of state.pending.keys()) settleRequest(id, undefined, reason);
}
function closeFrame(reason = 'Cancelled') {
  if (state.closing) return state.closing;
  rejectPending(reason);
  if (!state.frame) return Promise.resolve();
  const frame = state.frame;
  // Keep the iframe alive until its renderer has released GPU resources.
  state.closing = request('dispose', null, 10000)
    .catch(error => console.warn('Renderer cleanup did not complete:', error))
    .finally(() => { frame.remove(); state.frame = null; state.closing = null; });
  return state.closing;
}
function request(type, data, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const id = ++state.serial;
    const timer = setTimeout(() => settleRequest(id, undefined, 'Timed out. Check the model and version compatibility.'), timeout);
    state.pending.set(id, { resolve, reject, timer });
    state.frame.contentWindow.postMessage({ type, data, id }, location.origin);
  });
}
addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== state.frame?.contentWindow) return;
  const { type, id, result, error, pose } = event.data;
  if (type === 'ready') settleRequest('ready');
  if (type === 'reply') settleRequest(id, result, error);
  if (state.closing) return;
  if (type === 'camera' && !state.running) updateCamera(pose);
  if (type === 'fatal') { status(error); rejectPending(error); }
  if (type === 'progress') { const { phase, elapsed, duration, scenario } = event.data; status(`${phase === 'warmup' ? 'Warm-up' : 'Sampling'} · ${scenario === 'static' ? 'Static' : 'Orbit'} · ${Math.min(elapsed, duration).toFixed(1)} / ${duration} s`); }
});
async function openFrame(backend, config, preview) {
  await closeFrame();
  if (state.cancelled) throw Error('Loading cancelled');
  const frame = document.createElement('iframe'); frame.title = `${backend.name} ${backend.backend} model preview`;
  frame.width = config.size.width; frame.height = config.size.height;
  state.frame = frame;
  const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => settleRequest('ready', undefined, 'Renderer module timed out'), 90000); state.pending.set('ready', { resolve, reject, timer }); });
  frame.src = `./runner.html?three=${encodeURIComponent(config.versions.three)}`;
  $('frame-host').append(frame); fitFrame(); $('empty-scene').hidden = true;
  $('viewport-tag').textContent = `${backend.name} · ${backend.backend} · ${config.size.width} × ${config.size.height}`;
  await ready;
  return request('init', { backend: backend.id, versions: config.versions, settings: config.parameters[backend.lib], size: config.size, pose: state.pose, file: state.file, preview });
}
async function preview() {
  if (!state.file || state.running || state.loading) return;
  state.loading = true; state.cancelled = false; updateControls(); status('Loading preview…');
  try {
    const backend = BACKENDS.find(b => b.id === $('preview-backend').value);
    const loaded = await openFrame(backend, getConfig(), true);
    updateCamera(loaded.pose); state.count = loaded.count;
    status(''); $('run-heading').textContent = 'Ready';
    $('run-status').textContent = `${loaded.count.toLocaleString()} splats. Adjust the view and settings before running.`;
  } catch (error) { status(error.message); toast(error.message); await closeFrame(); }
  finally { state.loading = false; updateControls(); }
}
async function convert(file) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./convert-worker.js', import.meta.url), { type: 'module' }); state.conversion = worker;
    state.conversionReject = reject;
    worker.onmessage = ({ data }) => { worker.terminate(); state.conversion = null; state.conversionReject = null; data.error ? reject(Error(data.error)) : resolve(data); };
    worker.onerror = event => { worker.terminate(); state.conversion = null; state.conversionReject = null; reject(Error(event.message)); };
    worker.postMessage(file);
  });
}
async function selectFile(input) {
  if (!input || state.loading || state.running) return;
  const url = input instanceof URL ? input : null;
  let name;
  try { name = url ? decodeURIComponent(url.pathname.split('/').pop()) : input.name; }
  catch { return toast('The model URL has an invalid filename'); }
  if (!/\.(ply|spz)$/i.test(name)) return toast('Select a PLY or SPZ model or a direct URL ending in .ply or .spz');
  if (!url && !input.size) return toast('The file is empty');
  state.loading = true; state.cancelled = false; updateControls(); await closeFrame(); state.pose = null; state.file = null;
  state.results = []; state.statuses = {}; state.report = null; renderResults();
  $('file-label').textContent = name; $('file-meta').textContent = url ? 'Downloading…' : `${(input.size / 1048576).toFixed(1)} MiB · local file`;
  $('format-note').textContent = ''; state.source = null;
  try {
    if (state.cancelled) throw Error('Loading cancelled');
    let file = input, downloadMs;
    if (url) {
      status('Downloading model…'); state.download = new AbortController();
      const start = performance.now();
      let blob;
      try {
        const response = await fetch(url.href, { signal: state.download.signal });
        if (!response.ok) throw Error(`Model download failed (HTTP ${response.status})`);
        blob = await response.blob();
      } catch (error) {
        if (state.cancelled) throw Error('Loading cancelled');
        if (error instanceof TypeError) throw Error('Could not download the model. Check the URL, network and server CORS settings.');
        throw error;
      } finally { state.download = null; }
      if (state.cancelled) throw Error('Loading cancelled');
      if (!blob.size) throw Error('The downloaded file is empty');
      downloadMs = performance.now() - start;
      file = new File([blob], name, { type: 'application/octet-stream' });
      $('file-meta').textContent = `${(file.size / 1048576).toFixed(1)} MiB · downloaded in ${(downloadMs / 1000).toFixed(2)} s`;
    }
    state.source = { name: file.name, bytes: file.size, lastModified: url ? null : file.lastModified, conversion: null, ...(url ? { downloadMs } : {}) };
    if (/\.spz$/i.test(file.name)) {
      status('Converting SPZ to PLY…');
      const result = await convert(file);
      state.file = new File([result.bytes], 'scene.ply', { type: 'application/octet-stream' });
      state.source.conversion = { library: '@playcanvas/splat-transform@3.6.4', ms: result.ms, outputBytes: state.file.size, count: result.count, shBands: result.shBands };
      $('format-note').textContent = `SPZ converted to PLY in ${(result.ms / 1000).toFixed(2)} s, preserving SH. All renderers use this PLY; native SPZ loading is not compared.`;
    } else { state.file = file; $('format-note').textContent = url ? 'All renderers use the same downloaded PLY. Download time is excluded from renderer load time.' : 'All renderers use the original PLY. Files stay on your device.'; }
  } catch (error) { if (url) $('file-meta').textContent = state.cancelled ? 'Loading cancelled' : 'Loading failed'; toast(error.message); status(error.message); }
  finally { state.loading = false; updateControls(); }
  if (state.file && !state.cancelled) await preview();
}
$('file').addEventListener('change', event => selectFile(event.target.files[0]));
$('url-form').addEventListener('submit', event => {
  event.preventDefault();
  let url;
  try { url = new URL($('model-url').value.trim()); }
  catch { return toast('Enter a valid HTTP or HTTPS model URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) return toast('Enter an HTTP or HTTPS model URL');
  selectFile(url);
});
for (const type of ['dragover', 'drop']) addEventListener(type, event => event.preventDefault());
for (const type of ['dragenter', 'dragover']) $('dropzone').addEventListener(type, () => $('dropzone').classList.add('dragging'));
for (const type of ['dragleave', 'drop']) $('dropzone').addEventListener(type, () => $('dropzone').classList.remove('dragging'));
$('dropzone').addEventListener('drop', event => selectFile(event.dataTransfer.files[0]));
$('apply-preview').onclick = preview; $('preview-backend').onchange = preview;
$('resolution').onchange = preview;
$('fit').onclick = async () => { try { updateCamera(await request('fit')); } catch (error) { toast(error.message); } };
$('apply-camera').onclick = async () => {
  try {
    if ([...'xyz'].some(c => $(`cam-${c}`).value === '' || $(`target-${c}`).value === '') || $('fov').value === '') throw Error('Fill in all camera fields');
    const position = [...'xyz'].map(c => Number($(`cam-${c}`).value));
    const target = [...'xyz'].map(c => Number($(`target-${c}`).value));
    const fov = Number($('fov').value);
    if (![...position, ...target, fov].every(Number.isFinite) || fov < 10 || fov > 120 || position.every((v, i) => v === target[i])) throw Error('Enter a valid camera position, target and FOV');
    const next = { ...state.pose, position, target, fov, up: [0, Number($('up').value), 0] };
    updateCamera(state.frame ? await request('camera', next) : next);
  } catch (error) { toast(error.message); }
};

async function refreshVersions() {
  checkingVersions = true; updateControls(); $('version-note').textContent = 'Checking GitHub versions…';
  async function json(url) { const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20000) }); if (!response.ok) throw Error(`${response.status} ${new URL(url).host}`); return response.json(); }
  const results = await Promise.allSettled(Object.entries(PACKAGES).map(async ([key, pkg]) => {
    const base = `https://api.github.com/repos/${repos[key]}`;
    const fetched = await Promise.allSettled([json(`${base}/releases?per_page=30`), json(`${base}/tags?per_page=100`), key === 'playcanvas' ? json(`${base}/commits?path=package.json&per_page=40`) : Promise.resolve([]), json(`https://registry.npmjs.org/${pkg.name}`)]);
    const [releases, tags, commits, npm] = fetched.map(r => r.status === 'fulfilled' ? r.value : null);
    if (!npm || (!releases && !tags && !commits?.length)) throw Error(`${pkg.name} version sources are unavailable`);
    const entries = new Map();
    const normalize = tag => key === 'three' && /^r\d+$/.test(tag) ? `0.${tag.slice(1)}.0` : tag.replace(/^v/, '');
    const add = (tag, url, source) => { const version = normalize(tag); if (exactVersion(version) && npm.versions[version] && !entries.has(version)) entries.set(version, { version, url, source, checkedAt: new Date().toISOString(), publishedAt: npm.time[version] }); };
    for (const r of releases ?? []) add(r.tag_name, r.html_url, 'GitHub Release');
    for (const t of tags ?? []) add(t.name, `https://github.com/${repos[key]}/tree/${encodeURIComponent(t.name)}`, 'GitHub Tag');
    for (const c of commits ?? []) { const match = c.commit.message.split('\n')[0].match(/\b\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?/); if (match) add(match[0], c.html_url, 'GitHub version commit'); }
    // The bundled version remains usable if it has fallen outside GitHub's recent pages.
    if (!entries.has(pkg.version)) entries.set(pkg.version, { version: pkg.version, source: 'bundled', url: `https://github.com/${repos[key]}/releases` });
    versionCatalog[key] = [...entries.values()].sort((a, b) => Date.parse(npm.time[b.version]) - Date.parse(npm.time[a.version]));
    const list = $(`versions-${key}`); list.replaceChildren();
    for (const entry of versionCatalog[key]) { const option = document.createElement('option'); option.value = entry.version; option.label = `${entry.version.includes('-') ? 'Prerelease' : 'Release'} · ${entry.source}`; list.append(option); }
    $(`version-${key}`).title = `${versionCatalog[key].length} GitHub versions available on npm`;
    if (fetched.slice(0, 3).some(r => r.status === 'rejected')) throw Error('Some GitHub requests failed');
  }));
  const failed = results.filter(r => r.status === 'rejected').length;
  $('version-note').textContent = failed ? `Some GitHub checks failed. Use the available list or enter a version.` : `GitHub checked at ${new Date().toLocaleTimeString("en-GB")}. Includes prereleases published on npm.`;
  checkingVersions = false; updateControls();
}
$('refresh-versions').onclick = refreshVersions;

function renderResults() {
  const scenario = state.report?.config.scenarios.includes('moving') && !state.report.config.scenarios.includes('static') ? 'moving' : 'static';
  const groups = BACKENDS.filter(b => !state.report || state.report.config.backends.includes(b.id)).map(b => {
    const rows = state.results.filter(r => r.backend === b.id);
    return { b, rows, result: aggregate(rows, scenario).metrics };
  });
  $('results').innerHTML = groups.map(({ b, rows, result }) => {
    const label = state.statuses[b.id] ?? 'Not run';
    const error = label.startsWith('Failed') ? rows.at(-1)?.error : null;
    const cells = ['p50', 'p95'].map(key => {
      if (!result) return '<td>—</td>';
      const value = result[key].toFixed(2), best = isBest(result[key], groups.map(g => g.result?.[key]));
      return `<td>${best ? `<span class="winner" title="Best">${value}</span>` : value}</td>`;
    }).join('');
    return `<tr><td><strong>${b.name}</strong><span>${b.backend}${rows[0] ? ` · ${escape(rows[0].version)}` : ''}</span></td><td><span class="status ${error ? 'failed' : result ? 'ok' : ''}">${escape(label)}</span>${error ? `<div class="error-detail">${escape(error)}</div>` : ''}</td>${cells}</tr>`;
  }).join('');
  $('result-detail').replaceChildren();
  for (const row of state.results) {
    const backend = BACKENDS.find(b => b.id === row.backend), detail = document.createElement('details'); detail.className = 'result-card';
    const title = document.createElement('summary'); title.textContent = `${backend.name} / ${backend.backend} · Round ${row.round} · ${row.error ? row.error : `Loaded in ${row.loadMs.toFixed(0)} ms`}`; detail.append(title);
    for (const c of row.cases ?? []) {
      const p = document.createElement('p'); p.textContent = `${c.scenario === 'static' ? 'Static' : 'Orbit'}: Frame P50 ${c.frameMs.p50.toFixed(2)} ms · Frame P95 ${c.frameMs.p95.toFixed(2)} ms · ${c.frames} frames`; detail.append(p);
      const timing = document.createElement('p'); timing.textContent = c.completionMethod; detail.append(timing);
    }
    if (row.cases?.[0]?.screenshot) { const img = document.createElement('img'); img.src = row.cases[0].screenshot; img.alt = `${backend.name} ${backend.backend} shared-camera capture`; detail.append(img); }
    if (row.info) { const pre = document.createElement('pre'); pre.textContent = JSON.stringify(row.info.settings, null, 2); detail.append(pre); }
    $('result-detail').append(detail);
  }
}
function stop(reason = 'Stopped by user') { if (!state.running) return; state.cancelled = true; state.stopReason = reason; closeFrame(reason); status(reason); }
$('stop').onclick = () => {
  if (state.running) stop();
  else if (state.loading) {
    state.cancelled = true;
    state.download?.abort();
    state.conversion?.terminate(); state.conversion = null;
    state.conversionReject?.(Error('Conversion cancelled')); state.conversionReject = null;
    closeFrame('Loading cancelled');
  }
};
document.addEventListener('visibilitychange', () => { if (document.hidden) stop('Stopped: tab hidden. Unfinished samples excluded.'); });
addEventListener('resize', () => { if (state.running) stop('Stopped: window resized.'); });

async function run() {
  let config;
  try { config = getConfig(); if (!config.backends.length || !config.scenarios.length) throw Error('Select at least one backend and scenario'); }
  catch (error) { return toast(error.message); }
  if (document.hidden) return toast('Keep this tab visible');
  state.running = true; state.cancelled = false; state.stopReason = null; state.results = []; state.statuses = {};
  document.body.classList.add('testing');
  for (const backend of BACKENDS) state.statuses[backend.id] = config.backends.includes(backend.id) ? 'Pending' : 'Not selected';
  const lockedPose = structuredClone(state.pose);
  state.report = { schema: 'splat-lab/4', metric: 'frame-completion-ms', created: new Date().toISOString(), source: structuredClone(state.source), count: state.count, config, camera: lockedPose, environment: { userAgent: navigator.userAgent, platform: navigator.platform, hardwareConcurrency: navigator.hardwareConcurrency, deviceMemoryGiB: navigator.deviceMemory ?? null, screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio }, secureContext: isSecureContext }, results: state.results, complete: false };
  updateControls(); renderResults(); $('progress').hidden = false; $('progress').value = 0;
  $('progress').max = config.rounds * config.backends.length * config.scenarios.length;
  let completed = 0;
  try {
    for (let round = 1; round <= config.rounds && !state.cancelled; round++) {
      const order = round % 2 ? [...config.backends.slice((round - 1) % config.backends.length), ...config.backends.slice(0, (round - 1) % config.backends.length)] : [...config.backends].reverse();
      for (const id of order) {
        if (state.cancelled) break;
        const backend = BACKENDS.find(b => b.id === id);
        const row = { backend: id, version: config.versions[backend.lib], round, started: new Date().toISOString(), cases: [] };
        state.statuses[id] = `Loading round ${round}`; renderResults(); status('Loading renderer and model…');
        $('run-heading').textContent = `${backend.name} / ${backend.backend}`;
        $('run-status').textContent = `Round ${round} / ${config.rounds} · ${(state.file.size / 1048576).toFixed(1)} MiB · Keep this tab visible`;
        state.pose = structuredClone(lockedPose);
        try {
          const loaded = await openFrame(backend, config, false); Object.assign(row, loaded);
          if (loaded.count !== state.count) throw Error(`Splat count mismatch: preview ${state.count}, current renderer ${loaded.count}`);
          for (const scenario of config.scenarios) {
            state.statuses[id] = `Round ${round} · ${scenario === 'static' ? 'Static' : 'Orbit'}`; renderResults();
            const result = await request('measure', { scenario, warmup: config.warmup, duration: config.duration }, (config.warmup + config.duration + 90) * 1000);
            row.cases.push(result); completed++; $('progress').value = completed;
          }
          state.statuses[id] = `${round} / ${config.rounds} complete`;
        } catch (error) { row.error = error.message; state.statuses[id] = state.cancelled ? 'Stopped' : 'Failed / unsupported'; completed += config.scenarios.length - row.cases.length; $('progress').value = completed; }
        state.results.push(row); renderResults(); await closeFrame();
        if (!state.cancelled) await new Promise(resolve => setTimeout(resolve, 350));
      }
    }
    state.report.complete = !state.cancelled && state.results.every(r => !r.error);
    state.report.stopReason = state.stopReason;
  } finally {
    await closeFrame(); state.pose = lockedPose; updateCamera(lockedPose); state.running = false; document.body.classList.remove('testing');
    $('run-heading').textContent = state.cancelled ? 'Stopped' : 'Complete';
    $('run-status').textContent = state.cancelled ? state.stopReason : 'Expand results for details or export a report.';
    status(state.cancelled ? state.stopReason : 'Test finished. Apply settings to reload the preview.'); updateControls();
  }
}
$('run').onclick = run;
$('download-json').onclick = () => {
  const blob = new Blob([JSON.stringify(state.report, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'splat-benchmark.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('report').onclick = async () => {
  $('report').disabled = true;
  try {
    const { createReport } = await import('./report.js');
    const { blob, pages } = await createReport(state.report);
    if (pdfURL) URL.revokeObjectURL(pdfURL); pdfURL = URL.createObjectURL(blob);
    $('pdf-download').href = pdfURL; $('report-pages').replaceChildren();
    for (const [i, page] of pages.entries()) { const img = document.createElement('img'); img.src = page; img.alt = `PDF page ${i + 1}`; $('report-pages').append(img); }
    $('report-dialog').showModal();
  } catch (error) { toast(`Report failed: ${error.message}`); }
  finally { updateControls(); }
};
$('close-report').onclick = () => $('report-dialog').close();
renderResults(); updateControls(); refreshVersions();
