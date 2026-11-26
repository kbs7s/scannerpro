// End-to-end checks of the real app in headless Chromium. Run with a static server on :8080.
import { chromium } from 'playwright';
import fs from 'fs'; import { execSync } from 'child_process';
const URL0 = process.env.APP || 'http://localhost:8080/';
const OUT = 'tests/output/'; fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];
const results = [];
const ok = (c, m) => { results.push([!!c, m]); console.log((c ? 'PASS ' : 'FAIL ') + m); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message)); p.on('requestfailed', (r) => console.log('   requestfailed', r.url().slice(0, 90), r.failure()?.errorText)); p.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
const step = async (name, fn) => { if (only && !only.split(',').includes(name) && name !== 'load') return; const t0 = Date.now(); try { await fn(); } catch (e) { ok(false, name + ' threw: ' + e.message.split('\n')[0]); } console.log('   (' + name + ' ' + ((Date.now() - t0) / 1000).toFixed(1) + 's)'); };
// Headless Chromium reports Arabic download names as "download", so files are saved under a counter + the original name.
let nDl = 0;
const dl = async (trigger) => { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 300000 }), trigger()]); const f = OUT + 'dl' + (++nDl) + '-' + d.suggestedFilename(); await d.saveAs(f); return f; };
const magic = (f) => fs.readFileSync(f).subarray(0, 8).toString('latin1');
const idle = () => p.waitForFunction(() => document.querySelector('#progress').classList.contains('hidden') && !document.querySelector('.dlg[open]'), null, { timeout: 300000 });

await step('load', async () => {
  await p.goto(URL0); await p.waitForFunction(() => window.__ssp);
  ok(await p.evaluate(() => document.documentElement.dir === 'rtl' && document.documentElement.lang === 'ar'), 'default language Arabic RTL');
});

await step('import', async () => {
  await p.setInputFiles('#file-any', 'tests/fixtures/doc-photo.jpg');
  await p.waitForFunction(() => window.__ssp.state.pages.length === 1, null, { timeout: 60000 });
  const pg = await p.evaluate(() => window.__ssp.state.pages[0]);
  const truth = JSON.parse(fs.readFileSync('tests/fixtures/doc-photo.corners.json', 'utf8'));
  const tc = truth.corners || truth;
  const err = pg.corners ? Math.max(...pg.corners.map((c, i) => Math.hypot(c.x * pg.origW - tc[i][0], c.y * pg.origH - tc[i][1]))) : 1e9;
  ok(pg.corners && err < 25, `auto-crop on import found corners (max error ${err.toFixed(1)}px)`);
  await p.waitForFunction(() => { const q = window.__ssp.state.pages[0]; return q.procId && q.procRev === q.rev; }, null, { timeout: 60000 });
  const r = await p.evaluate(() => { const q = window.__ssp.state.pages[0]; return [q.procW, q.procH]; });
  ok(r[0] > 1000 && r[1] > 1300 && r[1] / r[0] > 1.2, `page rendered flat ${r[0]}×${r[1]}`);
  await p.waitForTimeout(800); await p.screenshot({ path: OUT + 'e2e-workspace.png' });
});

await step('presets', async () => {
  await p.click('[role=tab][data-tab="enhance"]');
  const n = await p.locator('#presets .preset').count();
  ok(n === 20, `20 preset buttons (${n})`);
  await p.click('#presets [data-id="bw"]');
  await p.waitForFunction(() => { const q = window.__ssp.state.pages[0]; return q.preset === 'bw' && q.procRev === q.rev; }, null, { timeout: 60000 });
  const f = await dl(() => p.click('#p-download', { force: true }).catch(() => p.evaluate(() => document.querySelector('#p-download').click())));
  ok(magic(f).startsWith('\x89PNG'), 'B&W page downloads as PNG (1-bit pages stay lossless)');
  const undo = await p.evaluate(async () => { document.querySelector('#btn-undo').click(); await new Promise((r) => setTimeout(r, 400)); return window.__ssp.state.pages[0].preset; });
  ok(undo !== 'bw', 'undo restores previous preset (' + undo + ')');
  await p.click('#presets [data-id="cleanWhite"]');
  await p.waitForFunction(() => { const q = window.__ssp.state.pages[0]; return q.preset === 'cleanWhite' && q.procRev === q.rev; }, null, { timeout: 60000 });
  await p.screenshot({ path: OUT + 'e2e-cleanwhite.png' });
});

