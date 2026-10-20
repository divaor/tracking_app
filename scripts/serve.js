// Serves the web app locally: `npm run web` then open http://localhost:8080
// (set PORT to change the port, HOST=0.0.0.0 to reach it from your phone on the same Wi-Fi).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const appDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'app');
const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || 'localhost';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  const file = path.normalize(path.join(appDir, decodeURIComponent(pathname.endsWith('/') ? `${pathname}index.html` : pathname)));
  if (!file.startsWith(appDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, host, () => console.log(`Tracker web app: http://${host}:${port}`));
