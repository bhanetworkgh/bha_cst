import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Browser acceptance serves the copied production assets, not the source tree.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/web');
const port = Number(process.env.PORT || 3000);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp' };

const server = http.createServer((req, res) => {
  const requested = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (error, body) => {
    if (error) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});

server.listen(port, '127.0.0.1');
