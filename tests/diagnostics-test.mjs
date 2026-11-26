// Runs the in-app diagnostic checks in headless Chromium and prints each result; also toggles English UI.
import { chromium } from 'playwright';
const b = await chromium.launch(); const p = await (await b.newContext()).newPage();
await p.goto(process.env.APP || 'http://localhost:8080/'); await p.waitForFunction(() => window.__ssp);
await p.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 30000 }).catch(() => {});
const r = await p.evaluate(async () => (await import('./js/diagnostics.js')).runChecks());
for (const [k, v] of Object.entries(r)) console.log(v.s.padEnd(4), k.padEnd(12), v.msg);
await p.click('#btn-lang'); await p.waitForTimeout(300);
console.log('lang after toggle:', await p.evaluate(() => document.documentElement.lang + ' ' + document.dir + ' | ' + document.querySelector('#hero-scan').textContent.trim()));
await b.close();
