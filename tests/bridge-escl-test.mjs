// Exercises bridge/scanner-bridge.js against a mock eSCL scanner (protocol test only; no real hardware).
import http from 'http'; import { spawn } from 'child_process'; import fs from 'fs';
const jpg = fs.readFileSync(new URL('./fixtures/doc-photo.jpg', import.meta.url));
let pagesLeft = 0, lastSettings = '';
const mock = http.createServer((q, r) => {
  if (q.url === '/eSCL/ScannerCapabilities') { r.writeHead(200, { 'Content-Type': 'text/xml' }); return r.end('<scan:ScannerCapabilities xmlns:scan="x" xmlns:pwg="y"><pwg:MakeAndModel>Mock MFP 9000</pwg:MakeAndModel><scan:Adf><scan:AdfDuplex/></scan:Adf></scan:ScannerCapabilities>'); }
  if (q.method === 'POST' && q.url === '/eSCL/ScanJobs') { let b = ''; q.on('data', (c) => b += c); q.on('end', () => { lastSettings = b; pagesLeft = b.includes('Feeder') ? 3 : 1; r.writeHead(201, { Location: '/eSCL/ScanJobs/42' }); r.end(); }); return; }
  if (q.url === '/eSCL/ScanJobs/42/NextDocument') { if (pagesLeft-- > 0) { r.writeHead(200, { 'Content-Type': 'image/jpeg' }); return r.end(jpg); } r.writeHead(404); return r.end(); }
  r.writeHead(404); r.end();
}).listen(7911);
const br = spawn(process.execPath, ['bridge/scanner-bridge.js', '--port', '7899', '--escl', 'http://127.0.0.1:7911/eSCL'], { stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 600));
const B = 'http://127.0.0.1:7899';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const st = await (await fetch(B + '/api/status', { headers: { Origin: 'https://kbs7s.github.io' } }));
ok(st.headers.get('access-control-allow-origin') === 'https://kbs7s.github.io', 'CORS for GitHub Pages origin');
ok(st.headers.get('access-control-allow-private-network') === 'true', 'Private Network Access header');
const bad = await fetch(B + '/api/status', { headers: { Origin: 'https://evil.example' } }); ok(bad.status === 403, 'foreign origin rejected');
const pre = await fetch(B + '/api/scan', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8080', 'Access-Control-Request-Method': 'POST' } }); ok(pre.status === 204, 'preflight 204');
const list = await (await fetch(B + '/api/scanners')).json();
ok(list.scanners.length === 1 && list.scanners[0].name === 'Mock MFP 9000', 'eSCL scanner listed: ' + JSON.stringify(list.scanners.map((s) => s.name)));
const id = list.scanners[0].id;
let s = await (await fetch(B + '/api/scan', { method: 'POST', body: JSON.stringify({ scannerId: id, source: 'flatbed', color: 'gray', dpi: 300, paperSize: 'a4' }) })).json();
ok(s.pages.length === 1 && Buffer.from(s.pages[0].data, 'base64').equals(jpg), 'flatbed returned 1 page byte-identical');
ok(/Platen/.test(lastSettings) && /Grayscale8/.test(lastSettings) && /<scan:XResolution>300/.test(lastSettings) && /<pwg:Width>2480</.test(lastSettings), 'ScanSettings XML (Platen, Grayscale8, 300dpi, A4 width 2480)');
s = await (await fetch(B + '/api/scan', { method: 'POST', body: JSON.stringify({ scannerId: id, source: 'duplex', color: 'color', dpi: 200, paperSize: 'letter' }) })).json();
ok(s.pages.length === 3, 'feeder/duplex returned all 3 pages');
ok(/<scan:Duplex>true/.test(lastSettings) && /RGB24/.test(lastSettings), 'duplex + RGB24 requested');
br.kill(); mock.close();
