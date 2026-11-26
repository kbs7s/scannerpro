#!/usr/bin/env node
// Smart Scanner Pro — local scanner bridge.
//
// A web page cannot talk to USB/WIA/TWAIN/SANE scanners directly. This small, dependency-free
// Node.js program runs on YOUR computer, listens only on 127.0.0.1, and exposes a tiny HTTP API
// that the web app calls. It drives scanners through two real backends:
//
//   1. NAPS2 console (https://www.naps2.com) — WIA / TWAIN (Windows), SANE (Linux), Apple ICA (macOS), eSCL.
//   2. eSCL / AirScan network scanners directly (most modern network/Wi-Fi scanners and MFPs).
//
// Usage:  node scanner-bridge.js [--port 7800] [--naps2 "C:\\Program Files\\NAPS2\\NAPS2.Console.exe"]
//                                [--escl http://192.168.1.50:80/eSCL] [--origin https://you.github.io]
//
// API (JSON unless stated):
//   GET  /api/status    → { version, naps2: { found, path }, escl: [urls] }
//   GET  /api/scanners  → { scanners: [{ id, name, backend: 'naps2'|'escl', driver? }] }
//   POST /api/scan      { scannerId, source: flatbed|feeder|duplex, color: color|gray|bw, dpi, paperSize, preview }
//                       → application/pdf (NAPS2) or { pages: [{ mime, data(base64) }] } (eSCL)
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION = '1.0.0';
const args = parseArgs(process.argv.slice(2));
const PORT = +(args.port || process.env.SSP_BRIDGE_PORT || 7800);
const ESCL = [].concat(args.escl || []).concat((process.env.SSP_ESCL || '').split(',').filter(Boolean)).map((u) => u.replace(/\/$/, ''));
const ORIGINS = new Set([
  'https://kbs7s.github.io',
  ...[].concat(args.origin || []),
  ...(process.env.SSP_ORIGINS || '').split(',').filter(Boolean),
]);
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    const k = a[i].slice(2); const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true;
    o[k] = o[k] === undefined ? v : [].concat(o[k], v);
  }
  if (o.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  return o;
}

// ---------- NAPS2 ----------
function findNaps2() {
  const cands = [];
  if (args.naps2) cands.push(String(args.naps2));
  if (process.env.NAPS2_CONSOLE) cands.push(process.env.NAPS2_CONSOLE);
  if (process.platform === 'win32') {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) cands.push(path.join(base, 'NAPS2', 'NAPS2.Console.exe'));
    }
  } else if (process.platform === 'darwin') {
    cands.push('/Applications/NAPS2.app/Contents/MacOS/NAPS2');
  } else {
    cands.push('/usr/bin/naps2', '/usr/local/bin/naps2', '/opt/naps2/naps2', '/var/lib/flatpak/exports/bin/com.naps2.Naps2');
  }
  return cands.find((c) => { try { return fs.statSync(c).isFile(); } catch (_) { return false; } }) || null;
}
// NAPS2 on macOS/Linux is one binary; the console mode is the "console" sub-command.
function naps2Cmd(bin, argv) {
  const isConsoleExe = /NAPS2\.Console(\.exe)?$/i.test(bin);
  return [bin, isConsoleExe ? argv : ['console', ...argv]];
}
function run(bin, argv, timeout) {
  return new Promise((resolve, reject) => {
    execFile(bin, argv, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) { err.message = (stderr || stdout || err.message).toString().trim().slice(0, 800) || err.message; reject(err); }
      else resolve(stdout.toString());
    });
  });
}
const NAPS2_DRIVERS = process.platform === 'win32' ? ['wia', 'twain', 'escl'] : process.platform === 'darwin' ? ['apple', 'sane', 'escl'] : ['sane', 'escl'];

