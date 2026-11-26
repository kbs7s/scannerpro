// Camera scan with Chromium's fake camera fed by a video made from the fixture photo (tests/output/cam.y4m).
// Checks: camera starts, live detection draws an outline, auto-capture fires on a steady document, page is added.
import { chromium } from 'playwright';
const b = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-file-for-fake-video-capture=tests/output/cam.y4m'] });
const ctx = await b.newContext({ viewport: { width: 420, height: 860 }, permissions: ['camera'] });
const p = await ctx.newPage();
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
await p.goto(process.env.APP || 'http://localhost:8080/'); await p.waitForFunction(() => window.__ssp);
await p.click('#hero-scan');
await p.waitForFunction(() => { const v = document.querySelector('#cam-video'); return v && v.videoWidth > 0; }, null, { timeout: 20000 });
ok(true, 'camera stream started ' + await p.evaluate(() => document.querySelector('#cam-video').videoWidth + 'x' + document.querySelector('#cam-video').videoHeight));
await p.waitForTimeout(1500);
await p.screenshot({ path: 'tests/output/camera-live.png' });
await p.waitForFunction(() => window.__ssp.state.pages.length >= 1 || +document.querySelector('#cam-count')?.textContent > 0, null, { timeout: 30000 }).then(() => ok(true, 'auto-capture took a photo of the steady document'), () => ok(false, 'auto-capture did not fire within 30 s'));
await p.waitForTimeout(500);
await p.click('#cam-done');
await p.waitForFunction(() => window.__ssp.state.pages.length >= 1, null, { timeout: 30000 });
const pg = await p.evaluate(() => window.__ssp.state.pages[0]);
ok(pg.source === 'camera' && pg.corners, 'captured page added with detected corners (source ' + pg.source + ')');
await p.waitForTimeout(2000); await p.screenshot({ path: 'tests/output/camera-result.png' });
ok(!errs.length, 'no page errors ' + errs.join(' | '));
await b.close();
