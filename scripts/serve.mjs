// Serves dist/ at http://127.0.0.1:8080 for playing online locally: the page then finds
// Nakama on the same host, port 7350. Open one browser tab per player.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const port = Number(process.env.PORT || 8080);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([\\/]\.\.)+/, '');
  const file = join(dist, path.endsWith('/') || path.endsWith('\\') ? 'index.html' : path);
  try {
    if (!file.startsWith(dist)) throw new Error('outside dist');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Thulla at http://127.0.0.1:${port}/  (run \`npm run build:web\` after changes)`));
