// Builds harness/dist: renderer bundles whose sort Workers report their own execution time and
// WASM memory. Everything else the harness loads is served directly from node_modules and lab/.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { BACKENDS, CONVERTER, PACKAGES, supportsFormat } from '../lab/config.js';

const harness = path.dirname(fileURLToPath(import.meta.url));
const modules = path.join(harness, '..', 'node_modules');
const dist = path.join(harness, 'dist');
const config = JSON.parse(fs.readFileSync(path.join(harness, 'config.json')));

const installed = pkg => JSON.parse(fs.readFileSync(path.join(modules, pkg.installName ?? pkg.name, 'package.json')));
for (const [key, pkg] of Object.entries(PACKAGES)) {
  const metadata = installed(pkg);
  if (metadata.version !== pkg.version || config.versions[key] !== metadata.version)
    throw Error('Version mismatch: ' + key);
}
if (installed(CONVERTER).version !== CONVERTER.version) throw Error('Version mismatch: ' + CONVERTER.name);
if (JSON.stringify(config.backends) !== JSON.stringify(BACKENDS.map(b => b.id)))
  throw Error('harness/config.json backends must match lab/config.js BACKENDS');
for (const [format, spec] of Object.entries(config.formats))
  if (JSON.stringify(spec.backends) !== JSON.stringify(BACKENDS.filter(b => supportsFormat(b, format)).map(b => b.id)))
    throw Error(`harness/config.json ${format} support must match the lab`);

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

// Aholo Viewer's sort Worker instantiates its WASM synchronously and only posts results back; report the memory
// capacity with each result. The harness server serves this copy at the package's own Worker URL.
let aholo = fs.readFileSync(path.join(modules, '@manycore/aholo-viewer/dist/splat-sort-worker.js'), 'utf8');
const aholoProbes = [
  [/(\n\s*wasmMemory = wasmExports\d*\[[^\]]+\];)/, '$1 __benchMemory = wasmMemory;'],
  [
    /postMessage\(\{ status: 0 \/\* Success \*\/, payload \}/,
    'postMessage({ status: 0, payload, wasmMemoryBytes: __benchMemory?.buffer.byteLength }',
  ],
];
for (const [pattern, replacement] of aholoProbes) {
  if (!pattern.test(aholo)) throw Error('Aholo Viewer sort Worker instrumentation missing: ' + pattern);
  aholo = aholo.replace(pattern, replacement);
}
fs.writeFileSync(path.join(dist, 'aholo-sort-worker.js'), 'let __benchMemory;\n' + aholo);

const radix = fs.readFileSync(path.join(modules, '@sparkjsdev/radix/dist/radix.module.js'), 'utf8');
const core = radix.match(/var coreModule_default = ('.*?');\n/);
if (!core) throw Error('Radix native Worker core missing');
fs.writeFileSync(path.join(dist, 'radix-core.js'), vm.runInNewContext(core[1]));
console.log('Built instrumented renderer Workers in harness/dist');
