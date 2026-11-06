import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(harness);
const config = JSON.parse(fs.readFileSync(path.join(harness, 'config.json')));
const types = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};
// The harness shares the repository's dependencies and lab modules; everything else is served
// from harness/. Models are only reachable through their configured paths.
const mounts = [
  ['/node_modules/', path.join(repository, 'node_modules')],
  ['/lab/', path.join(repository, 'lab')],
  ['/', harness],
];

function resolveFile(pathname) {
  const model = pathname.match(/^\/models\/([a-z0-9-]+)\.(ply|sog)$/);
  if (model)
    return (
      config.models[model[1]] && path.resolve(harness, config.models[model[1]].path.replace(/\.ply$/, `.${model[2]}`))
    );
  const [prefix, root] = mounts.find(([prefix]) => pathname.startsWith(prefix));
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname.slice(prefix.length - 1)));
  return file.startsWith(root + path.sep) ? file : null;
}

function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  // Cross-origin isolation enables SharedArrayBuffer and precise timers for every renderer.
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const file = resolveFile(pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('Not found');
    return;
  }
  const size = fs.statSync(file).size;
  let start = 0,
    end = size - 1,
    status = 200;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
  if (req.headers.range) {
    const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
    if (!range || +range[1] >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    start = +range[1];
    end = range[2] ? Math.min(+range[2], end) : end;
    status = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.writeHead(status, { 'Content-Length': end - start + 1 });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(file, { start, end });
  stream.pipe(res);
  res.on('close', () => stream.destroy());
}

export function startServer(port = 5349) {
  return new Promise(resolve => {
    const server = http.createServer(handle);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5349);
  await startServer(port);
  console.log(`Benchmark canvas: http://127.0.0.1:${port}/?mode=gsl-gl&model=elevator`);
}
