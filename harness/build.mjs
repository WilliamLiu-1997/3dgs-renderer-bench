// Builds harness/dist: renderer bundles whose sort Workers report their own execution time and
// WASM memory. Everything else the harness loads is served directly from node_modules and lab/.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { BACKENDS, PACKAGES } from '../lab/config.js';

const harness = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(harness, '..', 'node_modules');
const dist = path.join(harness, 'dist');
const config = JSON.parse(fs.readFileSync(path.join(harness, 'config.json')));

for (const [key, pkg] of Object.entries(PACKAGES)) {
  const metadata = JSON.parse(fs.readFileSync(path.join(modules, pkg.installName ?? pkg.name, 'package.json')));
  if (pkg.commit && (metadata.gitHead !== pkg.commit || config.commits[key] !== pkg.commit))
    throw Error('Commit mismatch: ' + key);
  if (metadata.version !== pkg.version || config.versions[key] !== metadata.version)
    throw Error('Version mismatch: ' + key);
}
if (JSON.stringify(config.backends) !== JSON.stringify(BACKENDS.map(b => b.id)))
  throw Error('harness/config.json backends must match lab/config.js BACKENDS');

fs.mkdirSync(dist, { recursive: true });
const handlerCall = 'const result = await handler(args, { sendStatus });';
const memoryProbe = `let __benchMemory;const __benchInstantiate=WebAssembly.instantiate;WebAssembly.instantiate=async function(...a){const r=await __benchInstantiate.apply(this,a);__benchMemory=(r.instance||r).exports.memory;return r;};\n`;
const timedHandlerCall = `const __benchStart=performance.now(); ${handlerCall} const __bench={workerMs:performance.now()-__benchStart,wasmBytes:__benchMemory?.buffer.byteLength};`;
for (const [name, file] of [
  ['spark', '@sparkjsdev/spark/dist/spark.module.js'],
  ['gsl', 'gaussian-splat-lite/dist/gaussian-splat-lite.module.js'],
]) {
  let instrumented = 0;
  const source = fs
    .readFileSync(path.join(modules, file), 'utf8')
    .replace(/(?:const|var) jsContent[$\w]* = (['"].*?['"]);\n/g, (all, literal) => {
      let worker = vm.runInNewContext(literal);
      if (!worker.includes(handlerCall)) return all;
      worker = worker
        .replace(handlerCall, timedHandlerCall)
        .replace(/\{\s*id,\s*result(\s*[,}])/g, '{ id, result, __bench$1');
      instrumented++;
      return all.slice(0, all.indexOf('=') + 1) + ' ' + JSON.stringify(memoryProbe + worker) + ';\n';
    });
  if (!instrumented) throw Error('Worker instrumentation missing: ' + name);
  fs.writeFileSync(path.join(dist, name + '.js'), source.replace(/^[\t ]+$/gm, ''));
  console.log(name, 'instrumented workers', instrumented);
}

const radix = fs.readFileSync(path.join(modules, '@sparkjsdev/radix/dist/radix.module.js'), 'utf8');
const core = radix.match(/var coreModule_default = ('.*?');\n/);
if (!core) throw Error('Radix native Worker core missing');
fs.writeFileSync(path.join(dist, 'radix-core.js'), vm.runInNewContext(core[1]));
console.log('Built instrumented renderer Workers in harness/dist');
