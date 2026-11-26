// Loads the app shell and reports console errors / page errors.
import { chromium } from 'playwright';
const url = process.argv[2] || 'http://localhost:8080/';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()); });
p.on('pageerror', (e) => errs.push('pageerror: ' + e.message + '\n' + e.stack));
await p.goto(url); await p.waitForTimeout(4000);
console.log('title', await p.title(), 'hook', await p.evaluate(() => !!window.__ssp));
await p.screenshot({ path: 'tests/output/app-desktop.png' });
console.log(errs.join('\n') || 'no errors');
await b.close();
