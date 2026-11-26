// Physical scanner support through a separately installed local bridge (bridge/scanner-bridge.js),
// which drives NAPS2 (USB/WIA/TWAIN/SANE/ICA) or eSCL/AirScan network scanners.
// A web page cannot talk to WIA/TWAIN devices directly; nothing here is simulated.
import { h, icon, base64ToBlob } from './util.js';
import { t } from './i18n.js';
import { settings } from './settings.js';
import { modal, toast, errorToast } from './ui.js';
import { openPdf, renderPdfPage } from './pdf-manager.js';
import { imageSize } from './image-io.js';

async function call(path, { method = 'GET', body, timeout = 6000 } = {}) {
  const base = (settings.bridgeUrl || 'http://127.0.0.1:7800').replace(/\/$/, '');
  const ac = new AbortController(); const tm = timeout ? setTimeout(() => ac.abort(), timeout) : null;
  try {
    const r = await fetch(base + path, { method, body: body ? JSON.stringify(body) : undefined, headers: body ? { 'Content-Type': 'application/json' } : {}, signal: ac.signal, mode: 'cors', cache: 'no-store' });
    if (!r.ok) {
      let msg = r.status + ' ' + r.statusText;
      try { const j = await r.json(); if (j.error) msg = j.error; } catch (_) { /* */ }
      throw new Error(msg);
    }
    return r;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(t('bridge.timeout'));
    if (e instanceof TypeError) throw new Error(t('bridge.unreachable'));
    throw e;
  } finally { if (tm) clearTimeout(tm); }
}

