import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { PACKAGES } from '../lab/config.js';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function buildLab(out = path.join(root, 'site/test')) {
  await fs.mkdir(out, { recursive: true });
  for (const name of ['index.html', 'runner.html', 'style.css', 'config.js']) await fs.copyFile(path.join(root, 'lab', name), path.join(out, name));
  await build({ absWorkingDir: root, entryPoints: ['lab/app.js', 'lab/runner.js', 'lab/convert-worker.js'], outdir: path.join(out, 'assets'), bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true, external: ['three', 'three/*', 'node:*'], logLevel: 'info' });
  for (const [key, pkg] of Object.entries(PACKAGES)) {
    const from = path.join(root, 'node_modules', pkg.name), to = path.join(out, 'vendor', key);
    await fs.mkdir(to, { recursive: true });
    await fs.copyFile(path.join(from, 'package.json'), path.join(to, 'package.json'));
    const dirs = key === 'three' ? ['build', 'examples/jsm'] : key === 'playcanvas' ? ['build/playcanvas'] : ['dist'];
    for (const dir of dirs) await fs.cp(path.join(from, dir), path.join(to, dir), { recursive: true, filter: file => !/\.(map|ts|cts|mts)$/.test(file) && !path.basename(file).startsWith('._') });
    for (const name of ['LICENSE', 'LICENSE.md', 'NOTICE', 'THIRD_PARTY_LICENSES.md']) {
      try { await fs.copyFile(path.join(from, name), path.join(to, name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
