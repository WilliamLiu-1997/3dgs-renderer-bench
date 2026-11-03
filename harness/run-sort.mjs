import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';
import { roundOrder } from '../lab/config.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json')));
const folder = path.resolve(root, process.env.RESULTS_DIR || 'results-current');
const selected = process.argv.slice(2);
const models = selected.length ? selected : Object.keys(config.models);
const backends = ['spark', 'radix-gpu', 'radix-gl', 'gsl-gpu', 'gsl-gl', 'viewer-gpu', 'pc-gpu', 'pc-gl'];
const port = Number(process.env.PORT || 5351);
const server = await startServer(port);

try {
  for (let round = 1; round <= Number(process.env.ROUNDS || 3); round++) {
    const order = roundOrder(backends, round).filter(mode => mode.startsWith('radix-'));
    for (const model of models) for (const mode of order) {
      const name = `${model}-${mode}-r${round}`;
      const filename = path.join(folder, name + '.json');
      const previous = JSON.parse(fs.readFileSync(filename));
      if (previous.failure || JSON.stringify(previous.config) !== JSON.stringify(config)) throw Error('Completed matching frame run required: ' + name);
      const measuredAt = new Date().toISOString();
      console.log('SORT', name);
      const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--no-proxy-server', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
      try {
        const page = await browser.newPage({ viewport: { width: config.logicalWidth, height: config.logicalHeight }, deviceScaleFactor: config.dpr });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`http://127.0.0.1:${port}/?mode=${mode}&model=${model}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
        await page.waitForFunction(() => window.ready || window.errors?.length, null, { timeout: 300000 });
        if (!await page.evaluate(() => window.ready)) throw Error(await page.evaluate(() => window.errors.join('\n')));
        const sort = await page.evaluate(() => sortBenchmark({ n: 16 }));
        errors.push(...await page.evaluate(() => window.errors));
        if (errors.length) throw Error(errors.join('\n'));
        if (sort.rows.length !== 16) throw Error('Wrong sample count');
        for (const row of sort.rows) {
          if (mode === 'radix-gl') {
            const calls = row.rpc.filter(call => call.name === 'sortKeys');
            if (calls.length !== 1 || !(calls[0].workerMs > 0 && calls[0].roundTripMs > 0) || row.sortJobs.length !== 1 || !(row.sortJobs[0].ms > 0)) throw Error('Missing CPU sort timing');
          } else if (!row.passes.some(pass => pass.stage === 'sort' && pass.end > pass.start)) throw Error('Missing GPU sort timing');
        }
        Object.assign(sort, { measuredAt, browser: browser.version(), protocol: 'radix-sort-diagnostic-v1', order, warmupSamples: 4, consoleErrors: errors });
        fs.writeFileSync(filename, JSON.stringify({ ...previous, sort: [sort] }, null, 2));
        console.log('DONE', name);
      } finally { await browser.close(); }
    }
  }
} finally { server.close(); }
