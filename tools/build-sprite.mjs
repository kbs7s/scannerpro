// Dev-time helper: builds assets/icons/sprite.svg from lucide-static (ISC).
// Usage: node tools/build-sprite.mjs <path-to-lucide-static/icons>
import fs from 'node:fs'; import path from 'node:path';
const src = process.argv[2];
const names = fs.readFileSync(new URL('./icons.txt', import.meta.url), 'utf8').split(/\s+/).filter(Boolean);
let out = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n<!-- Icons from Lucide (ISC License) https://lucide.dev -->\n';
for (const n of names) {
  const svg = fs.readFileSync(path.join(src, n + '.svg'), 'utf8');
  const inner = svg.replace(/<!--.*?-->/s, '').replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
  out += `<symbol id="i-${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</symbol>\n`;
}
out += '</svg>\n';
fs.writeFileSync(new URL('../assets/icons/sprite.svg', import.meta.url), out);
const idx = new URL('../index.html', import.meta.url);
const html = fs.readFileSync(idx, 'utf8').replace(/<!--SPRITE-START-->[\s\S]*?<!--SPRITE-END-->/, '<!--SPRITE-START-->' + out.replace('style="display:none"', 'style="display:none" aria-hidden="true"').trim() + '<!--SPRITE-END-->');
fs.writeFileSync(idx, html);
console.log('icons:', names.length);