async function naps2List(bin) {
  const out = [];
  for (const driver of NAPS2_DRIVERS) {
    try {
      const [b, a] = naps2Cmd(bin, ['--listdevices', '--driver', driver]);
      const txt = await run(b, a, 45000);
      for (const line of txt.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        if (/^(error|no devices|warning)/i.test(line)) continue;
        out.push({ id: 'naps2:' + driver + ':' + line, name: line, backend: 'naps2', driver });
      }
    } catch (e) { log('NAPS2 list (' + driver + ') failed: ' + e.message); }
  }
  return out;
}
const PAPER = { a4: 'a4', letter: 'letter', legal: 'legal', a5: 'a5', a3: 'a3' };
async function naps2Scan(bin, dev, o) {
  const [, driver, ...rest] = dev.split(':'); const device = rest.join(':');
  const tmp = path.join(os.tmpdir(), 'ssp-scan-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.pdf');
  const argv = ['-o', tmp, '--noprofile', '--force', '--driver', driver, '--device', device,
    '--source', { flatbed: 'glass', feeder: 'feeder', duplex: 'duplex' }[o.source] || 'glass',
    '--dpi', String(clampDpi(o.dpi)),
    '--bitdepth', { color: 'color', gray: 'gray', bw: 'bw' }[o.color] || 'color',
    '--pagesize', PAPER[o.paperSize] || 'a4'];
  const [b, a] = naps2Cmd(bin, argv);
  log('NAPS2 scan: ' + driver + ' / ' + device);
  await run(b, a, 15 * 60 * 1000);
  try { const buf = fs.readFileSync(tmp); return buf; } finally { fs.rm(tmp, { force: true }, () => {}); }
}
const clampDpi = (d) => Math.max(75, Math.min(1200, +d || 300));

