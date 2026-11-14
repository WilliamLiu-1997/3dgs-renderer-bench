// Formal benchmark runner: one fresh headless Chrome per model × backend × round.
//   node harness/run.mjs [models…] [backends…] [--format=ply|sog] [--fresh] [--pilot] [--variants]
// ROUNDS (default 3), RESULTS_DIR (default harness/results-current) and PORT (default 5351) override.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { median, roundOrder } from '../lab/config.js';
import { collectHeap } from './heap.mjs';
import { startServer } from './server.mjs';

const harness = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(harness, 'config.json')));
const args = process.argv.slice(2);
const pilot = args.includes('--pilot');
const dryRun = args.includes('--dry-run');
const retryReason = args.find(arg => arg.startsWith('--retry='))?.slice(8);
const retryOutliers = args.includes('--retry-outliers');
const formatArgs = args.filter(arg => arg.startsWith('--format='));
const formats = formatArgs.length ? formatArgs.map(arg => arg.slice(9)) : Object.keys(config.formats);
for (const format of formats) if (!config.formats[format]) throw Error('Unknown format: ' + format);
const modesFor = format => modes.filter(mode => config.formats[format].backends.includes(mode));
const runName = (model, mode, round, format) => `${model}${format === 'ply' ? '' : '-' + format}-${mode}-r${round}`;
const created = new Set();
const unavailable = new Map();
const loadFailure = run =>
  run.format === 'sog' &&
  run.failure &&
  run.debug?.phase === 'loading' &&
  !run.initial &&
  !run.cases.length &&
  !run.sort.length;
const roundCount = pilot ? 1 : Number(process.env.ROUNDS || 3);
const selectedModels = args.filter(arg => Object.hasOwn(config.models, arg));
const models = selectedModels.length ? selectedModels : Object.keys(config.models);
const selectedModes = args.filter(arg => config.backends.includes(arg));
const modes = selectedModes.length ? selectedModes : config.backends;
const sogInputs =
  formats.includes('sog') && !pilot && !dryRun
    ? JSON.parse(fs.readFileSync(path.join(harness, '../models/sog-manifest.json')))
    : {};
const unknown = args.filter(
  arg => !arg.startsWith('--') && !selectedModels.includes(arg) && !selectedModes.includes(arg),
);
if (unknown.length) throw Error(`Unknown model or backend: ${unknown.join(', ')}`);
if (formats.includes('sog') && !pilot && !dryRun)
  for (const model of models) {
    const digest = createHash('sha256');
    const source = path.resolve(harness, config.models[model].path.replace(/\.ply$/, '.sog'));
    for await (const bytes of fs.createReadStream(source)) digest.update(bytes);
    if (digest.digest('hex') !== sogInputs[model]?.sha256)
      throw Error(`SOG changed: run npm run models:sog (${model})`);
  }
const folder = path.resolve(harness, process.env.RESULTS_DIR || (pilot ? 'pilot' : 'results-current'));
fs.mkdirSync(folder, { recursive: true });
if (args.includes('--supplement')) {
  if (!formatArgs.length || args.includes('--fresh')) throw Error('Use --supplement with --format and without --fresh');
  const published = path.join(harness, 'results');
  if (!dryRun && published !== folder)
    fs.cpSync(published, folder, {
      recursive: true,
      force: false,
      filter: file => !path.basename(file).startsWith('._'),
    });
}
const port = Number(process.env.PORT || 5351);
// Main and second views (config.json `secondView`), each static and orbiting.
const scenarios = pilot
  ? [{ view: 'main', moving: false }]
  : [false, true].flatMap(moving => ['main', 'second'].map(view => ({ view, moving })));
const sampling = moving =>
  pilot
    ? { warmup: config.warmupSeconds, duration: 0.5 }
    : { warmup: config.warmupSeconds, duration: config.sampleSeconds[moving ? 'moving' : 'static'] };
const chromeArgs = [
  '--enable-unsafe-webgpu',
  '--no-proxy-server',
  '--enable-precise-memory-info',
  '--js-flags=--expose-gc',
];

// Resident memory of the Chrome process tree, sampled outside the page.
function rss(pid) {
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map(line => {
      const [, id, parent, kib, command] = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
      return { pid: +id, ppid: +parent, kib: +kib, command };
    });
  const ids = new Set([pid]);
  let size;
  do {
    size = ids.size;
    for (const p of processes) if (ids.has(p.ppid)) ids.add(p.pid);
  } while (size !== ids.size);
  const tree = processes.filter(p => ids.has(p.pid));
  const mib = filter => tree.filter(filter).reduce((sum, p) => sum + p.kib, 0) / 1024;
  return {
    at: Date.now(),
    totalMiB: mib(() => true),
    rendererMiB: mib(p => p.command.includes('--type=renderer')),
    gpuProcessMiB: mib(p => p.command.includes('--type=gpu-process')),
  };
}

