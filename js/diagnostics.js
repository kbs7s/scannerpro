// Diagnostic centre: real checks of every subsystem with actionable messages.
import { h, icon, fmtBytes, libPdfjs, libPdfLib, libJSZip, libTesseract } from './util.js';
import { t } from './i18n.js';
import { APP_VERSION } from './version.js';
import { cvInit, cvInfo, cvPoolSize } from './cv-client.js';
import * as db from './database.js';
import { storageInfo, requestPersistence } from './storage.js';
import { langAvailability, OCR_LANGS } from './ocr.js';
import { bridgeStatus } from './bridge.js';
import { modal, toast } from './ui.js';
import { swMessage, swInfo } from './pwa.js';

const ok = (msg) => ({ s: 'ok', msg }); const warn = (msg) => ({ s: 'warn', msg }); const bad = (msg) => ({ s: 'bad', msg });

export const CHECKS = [
  ['online', async () => (navigator.onLine ? ok(t('diag.online')) : warn(t('diag.offline')))],
  ['secure', async () => (window.isSecureContext ? ok(location.protocol === 'https:' ? 'HTTPS' : location.hostname) : bad(t('diag.insecure')))],
  ['sw', async () => {
    if (!('serviceWorker' in navigator)) return bad(t('diag.swUnsupported'));
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return warn(t('diag.swNone'));
    if (!navigator.serviceWorker.controller) return warn(t('diag.swNotControlling'));
    const info = await swInfo();
    return ok(t('diag.swActive') + (info?.version ? ' · ' + info.version : ''));
  }],
  ['cache', async () => {
    const info = await swInfo();
    if (!info) return warn(t('diag.cacheUnknown'));
    const miss = info.missing || [];
    return miss.length ? warn(t('diag.cacheMissing', { n: miss.length }) + ': ' + miss.slice(0, 4).join(', ')) : ok(t('diag.cacheOk', { n: info.cached }));
  }],
  ['opencv', async () => { const i = cvInfo() || await cvInit(); return ok(`OpenCV ${i.version} · jscanify ${i.jscanify ? '✓' : '✗'} · ${t('diag.workers', { n: cvPoolSize() })}`); }],
  ['pdfjs', async () => { const l = await libPdfjs(); return ok('PDF.js ' + (l.version || '')); }],
  ['pdflib', async () => { await libPdfLib(); return ok('pdf-lib 1.17.1'); }],
  ['jszip', async () => { const z = await libJSZip(); return ok('JSZip ' + (z.version || '')); }],
  ['ocrEngine', async () => { await libTesseract(); return ok(t('diag.ocrScript')); }],
  ...OCR_LANGS.map((l) => ['model_' + l.code, async () => { const a = await langAvailability(); return a[l.code] ? ok(t('diag.modelOk')) : (l.code === 'fra' ? warn(t('diag.modelMissing')) : bad(t('diag.modelMissing'))); }]),
  ['idb', async () => ((await db.selfTest()) ? ok(t('diag.idbOk')) : bad(t('diag.idbFail')))],
  ['quota', async () => {
    const s = await storageInfo();
    if (s.usage == null) return warn(t('diag.quotaUnknown'));
    const free = s.quota - s.usage;
    const txt = `${fmtBytes(s.usage)} / ${fmtBytes(s.quota)}`;
    return free < 200 * 1024 * 1024 ? warn(txt + ' — ' + t('diag.quotaLow')) : ok(txt);
  }],
  ['persist', async () => { const s = await storageInfo(); return s.persisted ? ok(t('diag.persisted')) : warn(t('diag.notPersisted')); }],
  ['cameraPerm', async () => {
    try { const p = await navigator.permissions.query({ name: 'camera' }); return p.state === 'granted' ? ok(t('perm.granted')) : p.state === 'denied' ? bad(t('perm.denied')) : warn(t('perm.prompt')); }
    catch (_) { return warn(t('diag.permUnknown')); }
  }],
  ['camera', async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return bad(t('cam.err.unsupported'));
    const n = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length;
    return n ? ok(t('diag.cameras', { n })) : warn(t('diag.noCamera'));
  }],
  ['bridge', async () => { const s = await bridgeStatus(); return s.ok ? ok(t('bridge.online') + (s.naps2?.found ? ' · NAPS2' : '')) : warn(t('bridge.offline') + ' — ' + t('diag.bridgeOptional')); }],
  ['features', async () => {
    const f = { WebAssembly: typeof WebAssembly === 'object', Workers: typeof Worker !== 'undefined', OffscreenCanvas: typeof OffscreenCanvas !== 'undefined', WebShare: !!navigator.canShare, ImageCapture: 'ImageCapture' in window, FileSystemAccess: 'showSaveFilePicker' in window };
    const missing = Object.entries(f).filter(([, v]) => !v).map(([k]) => k);
    const essential = !f.WebAssembly || !f.Workers;
    const txt = Object.entries(f).map(([k, v]) => `${k} ${v ? '✓' : '✗'}`).join(' · ');
    return essential ? bad(txt) : missing.length ? warn(txt) : ok(txt);
  }],
];

