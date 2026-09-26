import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildSite } from './build-site.mjs';
// Production builds replace site/. Keep the running server's modules separate.
const root = fs.mkdtempSync(path.join(os.tmpdir(), '3dgs-renderer-bench-'));
await buildSite(root);
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
let port = Number(process.env.PORT ?? 5349);
const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch { res.writeHead(400).end(); return; }
  if (pathname === '/test') { res.writeHead(302, { Location: '/test/' }).end(); return; }
  const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
server.on('error', error => {
  if (error.code === 'EADDRINUSE' && !process.env.PORT && port < 65535) {
    console.log(`Port ${port} is in use; trying ${port + 1}.`);
    server.listen(++port, '127.0.0.1');
    return;
  }
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Stop the existing server or choose another PORT.` : error.message);
  process.exit(1);
});
server.on('listening', () => console.log(`3DGS Renderer Bench: http://127.0.0.1:${server.address().port}/test/`));
server.listen(port, '127.0.0.1');
