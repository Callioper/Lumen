// Serves the built static demo (npm run demo) at http://127.0.0.1:8790/ for a look before publishing.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..', 'web', 'dist-demo');
const PORT = Number(process.env.PORT ?? 8790);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(ROOT, path || 'index.html');
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(body);
  } catch {
    res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-cache' }).end(await readFile(join(ROOT, 'index.html')));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`演示版：http://127.0.0.1:${PORT}/`));