function isComplete(filename, format) {
  if (pilot || retryReason || args.includes('--fresh') || !fs.existsSync(filename)) return false;
  const previous = JSON.parse(fs.readFileSync(filename));
  const matches =
    JSON.stringify(previous.config) === JSON.stringify(config) &&
    (format !== 'sog' || dryRun || previous.input?.sha256 === sogInputs[previous.model]?.sha256);
  if (matches && loadFailure(previous)) {
    unavailable.set(`${previous.model}-${previous.mode}`, previous);
    return true;
  }
  return matches && !previous.failure;
}

const describe = result =>
  `${result.fps.toFixed(2)} FPS · P50 ${result.frameMs.p50.toFixed(2)} ms · P95 ${result.frameMs.p95.toFixed(2)} ms`;

async function measureRun(output, round) {
  const { mode } = output;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: chromeArgs });
  output.browser = browser.version();
  const browserSession = await browser.newBrowserCDPSession();
  const { processInfo } = await browserSession.send('SystemInfo.getProcessInfo');
  const browserPid = processInfo.find(p => p.type === 'browser').id;
  const poll = setInterval(() => {
    try {
      output.rss.push(rss(browserPid));
    } catch {}
  }, 1500);
  let page;
  try {
    page = await browser.newPage({
      viewport: { width: config.logicalWidth, height: config.logicalHeight },
      deviceScaleFactor: config.dpr,
    });
    const session = await page.context().newCDPSession(page);
    page.on('pageerror', e => {
      output.consoleErrors.push(e.message);
      console.log('PAGE ERROR', mode, e.stack.slice(0, 1400));
    });
    page.on('console', m => {
      if (m.type() !== 'error') return;
      output.consoleErrors.push(m.text());
      console.log('CONSOLE', mode, m.text().slice(0, 450));
    });
    const snapshot = async result => {
      result.heap = await collectHeap(browserSession, session);
      result.memory = await page.evaluate(() => snapshot().memory);
      result.rss = rss(browserPid);
      return result;
    };
    output.baseline = rss(browserPid);
    console.log('LOAD', output.name);
    await page.goto(`http://127.0.0.1:${port}/?mode=${mode}&model=${output.model}&format=${output.format}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120000,
    });
    await page.waitForFunction(() => window.ready || window.errors?.length, null, { timeout: 300000 });
    if (!(await page.evaluate(() => window.ready))) throw Error((await page.evaluate(() => window.errors)).join('\n'));
    output.initialHeap = await collectHeap(browserSession, session);
    output.initial = await page.evaluate(() => snapshot());
    output.initialRss = rss(browserPid);
    const { state } = output.initial;
    if (mode.startsWith('radix-') && state.renderParameters.sortBits !== 24)
      throw Error('Radix default 24-bit sorting required');
    if (state.sortRadial !== true) throw Error('Radial sorting required for every sorted backend');
    console.log('READY', output.name, output.initial.loadMs.toFixed(0), 'ms', state);

    const fast = true;
    const variants = ['sorted'];
    if ((!pilot || args.includes('--variants')) && config.stochasticBackends.includes(mode))
      variants.push('stochastic');
    for (const variant of variants) {
      for (const scenario of scenarios) {
        const settings = { variant, fast, ...scenario, ...sampling(scenario.moving) };
        const result = await snapshot(await page.evaluate(settings => benchmark(settings), settings));
        output.cases.push(result);
        if (result.errors.length) throw Error(result.errors.join('\n'));
        console.log(
          'CASE',
          output.name,
          variant,
          scenario.moving ? 'moving' : 'static',
          scenario.view,
          describe(result),
        );
      }
      if (variant === 'sorted') {
        const sort = await page.evaluate(settings => sortBenchmark(settings), { fast, n: pilot ? 3 : 16 });
        output.sort.push(sort);
        console.log('SORT', output.name, median(sort.rows.map(r => r.gpuSortMs ?? r.updateMs)));
      }
      await page.evaluate(settings => captureView(settings), { variant, fast });
      if (round === 1) await page.screenshot({ path: path.join(folder, `${output.name}-${variant}.png`) });
    }
    output.heap = await collectHeap(browserSession, session);
    output.final = await page.evaluate(() => snapshot());
    output.finalRss = rss(browserPid);
  } catch (error) {
    output.failure = String(error);
    console.log('FAILED', output.name, String(error));
    if (page)
      try {
        output.debug = await page.evaluate(() => ({
          phase: window.phase,
          progress: window.progress,
          errors: window.errors,
          state: window.api?.state?.(),
        }));
        await page.screenshot({ path: path.join(folder, `${output.name}-failure.png`) });
      } catch {}
  } finally {
    clearInterval(poll);
    await browser.close();
  }
}

// macOS starts idle-time maintenance (media analysis, Photos indexing, Messages) on an idle Mac on AC power,
// which slowed GPU-bound runs by up to 30% for 15-25 minutes. On macOS, keep the system awake and the user
// marked active. Other platforms skip this; keep their power and maintenance settings from interfering.
if (process.platform === 'darwin') {
  const caffeinate = args =>
    spawn('caffeinate', args, { stdio: 'ignore' })
      .on('error', () => {})
      .unref();
  caffeinate(['-i', '-w', String(process.pid)]);
  caffeinate(['-u', '-t', '1']);
  setInterval(() => caffeinate(['-u', '-t', '1']), 30_000).unref();
}
// Every 20 s, the five busiest other processes, to explain outliers. Skipped where `ps` is unavailable.
const activityLog = path.join(folder, 'activity.log');
const logActivity = setInterval(() => {
  try {
    const busiest = execFileSync('ps', ['-Ao', 'pcpu=,comm='], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim().match(/^([\d.]+)\s+(.*)$/))
      .filter(match => match && !/chrome/i.test(match[2]))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([, cpu, command]) => `${cpu} ${path.basename(command)}`);
    fs.appendFileSync(activityLog, `${new Date().toISOString()} ${busiest.join(' | ')}\n`);
  } catch {
    clearInterval(logActivity);
  }
}, 20_000).unref();
const server = dryRun ? null : await startServer(port);
let failures = 0;
async function run(model, mode, round, order, format, retry) {
  const name = runName(model, mode, round, format);
  created.add(name);
  const output = {
    name,
    mode,
    model,
    format,
    ...(format === 'sog' && !pilot && { input: sogInputs[model] }),
    round,
    order,
    started: new Date().toISOString(),
    config,
    ...(retry && { retry }),
    consoleErrors: [],
    rss: [],
    cases: [],
    sort: [],
  };
  await measureRun(output, round);
  if (loadFailure(output)) unavailable.set(`${model}-${mode}`, output);
  else if (output.failure) failures++;
  fs.writeFileSync(path.join(folder, name + '.json'), JSON.stringify(output, null, 2));
  console.log('DONE', name);
}

// Runs with any case more than RETRY_PERCENT off the median FPS of its rounds. Each run is retried at most
// once; the disturbed original is kept in outliers/ and the retry records why it was rerun.
const retryPercent = Number(process.env.RETRY_PERCENT || 3);
function outliers() {
  const found = [];
  for (const format of formats)
    for (const model of models)
      for (const mode of modesFor(format)) {
        const runs = Array.from({ length: roundCount }, (_, i) =>
          JSON.parse(fs.readFileSync(path.join(folder, runName(model, mode, i + 1, format) + '.json'))),
        );
        if (runs.some(r => r.failure)) continue;
        for (const r of runs) {
          if (r.retry || (!created.has(r.name) && !retryOutliers)) continue;
          const deviations = r.cases.map((c, i) => {
            const fps = median(runs.map(other => other.cases[i].fps));
            return (100 * (c.fps - fps)) / fps;
          });
          const worst = deviations.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
          if (Math.abs(worst) > retryPercent)
            found.push({ model, mode, format, round: r.round, order: r.order, worst });
        }
      }
  return found;
}

try {
  for (const format of formats)
    for (let round = 1; round <= roundCount; round++) {
      for (const model of models) {
        const order = roundOrder(modesFor(format), round);
        for (const mode of order) {
          const name = runName(model, mode, round, format);
          if (isComplete(path.join(folder, name + '.json'), format)) {
            console.log(
              format === 'sog' && unavailable.has(`${model}-${mode}`) ? 'SKIP unavailable' : 'SKIP complete',
              name,
            );
            continue;
          }
          const failed = format === 'sog' && unavailable.get(`${model}-${mode}`);
          if (failed && !retryReason) {
            if (!dryRun)
              fs.writeFileSync(
                path.join(folder, name + '.json'),
                JSON.stringify(
                  {
                    name,
                    mode,
                    model,
                    format,
                    round,
                    order,
                    config,
                    input: sogInputs[model],
                    cases: [],
                    sort: [],
                    skipped: { failedRun: failed.name, reason: failed.failure },
                  },
                  null,
                  2,
                ),
              );
            console.log('SKIP unavailable', name);
            continue;
          }
          if (dryRun) console.log('PLAN', name);
          else {
            let recordedOrder = order,
              retry;
            if (retryReason) {
              const filename = path.join(folder, name + '.json');
              const previous = JSON.parse(fs.readFileSync(filename));
              recordedOrder = previous.order;
              retry = { reason: retryReason, previousStarted: previous.started };
              fs.mkdirSync(path.join(folder, 'outliers'), { recursive: true });
              fs.copyFileSync(filename, path.join(folder, 'outliers', `${name}-${Date.now()}.json`));
            }
            await run(model, mode, round, recordedOrder, format, retry);
          }
        }
      }
    }
  if (!dryRun && !pilot && roundCount >= 3 && !failures) {
    fs.mkdirSync(path.join(folder, 'outliers'), { recursive: true });
    for (const { model, mode, format, round, order, worst } of outliers()) {
      const name = runName(model, mode, round, format);
      console.log(`RETRY ${name}: ${worst.toFixed(1)}% from the median of its rounds`);
      fs.renameSync(path.join(folder, name + '.json'), path.join(folder, 'outliers', name + '.json'));
      await run(model, mode, round, order, format, { deviationPercent: worst, thresholdPercent: retryPercent });
    }
  }
} finally {
  server?.close();
}
if (failures) process.exitCode = 1;
