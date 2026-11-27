#!/usr/bin/env node
// Runs Smart Scanner Pro from this folder on your own computer, with no internet and no website.
// Zero dependencies. Listens only on 127.0.0.1 (not reachable from other devices).
// Usage: node run-local/server.js [--port 8090] [--no-open]
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const PORT = +(argv[argv.indexOf('--port') + 1] || 0) || 8090;
const OPEN = !argv.includes('--no-open');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};
// Only the app itself is served, never tests, tools or other files on your computer.
const ALLOWED = /^\/(index\.html|manifest\.json|service-worker\.js|(css|js|libs|models|assets)\/.+)$/;

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { res.writeHead(400); return res.end(); }
  if (p === '/') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!ALLOWED.test(p) || !file.startsWith(ROOT + path.sep)) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache', // the service worker does the offline caching
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is the app already running? Open http://localhost:${PORT}/ or use --port <n>.`);
  else console.error(e.message);
  process.exit(1);
});
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}/`;
  console.log('Smart Scanner Pro is running at ' + url);
  console.log('Your documents are saved inside this browser on this computer. Keep this window open; close it to stop.');
  if (OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd, () => {});
  }
});
