// Smoke test for js/workers/image-worker.js against fixtures.
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.env.BASE || 'http://localhost:8080/';
fs.mkdirSync('tests/output', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
await page.goto(base + 'tests/blank.html');
const r = await page.evaluate(async () => {
  const w = new Worker('../js/workers/image-worker.js');
  let id = 0; const pend = {};
  w.onmessage = (e) => { const p = pend[e.data.id]; delete pend[e.data.id]; e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); };
  const call = (op, payload) => new Promise((res, rej) => { const i = ++id; pend[i] = { res, rej }; w.postMessage({ id: i, op, payload }); });
  const load = async (u) => { const b = await (await fetch(u)).blob(); const bm = await createImageBitmap(b); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext('2d'); x.drawImage(bm, 0, 0); return x.getImageData(0, 0, bm.width, bm.height); };
  const toUrl = async (img) => { const c = new OffscreenCanvas(img.width, img.height); c.getContext('2d').putImageData(img, 0, 0); const b = await c.convertToBlob({ type: 'image/png' }); return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); }); };
  const t0 = performance.now();
  const info = await call('init');
  const tInit = performance.now() - t0;
  const photo = await load('fixtures/doc-photo.jpg');
  let t = performance.now();
  const det = await call('detect', { image: photo, opts: { analyse: true } });
  const tDet = performance.now() - t;
  const out = {};
  const presets = {
    clean: { bgClean: 100, whiten: 70, textPreserve: 30, colorBgReduce: 60, sharpen: 25 },
    bw: { mode: 'bw', bgClean: 80, bgNoise: 30 },
    text: { bgClean: 80, whiten: 40, textPreserve: 45, sharpen: 55, mode: 'gray' },
  };
  for (const [k, p] of Object.entries(presets)) {
    t = performance.now();
    const res = await call('process', { image: await load('fixtures/doc-photo.jpg'), state: { corners: det.corners, params: p }, wantBase: k === 'clean' });
    out[k] = { url: await toUrl(res.image), ms: performance.now() - t, w: res.image.width, h: res.image.height };
    if (res.base) out.base = { url: await toUrl(res.base) };
  }
  const sk = await call('deskew', { image: await load('fixtures/doc-skew.png'), state: {} });
  const fixed = await call('process', { image: await load('fixtures/doc-skew.png'), state: { angle: sk.angle, params: {} } });
  out.deskewed = { url: await toUrl(fixed.image) };
  const ori = await call('orientation', { image: await load('fixtures/doc-flat.png'), state: { rotation: 90 } });
  const multi = await call('detectMulti', { image: photo, opts: {} });
  return { info, tInit, det, tDet, sk, ori, multi: multi.docs.length, out: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v])) };
});
for (const [k, v] of Object.entries(r.out)) { fs.writeFileSync(`tests/output/worker-${k}.png`, Buffer.from(v.url.split(',')[1], 'base64')); delete v.url; }
console.log(JSON.stringify(r, null, 1));
console.log('expected corners (px):', fs.readFileSync('tests/fixtures/doc-photo.corners.json', 'utf8'), 'image 1600x2000');
await browser.close();
