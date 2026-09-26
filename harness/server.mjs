import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(fs.readFileSync(path.join(root,'config.json')));
const types={'.js':'application/javascript','.mjs':'application/javascript','.json':'application/json','.html':'text/html','.css':'text/css','.png':'image/png','.wasm':'application/wasm'};
export function startServer(port=5349){return new Promise(resolve=>{
 const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost'),p=decodeURIComponent(url.pathname);
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  if(p==='/favicon.ico'){res.writeHead(204);res.end();return;}
  const match=p.match(/^\/models\/(elevator|hotel)\.ply$/);
  const file=match?config.models[match[1]].path:path.resolve(root,p==='/'?'index.html':'.'+p);
  if((!match&&!file.startsWith(root+path.sep))||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
  const size=fs.statSync(file).size;let start=0,end=size-1,status=200;
  res.setHeader('Accept-Ranges','bytes');res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');
  if(req.headers.range){const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!m||+m[1]>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});res.end();return;}start=+m[1];end=m[2]?Math.min(+m[2],end):end;status=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${size}`);}
  res.writeHead(status,{'Content-Length':end-start+1});if(req.method==='HEAD'){res.end();return;}
  const stream=fs.createReadStream(file,{start,end});stream.pipe(res);res.on('close',()=>stream.destroy());
 });server.listen(port,'127.0.0.1',()=>resolve(server));
});}
if(process.argv[1]===fileURLToPath(import.meta.url)){await startServer();console.log('Benchmark: http://127.0.0.1:5349');}