export async function bridgeStatus() {
  try { return { ok: true, ...(await (await call('/api/status', { timeout: 3000 })).json()) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

async function listScanners() { return (await (await call('/api/scanners', { timeout: 60000 })).json()).scanners || []; }

/** Performs a scan. Returns page items ready for addPages. */
export async function scanWithBridge(opts, onStatus) {
  onStatus && onStatus(t('bridge.scanning'));
  const r = await call('/api/scan', { method: 'POST', body: opts, timeout: 15 * 60 * 1000 });
  const type = r.headers.get('Content-Type') || '';
  const items = [];
  if (type.includes('application/pdf')) {
    const pdf = await openPdf(new Uint8Array(await r.arrayBuffer()));
    for (let i = 1; i <= pdf.numPages; i++) {
      onStatus && onStatus(t('batch.page', { i, n: pdf.numPages }));
      const pg = await renderPdfPage(pdf, i, opts.dpi || 300);
      items.push({ ...pg, dpi: opts.dpi, source: 'scanner' });
    }
    pdf.destroy();
  } else {
    const j = await r.json();
    for (const p of j.pages || []) {
      const blob = base64ToBlob(p.data, p.mime || 'image/jpeg');
      const sz = await imageSize(blob);
      items.push({ blob, width: sz.width, height: sz.height, dpi: opts.dpi, source: 'scanner' });
    }
  }
  if (!items.length) throw new Error(t('bridge.noPages'));
  return items;
}

/** Scanner connection panel. onPages(items) is called with scanned pages. */
export function openScannerPanel(onPages) {
  return modal({
    title: t('scanner.title'),
    build(body, foot, close) {
      const url = h('input', { type: 'url', value: settings.bridgeUrl, style: { flex: 1 } });
      const stBridge = h('span', { class: 'badge' }, '…');
      const stDetail = h('div', { class: 'hint' });
      const scanners = h('select', { disabled: true }, h('option', {}, t('bridge.noScanners')));
      const source = h('select', {}, ['flatbed', 'feeder', 'duplex'].map((s) => h('option', { value: s }, t('bridge.src.' + s))));
      const color = h('select', {}, ['color', 'gray', 'bw'].map((s) => h('option', { value: s }, t('p.mode.' + s))));
      const dpi = h('select', {}, [100, 150, 200, 300, 400, 600].map((d) => h('option', { value: d, selected: d === 300 }, d + ' DPI')));
      const paper = h('select', {}, ['a4', 'letter', 'legal', 'a5', 'a3'].map((s) => h('option', { value: s }, s.toUpperCase())));
      const msg = h('p', { class: 'hint' });
      const pv = h('div', { style: { display: 'none', textAlign: 'center' } });
      const fld = (l, el) => h('label', { class: 'field' }, h('span', {}, l), el);
      body.append(
        h('p', { class: 'hint' }, t('bridge.intro')),
        h('div', { class: 'row-btns' }, url, h('button', { type: 'button', class: 'btn', onclick: check }, icon('refresh-cw'), t('bridge.connect'))),
        h('div', { class: 'info-card' }, h('div', { class: 'row' }, h('span', {}, t('bridge.status')), stBridge), stDetail),
        fld(t('bridge.scanner'), scanners),
        h('div', { class: 'grid2' }, fld(t('bridge.source'), source), fld(t('bridge.color'), color), fld(t('bridge.dpi'), dpi), fld(t('bridge.paper'), paper)),
        msg, pv,
        h('details', { class: 'group' }, h('summary', {}, t('bridge.howto')), h('div', { class: 'hint', html: t('bridge.howtoHtml') })));
      const scanBtn = h('button', { type: 'button', class: 'btn primary', disabled: true, onclick: () => doScan(false) }, icon('scan'), t('bridge.scan'));
      const pvBtn = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => doScan(true) }, icon('image-plus'), t('bridge.preview'));
      foot.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, t('act.close')), pvBtn, scanBtn);

      async function check() {
        settings.bridgeUrl = url.value.trim();
        stBridge.className = 'badge'; stBridge.textContent = t('bridge.checking'); stDetail.textContent = '';
        scanBtn.disabled = pvBtn.disabled = true;
        const s = await bridgeStatus();
        if (!s.ok) {
          stBridge.className = 'badge bad'; stBridge.textContent = t('bridge.offline');
          stDetail.textContent = s.error + ' — ' + t('bridge.offlineHint');
          scanners.innerHTML = ''; scanners.append(h('option', {}, t('bridge.noScanners'))); scanners.disabled = true;
          return;
        }
        stBridge.className = 'badge ok'; stBridge.textContent = t('bridge.online') + (s.version ? ' v' + s.version : '');
        stDetail.textContent = [s.naps2?.found ? 'NAPS2: ' + (s.naps2.path || '✓') : 'NAPS2: ' + t('bridge.notFound'), (s.escl || []).length ? 'eSCL: ' + s.escl.length : ''].filter(Boolean).join(' · ');
        msg.textContent = t('bridge.listing');
        try {
          const list = await listScanners();
          scanners.innerHTML = '';
          for (const sc of list) scanners.append(h('option', { value: sc.id }, `${sc.name} (${sc.backend}${sc.driver ? '/' + sc.driver : ''})`));
          scanners.disabled = !list.length;
          if (!list.length) scanners.append(h('option', {}, t('bridge.noScanners')));
          scanBtn.disabled = pvBtn.disabled = !list.length;
          msg.textContent = list.length ? t('bridge.found', { n: list.length }) : t('bridge.noScannersHint');
        } catch (e) { msg.textContent = '⚠ ' + e.message; }
      }
      async function doScan(preview) {
        scanBtn.disabled = pvBtn.disabled = true;
        const opts = { scannerId: scanners.value, source: preview ? 'flatbed' : source.value, color: color.value, dpi: preview ? 75 : +dpi.value, paperSize: paper.value, preview };
        try {
          const items = await scanWithBridge(opts, (s) => { msg.textContent = s; });
          if (preview) {
            pv.innerHTML = ''; pv.style.display = 'block';
            const img = h('img', { src: URL.createObjectURL(items[0].blob), style: { maxWidth: '100%', maxHeight: '320px', background: '#fff' } });
            pv.append(img); msg.textContent = t('bridge.previewDone');
          } else {
            await onPages(items);
            msg.textContent = t('bridge.scanned', { n: items.length });
            toast(t('bridge.scanned', { n: items.length }), 'ok');
          }
        } catch (e) { msg.textContent = '⚠ ' + e.message; errorToast(e, t('bridge.scanFailed')); }
        finally { scanBtn.disabled = pvBtn.disabled = false; }
      }
      check();
    },
  });
}
