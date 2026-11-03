import fs from 'node:fs';
import vm from 'node:vm';
import {build} from 'esbuild';
import {PACKAGES} from '../lab/config.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);fs.mkdirSync('dist',{recursive:true});
const config=JSON.parse(fs.readFileSync('config.json'));
for(const [key,pkg] of Object.entries(PACKAGES)){
 const metadata=JSON.parse(fs.readFileSync('node_modules/'+(pkg.installName??pkg.name)+'/package.json'));
 const installed=metadata.version;
 if(pkg.commit&&(metadata.gitHead!==pkg.commit||config.commits[key]!==pkg.commit))throw Error('Commit mismatch: '+key);
 if(installed!==pkg.version||config.versions[key]!==installed)throw Error('Version mismatch: '+key);
}
const prefix=`let __benchMemory;const __benchInstantiate=WebAssembly.instantiate;WebAssembly.instantiate=async function(...a){const r=await __benchInstantiate.apply(this,a);__benchMemory=(r.instance||r).exports.memory;return r;};\n`;
for(const [name,file] of [['spark','node_modules/@sparkjsdev/spark/dist/spark.module.js'],['gsl','node_modules/gaussian-splat-lite/dist/gaussian-splat-lite.module.js']]){
 let src=fs.readFileSync(file,'utf8'),n=0;
 src=src.replace(/(?:const|var) jsContent[$\w]* = (['"].*?['"]);\n/g,(all,literal)=>{
  let worker=vm.runInNewContext(literal);
  if(!worker.includes('const result = await handler(args, { sendStatus });'))return all;
  worker=worker.replace('const result = await handler(args, { sendStatus });','const __benchStart=performance.now(); const result = await handler(args, { sendStatus }); const __bench={workerMs:performance.now()-__benchStart,wasmBytes:__benchMemory?.buffer.byteLength};');
  worker=worker.replace(/\{\s*id,\s*result(\s*[,}])/g,'{ id, result, __bench$1');
  n++;return all.slice(0,all.indexOf('=')+1)+' '+JSON.stringify(prefix+worker)+';\n';
 });
 if(!n)throw Error('Worker instrumentation missing: '+name);
 fs.writeFileSync('dist/'+name+'.js',src.replace(/^[\t ]+$/gm,''));console.log(name,'instrumented workers',n);
}
fs.copyFileSync('../lab/config.js','dist/lab-config.js');
const radix = fs.readFileSync('node_modules/@sparkjsdev/radix/dist/radix.module.js', 'utf8');
const core = radix.match(/var coreModule_default = ('.*?');\n/);
if (!core) throw Error('Radix native Worker core missing');
fs.writeFileSync('dist/radix-core.js', vm.runInNewContext(core[1]));
console.log('Built shared lab presets and instrumented Workers');

await build({ entryPoints: ['shared-adapter.js'], outfile: 'dist/shared-adapter.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['three', 'three/*', 'playcanvas', 'node:*'] });
