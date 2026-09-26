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
 const installed=JSON.parse(fs.readFileSync('node_modules/'+pkg.name+'/package.json')).version;
 if(installed!==pkg.version||config.versions[key]!==installed)throw Error('Version mismatch: '+key);
}
const prefix=`let __benchMemory;const __benchInstantiate=WebAssembly.instantiate;WebAssembly.instantiate=async function(...a){const r=await __benchInstantiate.apply(this,a);__benchMemory=(r.instance||r).exports.memory;return r;};\n`;
for(const [name,file] of [['spark','node_modules/@sparkjsdev/spark/dist/spark.module.js'],['gsl','node_modules/gaussian-splat-lite/dist/gaussian-splat-lite.module.js']]){
 let src=fs.readFileSync(file,'utf8'),n=0;
 src=src.replace(/const jsContent[$\w]* = (['"].*?['"]);\n/g,(all,literal)=>{
  let worker=vm.runInNewContext(literal);
  if(!worker.includes('const result = await handler(args, { sendStatus });'))return all;
  worker=worker.replace('const result = await handler(args, { sendStatus });','const __benchStart=performance.now(); const result = await handler(args, { sendStatus }); const __bench={workerMs:performance.now()-__benchStart,wasmBytes:__benchMemory?.buffer.byteLength};');
  worker=worker.replace(/\{ id, result([, }])/g,'{ id, result, __bench$1');
  n++;return all.slice(0,all.indexOf('=')+1)+' '+JSON.stringify(prefix+worker)+';\n';
 });
 if(!n)throw Error('Worker instrumentation missing: '+name);
 fs.writeFileSync('dist/'+name+'.js',src);console.log(name,'instrumented workers',n);
}
fs.copyFileSync('../lab/config.js','dist/lab-config.js');
console.log('Built shared lab presets and instrumented Workers');

const editorVersion=JSON.parse(fs.readFileSync('../vendor/supersplat/package.json')).version;
if(editorVersion!==config.versions.supersplat)throw Error('SuperSplat version mismatch');
await build({absWorkingDir:root,entryPoints:['supersplat.ts'],outfile:'dist/supersplat.js',bundle:true,alias:{playcanvas:path.join(root,'node_modules/playcanvas/build/playcanvas.mjs')},format:'esm',platform:'browser',minify:true,target:'es2022',external:['node:*'],nodePaths:[path.join(root,'node_modules')],loader:{'.wgsl':'text'},plugins:[{
 name:'editor-resource-read-only-import',setup(b){b.onLoad({filter:/editor-splat-resource\.ts$/},async args=>({contents:(await fs.promises.readFile(args.path,'utf8')).replace("from './io';","from './io/read/loader';"),loader:'ts'}));}
}]});
console.log('Built SuperSplat Editor',editorVersion);
