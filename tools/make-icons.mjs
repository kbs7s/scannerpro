// Renders PNG app icons from assets/icons/logo.svg (dev-time helper, needs Playwright)
import { chromium } from 'playwright';
import fs from 'node:fs';
const svg = fs.readFileSync('assets/icons/logo.svg', 'utf8');
const b = await chromium.launch(); const p = await b.newPage();
async function render(size, file, { maskable = false } = {}) {
  await p.setViewportSize({ width: size, height: size });
  const inner = maskable ? `<div style="width:${size}px;height:${size}px;background:#2f6fd6;display:grid;place-items:center"><div style="width:${size * 0.8}px;height:${size * 0.8}px">${svg.replace('<rect width="512" height="512" rx="112"', '<rect width="512" height="512" rx="0"')}</div></div>` : svg;
  await p.setContent(`<html><body style="margin:0;background:transparent">${inner}</body><style>svg{width:100%;height:100%;display:block}</style></html>`);
  await p.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}
await render(192, 'assets/icons/icon-192.png');
await render(512, 'assets/icons/icon-512.png');
await render(512, 'assets/icons/icon-maskable-512.png', { maskable: true });
await render(180, 'assets/icons/apple-touch-icon.png', { maskable: true });
await render(32, 'assets/icons/favicon-32.png');
await b.close(); console.log('icons done');
