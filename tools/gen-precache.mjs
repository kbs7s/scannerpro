// Generates the precache lists and build hash inside service-worker.js.
// Usage: node tools/gen-precache.mjs
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = (d) => fs.readdirSync(path.join(root, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const rel = (p) => p.split(path.sep).join('/');
const skip = (p) => /(^|\/)(LICENSE|README)|\.map$|\.md$|\.txt$/i.test(p);
const heavyRe = /^(libs\/tesseract\/core\/|models\/)/;
const files = ['index.html', 'manifest.json', ...['css', 'js', 'libs', 'assets', 'models'].flatMap(walk)].map(rel).filter((p) => !skip(p));
const CORE = ['./', ...files.filter((f) => !heavyRe.test(f))];
const HEAVY = files.filter((f) => heavyRe.test(f));
const hash = crypto.createHash('sha256');
for (const f of files.sort()) hash.update(f).update(fs.readFileSync(path.join(root, f)));
const build = hash.digest('hex').slice(0, 10);
const version = (fs.readFileSync(path.join(root, 'js/version.js'), 'utf8').match(/APP_VERSION = '([^']+)'/) || [])[1] || '1.0.0';
let sw = fs.readFileSync(path.join(root, 'service-worker.js'), 'utf8');
sw = sw.replace(/\/\/ GENERATED-LISTS-START[\s\S]*?\/\/ GENERATED-LISTS-END/, `// GENERATED-LISTS-START\nconst CORE = ${JSON.stringify(CORE, null, 0)};\nconst HEAVY = ${JSON.stringify(HEAVY, null, 0)};\n// GENERATED-LISTS-END`);
sw = sw.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`).replace(/const BUILD = '[^']*';/, `const BUILD = '${build}';`);
fs.writeFileSync(path.join(root, 'service-worker.js'), sw);
console.log(`service-worker.js: ${CORE.length} core + ${HEAVY.length} heavy assets, build ${build}`);