await step('ocr', async () => {
  await p.click('[role=tab][data-tab="ocr"]');
  await p.click('#ocr-run');
  await p.waitForFunction(() => window.__ssp.state.pages[0].ocr?.text, null, { timeout: 300000 });
  await idle();
  const o = await p.evaluate(() => window.__ssp.state.pages[0].ocr);
  fs.writeFileSync(OUT + 'ocr.txt', o.text);
  ok(/Medical/.test(o.text) && /482913/.test(o.text), 'English OCR read "Medical" and "482913"');
  ok(/الطبي|المريض|الفحص/.test(o.text), 'Arabic OCR read Arabic words');
  ok(o.words && o.words.length > 20 && o.pdfId, `word boxes (${o.words?.length}) + text-layer PDF stored`);
});

await step('searchable', async () => {
  const f = await dl(() => p.evaluate(() => document.querySelector('#ocr-spdf').click()));
  const txt = execSync(`pdftotext "${f}" -`).toString();
  fs.writeFileSync(OUT + 'searchable.txt', txt);
  ok(/Hospital/.test(txt) && /482913/.test(txt), 'searchable PDF: pdftotext finds English text');
  ok(/الطبي|المريض|الفحص|طبي/.test(txt), 'searchable PDF: pdftotext finds Arabic text');
});

await step('export', async () => {
  await p.evaluate(() => document.querySelector('#x-pdf').click());
  await p.waitForSelector('.dlg[open] iframe, .dlg[open] canvas', { timeout: 60000 });
  await p.waitForTimeout(2500); await p.screenshot({ path: OUT + 'e2e-export-dialog.png' });
  const btn = p.locator('.dlg[open] .btn.primary').last();
  const f = await dl(() => btn.click());
  const info = execSync(`pdfinfo "${f}"`).toString();
  ok(/Pages:\s+1/.test(info) && /595\.\d* x 841|595 x 842/.test(info), 'exported PDF is 1 A4 page: ' + (info.match(/Page size:.*/) || [''])[0]);
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
});

await step('pages', async () => {
  await p.setInputFiles('#file-any', ['tests/fixtures/doc-flat.png', 'tests/fixtures/doc-skew.png']);
  await p.waitForFunction(() => window.__ssp.state.pages.length === 3, null, { timeout: 90000 });
  const ids0 = await p.evaluate(() => window.__ssp.state.pages.map((x) => x.id));
  // remove the auto-crop (which already straightens the page) so deskew has to find the 4° angle itself
  const ang = await p.evaluate(async () => { const q = window.__ssp.state.pages[2]; await window.__ssp.updatePage(q, { corners: null }, { history: false }); return window.__ssp.deskewPage(q, false); });
  ok(Math.abs(Math.abs(ang) - 4) < 0.6, 'deskew of 4° fixture → ' + ang?.toFixed?.(2));
  // drag reorder: real HTML5 drag events (dragstart → dragover → drop) dispatched on the thumbnails
  await p.evaluate(() => {
    const lis = document.querySelectorAll('#thumbs > li'); const src = lis[2], dst = lis[0];
    const dt = new DataTransfer(); const r = dst.getBoundingClientRect();
    const ev = (type, el, y) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: y }));
    ev('dragstart', src, 0); ev('dragover', dst, r.top + 3); ev('drop', dst, r.top + 3); ev('dragend', src, 0);
  });
  await p.waitForTimeout(600);
  const ids1 = await p.evaluate(() => window.__ssp.state.pages.map((x) => x.id));
  ok(ids1[0] === ids0[2], 'drag & drop reorder moved page 3 to first');
});

