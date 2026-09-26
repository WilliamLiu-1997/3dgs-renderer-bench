import {chromium} from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {startServer} from './server.mjs';
import {collectHeap} from './heap.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));process.chdir(root);
const config=JSON.parse(fs.readFileSync('config.json'));
const args=process.argv.slice(2),pilot=args.includes('--pilot'),roundCount=pilot?1:Number(process.env.ROUNDS||3);
const models=args.includes('hotel')?['hotel']:args.includes('elevator')?['elevator']:['elevator','hotel'];
const modes=args.filter(x=>['gsl-gl','gsl-gpu','spark','pc-gl','pc-gpu','supersplat'].includes(x));if(!modes.length)modes.push('spark','pc-gl','pc-gpu','supersplat','gsl-gl','gsl-gpu');
const folder=pilot?'pilot':'results';fs.mkdirSync(folder,{recursive:true});
const port=Number(process.env.PORT||5351);
const server=await startServer(port);
function rss(pid){const lines=execFileSync('ps',['-axo','pid=,ppid=,rss=,command='],{encoding:'utf8'}).trim().split('\n').map(l=>{const m=l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return {pid:+m[1],ppid:+m[2],kib:+m[3],command:m[4]};});const ids=new Set([pid]);let size;do{size=ids.size;for(const p of lines)if(ids.has(p.ppid))ids.add(p.pid);}while(size!==ids.size);const all=lines.filter(p=>ids.has(p.pid));return {at:Date.now(),totalMiB:all.reduce((s,p)=>s+p.kib,0)/1024,rendererMiB:all.filter(p=>p.command.includes('--type=renderer')).reduce((s,p)=>s+p.kib,0)/1024,gpuProcessMiB:all.filter(p=>p.command.includes('--type=gpu-process')).reduce((s,p)=>s+p.kib,0)/1024};}
let failures=0;
const median=a=>{const s=a.filter(Number.isFinite).sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
try{
for(let round=1;round<=roundCount;round++)for(const model of models){
 const order=round%2===0?[...modes].reverse():[...modes.slice((round-1)%modes.length),...modes.slice(0,(round-1)%modes.length)];
 for(const mode of order){
  const name=`${model}-${mode}-r${round}`,filename=folder+'/'+name+'.json';
  if(!pilot&&fs.existsSync(filename)){
   const previous=JSON.parse(fs.readFileSync(filename));
   if(!previous.failure&&JSON.stringify(previous.config)===JSON.stringify(config)){console.log('SKIP complete',name);continue;}
  }
  const output={name,mode,model,round,started:new Date().toISOString(),config,consoleErrors:[],rss:[],cases:[],sort:[]};
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu','--disable-gpu-vsync','--disable-frame-rate-limit','--no-proxy-server','--enable-precise-memory-info','--js-flags=--expose-gc']});
  output.browser=browser.version();let page,session;const browserSession=await browser.newBrowserCDPSession();const pid=(await browserSession.send('SystemInfo.getProcessInfo')).processInfo.find(p=>p.type==='browser').id;const poll=setInterval(()=>{try{output.rss.push(rss(pid));}catch{}},1500);
  try{
   page=await browser.newPage({viewport:{width:config.logicalWidth,height:config.logicalHeight},deviceScaleFactor:config.dpr});session=await page.context().newCDPSession(page);
   page.on('pageerror',e=>{output.consoleErrors.push(e.message);console.log('PAGE ERROR',mode,e.stack.slice(0,1400));});
   page.on('console',m=>{if(m.type()==='error'){output.consoleErrors.push(m.text());console.log('CONSOLE',mode,m.text().slice(0,450));}});
   output.baseline=rss(pid);console.log('LOAD',name);
   await page.goto(`http://127.0.0.1:${port}/?mode=${mode}&model=${model}`,{waitUntil:'domcontentloaded',timeout:120000});
   await page.waitForFunction(()=>window.ready||window.errors?.length,null,{timeout:300000});
   if(!await page.evaluate(()=>window.ready))throw Error((await page.evaluate(()=>window.errors)).join('\n'));
   output.initialHeap=await collectHeap(browserSession,session);output.initial=await page.evaluate(()=>snapshot());output.initialRss=rss(pid);
   console.log('READY',name,output.initial.loadMs.toFixed(0),'ms',output.initial.state);
   const fast=true;
   for(const scenario of (pilot?[{angle:0,scale:1,moving:false}]:[{angle:0,scale:1,moving:false},{angle:.55,scale:.65,moving:false},{angle:0,scale:1,moving:true}])){
    const settings={variant:'sorted',fast,...scenario,n:pilot?6:64,minMs:pilot?0:1800};
    const result=await page.evaluate(settings=>benchmark(settings),settings);result.heap=await collectHeap(browserSession,session);result.memory=await page.evaluate(()=>snapshot().memory);result.rss=rss(pid);output.cases.push(result);
    if(result.errors.length)throw Error(result.errors.join('\n'));
    console.log('CASE',name,'default',scenario.moving?'moving':`view${scenario.angle}`,median(result.rows.map(r=>r.completionMs)).toFixed(2),'completion ms',result.visible,'visible');
   }
   const sort=await page.evaluate(settings=>sortBenchmark(settings),{fast,n:pilot?3:16});output.sort.push(sort);
   console.log('SORT',name,fast,median(sort.rows.map(r=>r.gpuSortMs??r.updateMs)));
   await page.evaluate(fast=>captureView({fast}),fast);
   if(round===1)await page.screenshot({path:folder+'/'+name+'-sorted.png'});
   const variants=(mode.startsWith('gsl')||mode==='supersplat')?['stochastic','stochastic-resolved']:mode==='pc-gpu'?['stochastic']:[];
   if(!pilot||args.includes('--variants')){
    for(const variant of variants){
     for(const moving of (pilot?[false]:[false,true])){
      const result=await page.evaluate(settings=>benchmark(settings),{variant,moving,n:pilot?6:48,minMs:pilot?0:1500});result.heap=await collectHeap(browserSession,session);result.memory=await page.evaluate(()=>snapshot().memory);result.rss=rss(pid);output.cases.push(result);
      if(result.errors.length)throw Error(result.errors.join('\n'));
      console.log('CASE',name,variant,moving?'moving':'static',median(result.rows.map(r=>r.completionMs)).toFixed(2),'completion ms');
     }
     await page.evaluate(variant=>captureView({variant}),variant);if(round===1)await page.screenshot({path:folder+'/'+name+'-'+variant+'.png'});
    }
   }
   output.heap=await collectHeap(browserSession,session);output.final=await page.evaluate(()=>snapshot());output.finalRss=rss(pid);
  }catch(e){failures++;output.failure=String(e);console.log('FAILED',name,String(e));if(page)try{output.debug=await page.evaluate(()=>({phase:window.phase,progress:window.progress,errors:window.errors,state:window.api?.state?.()}));await page.screenshot({path:folder+'/'+name+'-failure.png'});}catch{}}
  finally{clearInterval(poll);fs.writeFileSync(filename,JSON.stringify(output,null,2));console.log('CLOSE',name);await browser.close();console.log('DONE',name);}
 }
}
}finally{server.close();}
if(failures)process.exitCode=1;