// ---------- eSCL ----------
function req(url, { method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const lib = u.protocol === 'https:' ? https : http;
    const r = lib.request(u, { method, headers, timeout, rejectUnauthorized: false /* scanners use self-signed certs */ }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout: ' + url)));
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const tag = (xml, name) => { const m = xml.match(new RegExp('<(?:\\w+:)?' + name + '>([^<]*)</(?:\\w+:)?' + name + '>')); return m ? m[1] : null; };
async function esclList() {
  const out = [];
  for (const base of ESCL) {
    try {
      const r = await req(base + '/ScannerCapabilities', { timeout: 8000 });
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      const x = r.body.toString();
      out.push({ id: 'escl:' + base, name: tag(x, 'MakeAndModel') || base, backend: 'escl', caps: { adf: /Adf/.test(x), duplex: /AdfDuplex/.test(x) } });
    } catch (e) { log('eSCL ' + base + ' unreachable: ' + e.message); }
  }
  return out;
}
async function esclScan(base, o) {
  const dpi = clampDpi(o.dpi);
  const mm = { a4: [210, 297], letter: [215.9, 279.4], legal: [215.9, 355.6], a5: [148, 210], a3: [297, 420] }[o.paperSize] || [210, 297];
  const toUnits = (v) => Math.round((v / 25.4) * 300); // eSCL regions are in 1/300 inch
  const src = { flatbed: 'Platen', feeder: 'Feeder', duplex: 'Feeder' }[o.source] || 'Platen';
  const mode = { color: 'RGB24', gray: 'Grayscale8', bw: 'BlackAndWhite1' }[o.color] || 'RGB24';
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.6</pwg:Version>
  <pwg:ScanRegions><pwg:ScanRegion><pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    <pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset><pwg:Width>${toUnits(mm[0])}</pwg:Width><pwg:Height>${toUnits(mm[1])}</pwg:Height>
  </pwg:ScanRegion></pwg:ScanRegions>
  <pwg:InputSource>${src}</pwg:InputSource>
  <scan:Duplex>${o.source === 'duplex'}</scan:Duplex>
  <scan:ColorMode>${mode}</scan:ColorMode>
  <scan:XResolution>${dpi}</scan:XResolution><scan:YResolution>${dpi}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
  const r = await req(base + '/ScanJobs', { method: 'POST', body: xml, headers: { 'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml) } });
  if (r.status !== 201 || !r.headers.location) throw new Error('eSCL scan job rejected (HTTP ' + r.status + '): ' + r.body.toString().slice(0, 300));
  const job = new URL(r.headers.location, base + '/').toString().replace(/\/$/, '');
  const pages = [];
  for (let i = 0; i < 500; i++) {
    const d = await req(job + '/NextDocument', { timeout: 5 * 60 * 1000 });
    if (d.status === 404 || d.status === 410) break; // no more pages
    if (d.status === 503) { await new Promise((res) => setTimeout(res, 1000)); i--; continue; } // busy, retry
    if (d.status !== 200) throw new Error('eSCL NextDocument HTTP ' + d.status);
    pages.push({ mime: (d.headers['content-type'] || 'image/jpeg').split(';')[0], data: d.body.toString('base64') });
    if (src === 'Platen') break; // flatbed: exactly one page
  }
  if (!pages.length) throw new Error('Scanner returned no pages (is there paper in the feeder?)');
  return pages;
}

// ---------- HTTP ----------
function log(m) { console.log(new Date().toISOString().slice(11, 19) + ' ' + m); }
function cors(reqq, res) {
  const o = reqq.headers.origin;
  if (o && (ORIGINS.has(o) || LOCAL_ORIGIN.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome Private Network Access preflight
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }
  return !o; // same-machine tools without Origin (curl) are allowed
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(r) {
  return new Promise((resolve, reject) => {
    let s = ''; r.on('data', (c) => { s += c; if (s.length > 1e5) r.destroy(); });
    r.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Invalid JSON')); } });
    r.on('error', reject);
  });
}

let busy = false;
const server = http.createServer(async (rq, res) => {
  const allowed = cors(rq, res);
  if (!allowed) return json(res, 403, { error: 'Origin not allowed: ' + rq.headers.origin + ' (start the bridge with --origin ' + rq.headers.origin + ')' });
  if (rq.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(rq.url, 'http://127.0.0.1');
  try {
    if (rq.method === 'GET' && url.pathname === '/api/status') {
      const p = findNaps2();
      return json(res, 200, { version: VERSION, platform: process.platform, naps2: { found: !!p, path: p }, escl: ESCL, busy });
    }
    if (rq.method === 'GET' && url.pathname === '/api/scanners') {
      const p = findNaps2();
      const list = [...(p ? await naps2List(p) : []), ...(await esclList())];
      return json(res, 200, { scanners: list });
    }
    if (rq.method === 'POST' && url.pathname === '/api/scan') {
      if (busy) return json(res, 409, { error: 'A scan is already running' });
      const o = await readBody(rq);
      const id = String(o.scannerId || '');
      busy = true;
      try {
        if (id.startsWith('naps2:')) {
          const p = findNaps2(); if (!p) return json(res, 500, { error: 'NAPS2 not found' });
          const pdf = await naps2Scan(p, id, o);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store' });
          return res.end(pdf);
        }
        if (id.startsWith('escl:')) {
          const base = id.slice(5);
          if (!ESCL.includes(base)) return json(res, 400, { error: 'Unknown eSCL scanner' });
          return json(res, 200, { pages: await esclScan(base, o) });
        }
        return json(res, 400, { error: 'Unknown scanner id' });
      } finally { busy = false; }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    log('Error: ' + e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const p = findNaps2();
  log(`Smart Scanner Pro bridge v${VERSION} on http://127.0.0.1:${PORT}`);
  log('NAPS2: ' + (p || 'not found (install from https://www.naps2.com or pass --naps2 <path>)'));
  log('eSCL scanners: ' + (ESCL.length ? ESCL.join(', ') : 'none (pass --escl http://<scanner-ip>/eSCL)'));
  log('Allowed web origins: ' + [...ORIGINS].join(', ') + ', http(s)://localhost');
});
server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Use --port <n>.` : e.message); process.exit(1); });
