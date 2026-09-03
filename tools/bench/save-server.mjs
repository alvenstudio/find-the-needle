// Throwaway sink for benchmark output: JSON results and PNG captures.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const OUT = process.argv[2] || './bench-out';
mkdirSync(OUT, { recursive: true });

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(404).end('no'); return; }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const name = normalize(body.name).replace(/^(\.\.[\/])+/, '');
      const path = join(OUT, name);
      mkdirSync(dirname(path), { recursive: true });
      if (body.dataUrl) {
        const b64 = body.dataUrl.slice(body.dataUrl.indexOf(',') + 1);
        writeFileSync(path, Buffer.from(b64, 'base64'));
      } else {
        writeFileSync(path, typeof body.text === 'string' ? body.text : JSON.stringify(body.json, null, 2), 'utf8');
      }
      console.log('wrote', path);
      res.writeHead(200).end('ok');
    } catch (error) {
      console.error(error);
      res.writeHead(500).end(String(error));
    }
  });
});
server.listen(5199, '127.0.0.1', () => console.log('save-server on http://127.0.0.1:5199 ->', OUT));