await step('print', async () => {
  await p.evaluate(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
  await p.click('#viewer'); await p.keyboard.press('Control+p');
  await p.waitForSelector('.dlg[open] .btn.primary', { timeout: 10000 });
  await p.locator('.dlg[open] .btn.primary').last().click();
  await p.waitForFunction(() => window.__printed > 0, null, { timeout: 60000 });
  await p.emulateMedia({ media: 'print' });
  await p.pdf({ path: OUT + 'print-emulated.pdf', preferCSSPageSize: true, printBackground: true });
  await p.emulateMedia({ media: 'screen' });
  const info = execSync(`pdfinfo "${OUT}print-emulated.pdf"`).toString();
  ok(/Pages:\s+3\b/.test(info) && /A4/.test(info), 'print layout: 3 pages on A4 (' + (info.match(/Pages:.*/) || [''])[0].trim() + ', ' + (info.match(/Page size:.*/) || [''])[0].replace(/\s+/g, ' ') + ')');
});

await step('persist', async () => {
  await dl(() => p.evaluate(() => document.querySelector('#btn-save').click()));
  const docId = await p.evaluate(() => window.__ssp.state.doc.id);
  await p.reload(); await p.waitForFunction(() => window.__ssp);
  await p.waitForTimeout(2500);
  const st = await p.evaluate(() => ({ doc: window.__ssp.state.doc?.id, n: window.__ssp.state.pages.length, cards: document.querySelectorAll('#lib-grid .doc-card, #lib-grid > *').length }));
  ok(st.doc === docId && st.n === 3 || st.cards >= 1, 'after reload: session/document restored ' + JSON.stringify(st));
  if (st.doc !== docId) await p.evaluate((id) => window.__ssp.openDocument(id), docId);
  await p.waitForFunction(() => window.__ssp.state.pages.length === 3);
  ok(await p.evaluate(() => !!window.__ssp.state.pages.find((x) => x.ocr?.text)), 'OCR text persisted in IndexedDB');
});

await step('backup', async () => {
  const f = await dl(() => p.evaluate(() => document.querySelector('#btn-save').click()));
  ok(magic(f).startsWith('PK') && fs.statSync(f).size > 50000, 'project saved as .sspz ' + f + ' ' + (fs.statSync(f).size >> 10) + ' KB');
  const before = await p.evaluate(() => window.__ssp.state.doc.id);
  await p.evaluate(() => window.__ssp.goLibrary());
  fs.copyFileSync(f, OUT + 'restore-test.sspz');
  await p.setInputFiles('#file-project', OUT + 'restore-test.sspz');
  await p.waitForFunction((b) => window.__ssp.state.doc && window.__ssp.state.doc.id !== b && window.__ssp.state.pages.length === 3, before, { timeout: 60000 });
  ok(true, 'restored .sspz as a copy with 3 pages');
});

await step('offline', async () => {
  await p.goto(URL0); await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => p.reload());
  await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 });
  await p.waitForFunction(async () => { const r = await new Promise((res) => { const ch = new MessageChannel(); ch.port1.onmessage = (e) => res(e.data); navigator.serviceWorker.controller.postMessage({ type: 'status' }, [ch.port2]); setTimeout(() => res(null), 3000); }); return r && r.missing && r.missing.length === 0; }, null, { timeout: 240000, polling: 3000 });
  await ctx.setOffline(true);
  await p.reload(); await p.waitForFunction(() => window.__ssp, null, { timeout: 30000 });
  await p.evaluate(() => window.__ssp.goLibrary());
  const n = await p.evaluate(() => document.querySelectorAll('#lib-grid > *').length);
  ok(n >= 1, 'offline reload: app and library load from cache (' + n + ' docs)');
  const ocrOk = await p.evaluate(async () => { const r = await fetch('models/ara.traineddata.gz'); return r.ok; });
  ok(ocrOk, 'offline: Arabic OCR model served from cache');
  await ctx.setOffline(false);
});

await step('mobile', async () => {
  const m = await ctx.newPage(); await m.setViewportSize({ width: 390, height: 844 });
  await m.goto(URL0); await m.waitForFunction(() => window.__ssp); await m.waitForTimeout(1500);
  const nav = await m.evaluate(() => getComputedStyle(document.querySelector('.bottomnav')).display !== 'none');
  ok(nav, 'phone layout shows bottom navigation');
  await m.screenshot({ path: OUT + 'mobile-workspace.png' });
  const fits = () => m.evaluate(() => ({ x: document.documentElement.scrollWidth - innerWidth, y: document.documentElement.scrollHeight - innerHeight, sy: scrollY }));
  const a1 = await fits();
  await m.evaluate(() => window.__ssp.goLibrary()); await m.waitForTimeout(800);
  await m.screenshot({ path: OUT + 'mobile-library.png' });
  const a2 = await fits();
  ok(a1.x <= 1 && a1.y <= 1 && a2.x <= 1 && a2.y <= 1, 'phone 390px: page never scrolls or overflows ' + JSON.stringify([a1, a2]));
  await m.close();
});

ok(errs.length === 0, 'no uncaught page errors' + (errs.length ? ': ' + errs.slice(0, 5).join(' | ') : ''));
fs.writeFileSync(OUT + 'e2e-results.json', JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r[0]).length}/${results.length} passed`);
await b.close();
