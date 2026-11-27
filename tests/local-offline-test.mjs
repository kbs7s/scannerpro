// Runs the app from run-local/server.js, saves a document with OCR, stops the server and goes offline,
// then reopens the browser profile: the app, the saved document and OCR must all still work.
import { chromium } from 'playwright';
import { spawn } from 'child_process'; import fs from 'fs'; import os from 'os'; import path from 'path';
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const PORT = 8097, URL0 = `http://localhost:${PORT}/`;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-profile-'));
let srv = spawn(process.execPath, ['run-local/server.js', '--port', String(PORT), '--no-open'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));
let ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1300, height: 850 } });
let p = ctx.pages()[0] || await ctx.newPage();
await p.goto(URL0); await p.waitForFunction(() => window.__ssp);
await p.setInputFiles('#file-any', 'tests/fixtures/doc-photo.jpg');
await p.waitForFunction(() => window.__ssp.state.pages.length === 1, null, { timeout: 60000 });
await p.evaluate(async () => { await window.__ssp.batchOcr(window.__ssp.state.pages); });
const docId = await p.evaluate(() => window.__ssp.state.doc.id);
// wait until every app file (incl. OCR models) is in the offline cache
await p.waitForFunction(async () => { const c = navigator.serviceWorker.controller; if (!c) return false; const r = await new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); c.postMessage({ type: 'status' }, [ch.port2]); setTimeout(() => res(null), 3000); }); return r && r.missing.length === 0; }, null, { timeout: 240000, polling: 2000 });
ok(true, 'all app files cached for offline use');
await ctx.close();
srv.kill(); await new Promise((r) => setTimeout(r, 500));
ok(await fetch(URL0).then(() => false, () => true), 'launcher stopped (nothing listening any more)');
// reopen the same browser profile with no server and no network
ctx = await chromium.launchPersistentContext(profile, { viewport: { width: 1300, height: 850 }, offline: true });
p = ctx.pages()[0] || await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(URL0); await p.waitForFunction(() => window.__ssp, null, { timeout: 30000 });
ok(true, 'app opens with the launcher closed and no network');
await p.waitForTimeout(1500);
if ((await p.evaluate(() => window.__ssp.state.doc?.id)) !== docId) await p.evaluate((id) => window.__ssp.openDocument(id), docId);
const pg = await p.evaluate(() => window.__ssp.state.pages[0]);
ok(pg && /482913/.test(pg.ocr?.text || ''), 'saved document and its OCR text are still there');
await p.evaluate(async () => { const q = window.__ssp.state.pages[0]; await window.__ssp.updatePage(q, { ocr: null }, { history: false, rerender: false }); await window.__ssp.batchOcr([q]); });
const again = await p.evaluate(() => window.__ssp.state.pages[0].ocr?.text || '');
ok(/482913/.test(again) && /الطبي|المريض|الفحص/.test(again), 'OCR runs again fully offline (Arabic + English)');
const buf = await p.evaluate(async () => { const b = await window.__ssp.buildPdf(window.__ssp.state.pages, window.__ssp.defaultExportOptions()); return b.length; });
ok(buf > 10000, 'PDF export works offline (' + (buf >> 10) + ' KB)');
ok(!errs.length, 'no page errors ' + errs.join(' | '));
await ctx.close(); fs.rmSync(profile, { recursive: true, force: true });
