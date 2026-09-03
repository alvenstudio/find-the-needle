// Static host for the spike page plus a sink for its results and captures.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(process.argv[2]);
const OUT = resolve(process.argv[3]);
const PORT = Number(process.argv[4] ?? 5200);
mkdirSync(OUT, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
};

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/save') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const name = normalize(body.name).replace(/^(\.\.[\\/])+/, '');
        const path = join(OUT, name);
        mkdirSync(dirname(path), { recursive: true });
        if (body.dataUrl) {
          writeFileSync(path, Buffer.from(body.dataUrl.slice(body.dataUrl.indexOf(',') + 1), 'base64'));
        } else {
          writeFileSync(path, JSON.stringify(body.json, null, 2), 'utf8');
        }
        console.log('wrote', path);
        res.writeHead(200).end('ok');
      } catch (error) {
        console.error(error);
        res.writeHead(500).end(String(error));
      }
    });
    return;
  }

  const url = new URL(req.url, 'http://x');
  const path = join(ROOT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[\\/])+/, ''));
  const file = url.pathname === '/' ? join(ROOT, 'index.html') : path;
  if (!existsSync(file)) {
    res.writeHead(404).end('not found: ' + url.pathname);
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, '127.0.0.1', () => console.log('spike server http://127.0.0.1:' + PORT + ' root=' + ROOT));