export async function runChecks(onItem) {
  const out = {};
  for (const [id, fn] of CHECKS) {
    let r;
    try { r = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(t('diag.timeout'))), 20000))]); }
    catch (e) { r = bad(e.message || String(e)); }
    out[id] = r; onItem && onItem(id, r);
  }
  return out;
}

export function debugInfo(results = {}) {
  return JSON.stringify({ app: APP_VERSION, ua: navigator.userAgent, lang: navigator.language, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory, screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, standalone: matchMedia('(display-mode: standalone)').matches, online: navigator.onLine, checks: results }, null, 2);
}

export function openDiagnostics() {
  return modal({
    title: t('diag.title'), big: true,
    build(body, foot, close) {
      const list = h('ul', { class: 'diag-list' });
      const rows = {};
      for (const [id] of CHECKS) {
        const st = h('span', { class: 'st' }, '…'); const txt = h('small', {}, t('diag.running'));
        rows[id] = { st, txt };
        list.append(h('li', {}, st, h('div', {}, h('strong', {}, t('diag.c.' + (id.startsWith('model_') ? 'model' : id), { lang: t('lang.' + id.slice(6)) })), txt), h('span')));
      }
      body.append(h('div', { class: 'kv' }, h('dt', {}, t('diag.version')), h('dd', {}, APP_VERSION), h('dt', {}, t('diag.ua')), h('dd', {}, navigator.userAgent)), list);
      let results = {};
      const run = async () => {
        for (const r of Object.values(rows)) { r.st.className = 'st'; r.st.textContent = '…'; r.txt.textContent = t('diag.running'); }
        results = await runChecks((id, r) => { rows[id].st.className = 'st ' + r.s; rows[id].st.textContent = r.s === 'ok' ? '✓' : r.s === 'warn' ? '!' : '✗'; rows[id].txt.textContent = r.msg; });
      };
      foot.append(
        h('button', { type: 'button', class: 'btn', onclick: async () => { const r = await swMessage({ type: 'cache-all' }, 600000); toast(r && r.ok ? t('diag.cachedAll', { n: r.cached }) : t('diag.cacheFailed') + (r?.error ? ': ' + r.error : ''), r && r.ok ? 'ok' : 'bad'); run(); } }, icon('download'), t('diag.cacheAll')),
        h('button', { type: 'button', class: 'btn', onclick: async () => { const p = await requestPersistence(); toast(p ? t('diag.persisted') : t('diag.persistDenied'), p ? 'ok' : 'warn'); run(); } }, icon('shield-check'), t('diag.requestPersist')),
        h('button', { type: 'button', class: 'btn', onclick: async () => { try { await navigator.clipboard.writeText(debugInfo(results)); toast(t('act.copied'), 'ok'); } catch (_) { toast(t('act.copyFailed'), 'warn'); } } }, icon('copy'), t('diag.copyDebug')),
        h('button', { type: 'button', class: 'btn primary', onclick: run }, icon('refresh-cw'), t('diag.rerun')));
      run();
    },
  });
}
