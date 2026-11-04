// Formal benchmark runner: one fresh headless Chrome per model × backend × round.
//   node harness/run.mjs [models…] [backends…] [--pilot] [--variants]
// ROUNDS (default 3), RESULTS_DIR (default harness/results-current) and PORT (default 5351) override.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { median, roundOrder } from '../lab/config.js';
import { collectHeap } from './heap.mjs';
import { startServer } from './server.mjs';

const harness = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(harness, 'config.json')));
const args = process.argv.slice(2);
const pilot = args.includes('--pilot');
const roundCount = pilot ? 1 : Number(process.env.ROUNDS || 3);
const selectedModels = args.filter(arg => Object.hasOwn(config.models, arg));
const models = selectedModels.length ? selectedModels : Object.keys(config.models);
const selectedModes = args.filter(arg => config.backends.includes(arg));
const modes = selectedModes.length ? selectedModes : config.backends;
const unknown = args.filter(
  arg => !arg.startsWith('--') && !selectedModels.includes(arg) && !selectedModes.includes(arg),
);
if (unknown.length) throw Error(`Unknown model or backend: ${unknown.join(', ')}`);
const folder = path.resolve(harness, process.env.RESULTS_DIR || (pilot ? 'pilot' : 'results-current'));
fs.mkdirSync(folder, { recursive: true });
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

function isComplete(filename) {
  if (pilot || !fs.existsSync(filename)) return false;
  const previous = JSON.parse(fs.readFileSync(filename));
  return !previous.failure && JSON.stringify(previous.config) === JSON.stringify(config);
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
    await page.goto(`http://127.0.0.1:${port}/?mode=${mode}&model=${output.model}`, {
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
    // Aholo Viewer only sorts by view depth.
    if (state.sortRadial !== !mode.startsWith('aholo-'))
      throw Error('Radial sorting required for every sorted backend');
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
const server = await startServer(port);
let failures = 0;
async function run(model, mode, round, order, retry) {
  const name = `${model}-${mode}-r${round}`;
  const output = {
    name,
    mode,
    model,
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
  if (output.failure) failures++;
  fs.writeFileSync(path.join(folder, name + '.json'), JSON.stringify(output, null, 2));
  console.log('DONE', name);
}

// Runs with any case more than RETRY_PERCENT off the median FPS of its rounds. Each run is retried at most
// once; the disturbed original is kept in outliers/ and the retry records why it was rerun.
const retryPercent = Number(process.env.RETRY_PERCENT || 3);
function outliers() {
  const found = [];
  for (const model of models)
    for (const mode of modes) {
      const runs = Array.from({ length: roundCount }, (_, i) =>
        JSON.parse(fs.readFileSync(path.join(folder, `${model}-${mode}-r${i + 1}.json`))),
      );
      if (runs.some(r => r.failure)) continue;
      for (const r of runs) {
        if (r.retry) continue;
        const deviations = r.cases.map((c, i) => {
          const fps = median(runs.map(other => other.cases[i].fps));
          return (100 * (c.fps - fps)) / fps;
        });
        const worst = deviations.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
        if (Math.abs(worst) > retryPercent) found.push({ model, mode, round: r.round, order: r.order, worst });
      }
    }
  return found;
}

try {
  for (let round = 1; round <= roundCount; round++) {
    for (const model of models) {
      const order = roundOrder(modes, round);
      for (const mode of order) {
        const name = `${model}-${mode}-r${round}`;
        if (isComplete(path.join(folder, name + '.json'))) {
          console.log('SKIP complete', name);
          continue;
        }
        await run(model, mode, round, order);
      }
    }
  }
  if (!pilot && roundCount >= 3 && !failures) {
    fs.mkdirSync(path.join(folder, 'outliers'), { recursive: true });
    for (const { model, mode, round, order, worst } of outliers()) {
      const name = `${model}-${mode}-r${round}`;
      console.log(`RETRY ${name}: ${worst.toFixed(1)}% from the median of its rounds`);
      fs.renameSync(path.join(folder, name + '.json'), path.join(folder, 'outliers', name + '.json'));
      await run(model, mode, round, order, { deviationPercent: worst, thresholdPercent: retryPercent });
    }
  }
} finally {
  server.close();
}
if (failures) process.exitCode = 1;
