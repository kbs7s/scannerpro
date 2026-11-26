// PDF / image export with pdf-lib: page sizes, orientation, DPI, quality, colour mode, metadata,
// page numbers, header/footer, watermark and an invisible OCR text layer for searchable PDFs.
import { h, icon, libPdfLib, libJSZip, downloadBlob, safeName, debounce, PAGE_SIZES, mmToPt } from './util.js';
import { t } from './i18n.js';
import * as db from './database.js';
import { state, scopePages } from './project.js';
import { ensureProcessed } from './render.js';
import { decode, makeCanvas, canvasToBlob, isBinary } from './image-io.js';
import { settings } from './settings.js';
import { modal, toast, Progress, errorToast } from './ui.js';
import { openPdf } from './pdf-manager.js';
import { printBlobPdf } from './print.js';

const QUALITY = { low: 0.5, medium: 0.7, high: 0.85, max: 0.95 };

export function defaultExportOptions() {
  const d = state.doc || {};
  return {
    scope: 'all', pageSize: settings.pageSize || 'A4', customW: 210, customH: 297, orientation: settings.orientation || 'auto',
    margin: settings.margin || 0, fit: 'fit', quality: settings.quality || 'high', dpi: settings.dpi || 200, color: 'auto',
    searchable: settings.searchablePdf !== false, title: d.title || '', author: '', subject: d.category ? t('cat.' + d.category) : '', keywords: (d.tags || []).join(', '),
    numbering: false, numberPos: 'bottom-center', numberFormat: '{n} / {total}', header: '', footer: '',
    watermark: '', wmOpacity: 0.15, wmSize: 60, single: false,
  };
}

/* ---------- text-as-image (correct Arabic shaping via the browser's text engine) ---------- */
async function textImage(text, sizePt, color = '#000000', weight = 600) {
  try { await document.fonts.load(`${weight} 20px Cairo`, text); } catch (_) { /* */ }
  const scale = 4; const px = sizePt * scale;
  const probe = makeCanvas(10, 10).getContext('2d');
  probe.font = `${weight} ${px}px Cairo, sans-serif`;
  const w = Math.ceil(probe.measureText(text).width) + 8;
  const hh = Math.ceil(px * 1.45);
  const c = makeCanvas(w, hh); const x = c.getContext('2d');
  x.font = probe.font; x.fillStyle = color; x.textBaseline = 'middle';
  x.direction = /[؀-ۿ]/.test(text) ? 'rtl' : 'ltr';
  x.textAlign = x.direction === 'rtl' ? 'right' : 'left';
  x.fillText(text, x.direction === 'rtl' ? w - 4 : 4, hh / 2);
  const blob = await canvasToBlob(c, 'image/png');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: w / scale, h: hh / scale };
}

function pageBox(page, imgW, imgH, o) {
  let wPt, hPt;
  if (o.pageSize === 'original') {
    if (page.pdfSize && !page.corners) {
      wPt = page.pdfSize.w; hPt = page.pdfSize.h;
      if (page.rotation === 90 || page.rotation === 270) [wPt, hPt] = [hPt, wPt];
      if (Math.abs(wPt / hPt - imgW / imgH) > 0.05) { wPt = imgW * 72 / (page.dpi || o.dpi); hPt = imgH * 72 / (page.dpi || o.dpi); }
    } else { const d = page.dpi || 300; wPt = imgW * 72 / d; hPt = imgH * 72 / d; }
    return { wPt, hPt };
  }
  const mm = o.pageSize === 'custom' ? [+o.customW || 210, +o.customH || 297] : PAGE_SIZES[o.pageSize] || PAGE_SIZES.A4;
  wPt = mmToPt(mm[0]); hPt = mmToPt(mm[1]);
  const landscape = o.orientation === 'landscape' || (o.orientation === 'auto' && imgW > imgH);
  if (landscape !== (wPt > hPt)) [wPt, hPt] = [hPt, wPt];
  return { wPt, hPt };
}

/** Prepares page pixels for embedding: resample to target DPI, apply colour mode, encode. */
async function preparePageImage(blob, placedWpt, placedHpt, o, preview) {
  const bmp = await decode(blob);
  const dpi = preview ? Math.min(o.dpi, 72) : o.dpi;
  const tw = Math.max(1, Math.round(placedWpt / 72 * dpi)), th = Math.max(1, Math.round(placedHpt / 72 * dpi));
  const k = Math.min(1, tw / bmp.width, th / bmp.height);
  const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const c = makeCanvas(w, hh); const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high'; x.drawImage(bmp, 0, 0, w, hh); bmp.close && bmp.close();
  let img = x.getImageData(0, 0, w, hh);
  if (o.color === 'gray' || o.color === 'bw') {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      let v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (o.color === 'bw') v = v > 160 ? 255 : 0;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    x.putImageData(img, 0, 0);
  }
  const binary = o.color === 'bw' || isBinary(img);
  img = null;
  const usePng = binary && !preview;
  const out = await canvasToBlob(c, usePng ? 'image/png' : 'image/jpeg', preview ? 0.6 : QUALITY[o.quality] || 0.85);
  return { bytes: new Uint8Array(await out.arrayBuffer()), png: usePng, w, h: hh };
}

/** Build the PDF. Returns Uint8Array. */
export async function buildPdf(pages, o, { onProgress, preview = false, cancelled = () => false } = {}) {
  const { PDFDocument, degrees } = await libPdfLib();
  const doc = await PDFDocument.create();
  const now = new Date();
  doc.setTitle(o.title || 'Document', { showInWindowTitleBar: true });
  if (o.author) doc.setAuthor(o.author);
  if (o.subject) doc.setSubject(o.subject);
  if (o.keywords) doc.setKeywords(o.keywords.split(',').map((s) => s.trim()).filter(Boolean));
  doc.setCreator('Ultimate Smart Scanner Pro'); doc.setProducer('Ultimate Smart Scanner Pro (pdf-lib)');
  doc.setCreationDate(state.doc?.scanDate ? new Date(state.doc.scanDate) : now); doc.setModificationDate(now);
  doc.setLanguage(document.documentElement.lang === 'ar' ? 'ar' : 'en');
  const headerImg = o.header ? await doc.embedPng((await textImage(o.header, 10, '#333333')).bytes) : null;
  const footerImg = o.footer ? await doc.embedPng((await textImage(o.footer, 10, '#333333')).bytes) : null;
  let wm = null;
  if (o.watermark) { const ti = await textImage(o.watermark, +o.wmSize || 60, '#888888', 700); wm = { img: await doc.embedPng(ti.bytes), w: ti.w, h: ti.h }; }
  const list = preview ? pages.slice(0, 4) : pages;
  for (let i = 0; i < list.length; i++) {
    if (cancelled()) throw new Error(t('batch.cancelled'));
    const page = list[i];
    onProgress && onProgress(i / list.length, i + 1, list.length);
    const blob = await ensureProcessed(page);
    const ow = page.procW || 1, oh = page.procH || 1;
    const { wPt, hPt } = pageBox(page, ow, oh, o);
    const m = mmToPt(+o.margin || 0);
    const boxW = Math.max(10, wPt - 2 * m), boxH = Math.max(10, hPt - 2 * m);
    let dw, dh;
    if (o.fit === 'fill') { const k = Math.max(boxW / ow, boxH / oh); dw = ow * k; dh = oh * k; }
    else if (o.fit === 'actual') { const d = page.dpi || 300; dw = ow * 72 / d; dh = oh * 72 / d; }
    else { const k = Math.min(boxW / ow, boxH / oh); dw = ow * k; dh = oh * k; }
    const x = (wPt - dw) / 2, y = (hPt - dh) / 2;
    const pg = doc.addPage([wPt, hPt]);
    const im = await preparePageImage(blob, Math.min(dw, boxW * 2), Math.min(dh, boxH * 2), o, preview);
    const emb = im.png ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    pg.drawImage(emb, { x, y, width: dw, height: dh });
    // invisible OCR text layer (Tesseract text-only PDF, word positions preserved), scaled onto the image rect
    if (o.searchable && !preview && page.ocr && page.ocr.pdfId && page.ocr.rev === page.rev) {
      try {
        const bytes = new Uint8Array(await (await db.getBlob(page.ocr.pdfId)).arrayBuffer());
        const [layer] = await doc.embedPdf(bytes);
        pg.drawPage(layer, { x, y, width: dw, height: dh });
      } catch (e) { console.warn('text layer failed', e); }
    }
    if (wm) {
      const a = Math.atan2(hPt, wPt); const s = Math.min(1, (Math.hypot(wPt, hPt) * 0.8) / wm.w);
      const ww = wm.w * s, wh = wm.h * s;
      const cx = wPt / 2 - (ww / 2 * Math.cos(a) - wh / 2 * Math.sin(a)), cy = hPt / 2 - (ww / 2 * Math.sin(a) + wh / 2 * Math.cos(a));
      pg.drawImage(wm.img, { x: cx, y: cy, width: ww, height: wh, rotate: degrees(a * 180 / Math.PI), opacity: +o.wmOpacity || 0.15 });
    }
    const edge = Math.max(14, m * 0.5);
    if (headerImg) { const s = headerImg.scale(1); pg.drawImage(headerImg, { x: (wPt - s.width) / 2, y: hPt - edge - s.height + 4, width: s.width, height: s.height }); }
    if (footerImg) { const s = footerImg.scale(1); pg.drawImage(footerImg, { x: (wPt - s.width) / 2, y: edge - 4, width: s.width, height: s.height }); }
    if (o.numbering) {
      const txt = (o.numberFormat || '{n} / {total}').replace('{n}', String(i + 1)).replace('{total}', String(pages.length));
      const ti = await textImage(txt, 9, '#444444');
      const ni = await doc.embedPng(ti.bytes);
      const [v, hz] = (o.numberPos || 'bottom-center').split('-');
      const nx = hz === 'left' ? 24 : hz === 'right' ? wPt - ti.w - 24 : (wPt - ti.w) / 2;
      const ny = v === 'top' ? hPt - 20 - ti.h : 14 + (footerImg && hz === 'center' ? 14 : 0);
      pg.drawImage(ni, { x: nx, y: ny, width: ti.w, height: ti.h });
    }
  }
  onProgress && onProgress(1, list.length, list.length);
  return doc.save({ useObjectStreams: true });
}

/* ---------- dialogs ---------- */
export async function openExportDialog(preset = {}) {
  if (!state.pages.length) { toast(t('ws.noPages'), 'warn'); return; }
  const o = { ...defaultExportOptions(), ...preset };
  let lastBytes = null;
  await modal({
    title: t('exp.title'), big: true,
    build(body, foot, close) {
      const f = (k, el) => { el.dataset.k = k; return el; };
      const sel = (k, opts) => f(k, h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: String(o[k]) === String(v) }, l))));
      const inp = (k, type = 'text', extra = {}) => f(k, h('input', { type, value: o[k], ...extra }));
      const chk = (k) => f(k, h('input', { type: 'checkbox', checked: !!o[k] }));
      const fld = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);
      const sw = (label, el) => h('label', { class: 'switch' }, el, h('span', {}, label));
      const form = h('div', {},
        h('fieldset', {}, h('legend', {}, t('exp.pages')),
          fld(t('exp.scope'), sel('scope', [['all', t('scope.all')], ['selected', t('scope.selected')], ['current', t('scope.current')]])),
          sw(t('exp.single'), chk('single'))),
        h('fieldset', {}, h('legend', {}, t('exp.layout')), h('div', { class: 'grid2' },
          fld(t('exp.pageSize'), sel('pageSize', [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['original', t('exp.original')], ['custom', t('exp.custom')]])),
          fld(t('exp.orientation'), sel('orientation', [['auto', t('orient.auto')], ['portrait', t('orient.portrait')], ['landscape', t('orient.landscape')]])),
          fld(t('exp.customW'), inp('customW', 'number', { min: 20, max: 2000 })), fld(t('exp.customH'), inp('customH', 'number', { min: 20, max: 2000 })),
          fld(t('exp.margin'), inp('margin', 'number', { min: 0, max: 50 })),
          fld(t('exp.fit'), sel('fit', [['fit', t('exp.fitFit')], ['fill', t('exp.fitFill')], ['actual', t('exp.fitActual')]])))),
        h('fieldset', {}, h('legend', {}, t('exp.quality')), h('div', { class: 'grid2' },
          fld(t('exp.quality'), sel('quality', [['low', t('q.low')], ['medium', t('q.medium')], ['high', t('q.high')], ['max', t('q.max')]])),
          fld(t('exp.dpi'), sel('dpi', [150, 200, 300, 400, 600].map((d) => [d, d + ' DPI']))),
          fld(t('exp.color'), sel('color', [['auto', t('exp.colorAuto')], ['gray', t('p.mode.gray')], ['bw', t('p.mode.bw')]])))),
        h('fieldset', {}, h('legend', {}, t('exp.ocr')), sw(t('exp.searchable'), chk('searchable')), h('p', { class: 'hint', id: 'exp-ocr-note' })),
        h('fieldset', {}, h('legend', {}, t('exp.meta')),
          fld(t('exp.docTitle'), inp('title')), fld(t('exp.author'), inp('author')), fld(t('exp.subject'), inp('subject')), fld(t('exp.keywords'), inp('keywords'))),
        h('fieldset', {}, h('legend', {}, t('exp.extras')),
          sw(t('exp.numbering'), chk('numbering')),
          h('div', { class: 'grid2' }, fld(t('exp.numberPos'), sel('numberPos', [['bottom-center', t('pos.bc')], ['bottom-right', t('pos.br')], ['bottom-left', t('pos.bl')], ['top-center', t('pos.tc')], ['top-right', t('pos.tr')], ['top-left', t('pos.tl')]])),
            fld(t('exp.numberFormat'), inp('numberFormat'))),
          fld(t('exp.header'), inp('header')), fld(t('exp.footer'), inp('footer')),
          fld(t('exp.watermark'), inp('watermark')),
          h('div', { class: 'grid2' }, fld(t('exp.wmOpacity'), inp('wmOpacity', 'number', { min: 0.02, max: 1, step: 0.01 })), fld(t('exp.wmSize'), inp('wmSize', 'number', { min: 10, max: 200 })))));
      const pv = h('div', { class: 'preview-pane' });
      const status = h('p', { class: 'hint' });
      body.append(h('div', { class: 'split-2' }, form, h('div', {}, h('strong', {}, t('exp.preview')), status, pv)));
      const read = () => {
        form.querySelectorAll('[data-k]').forEach((el) => { o[el.dataset.k] = el.type === 'checkbox' ? el.checked : (el.type === 'number' ? +el.value : el.value); });
        o.dpi = +o.dpi;
      };
      const targets = () => (o.scope === 'current' ? [state.pages[state.cur]] : scopePages(o.scope)).filter(Boolean);
      const updOcrNote = () => {
        const tg = targets(); const withOcr = tg.filter((p) => p.ocr && p.ocr.pdfId && p.ocr.rev === p.rev).length;
        form.querySelector('#exp-ocr-note').textContent = t('exp.ocrNote', { n: withOcr, total: tg.length });
      };
      let pgen = 0;
      const renderPreview = debounce(async () => {
        read(); updOcrNote();
        const g = ++pgen; status.textContent = t('exp.previewing');
        try {
          const bytes = await buildPdf(targets(), o, { preview: true });
          if (g !== pgen) return;
          const pdf = await openPdf(bytes);
          pv.innerHTML = '';
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i); const vp1 = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: 220 / Math.max(vp1.width, vp1.height) });
            const c = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
            await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            pv.append(h('figure', {}, c, h('figcaption', {}, `${i} · ${Math.round(vp1.width / 72 * 25.4)}×${Math.round(vp1.height / 72 * 25.4)} mm`)));
          }
          pdf.destroy();
          const n = targets().length;
          status.textContent = t('exp.previewNote', { shown: Math.min(4, n), total: n });
        } catch (e) { status.textContent = '⚠ ' + e.message; }
      }, 450);
      form.addEventListener('input', renderPreview); form.addEventListener('change', renderPreview);
      renderPreview();

      const result = h('span', { class: 'muted' });
      const create = async () => {
        read();
        const tg = targets(); if (!tg.length) { toast(t('scope.nothing'), 'warn'); return; }
        settings.pageSize = o.pageSize; settings.orientation = o.orientation; settings.quality = o.quality; settings.dpi = o.dpi; settings.margin = o.margin; settings.searchablePdf = o.searchable;
        const prog = new Progress(t('exp.creating'));
        try {
          const base = safeName(o.title || state.doc?.title);
          if (o.single) {
            const JSZip = await libJSZip(); const zip = new JSZip();
            for (let i = 0; i < tg.length; i++) {
              if (prog.cancelled) throw new Error(t('batch.cancelled'));
              prog.set(i / tg.length, t('batch.page', { i: i + 1, n: tg.length }));
              zip.file(`${base}-${String(i + 1).padStart(3, '0')}.pdf`, await buildPdf([tg[i]], { ...o, numbering: false }));
            }
            const zb = await zip.generateAsync({ type: 'blob' });
            downloadBlob(zb, base + '-pages.zip'); result.textContent = t('exp.done', { size: fmt(zb.size) });
          } else {
            const bytes = await buildPdf(tg, o, { onProgress: (f, i, n) => prog.set(f, t('batch.page', { i, n })), cancelled: () => prog.cancelled });
            lastBytes = bytes;
            const blob = new Blob([bytes], { type: 'application/pdf' });
            downloadBlob(blob, base + '.pdf');
            result.textContent = t('exp.done', { size: fmt(blob.size) });
            shareBtn.disabled = false; printBtn.disabled = false;
          }
          toast(t('exp.saved'), 'ok');
        } catch (e) { errorToast(e, t('exp.failed')); } finally { prog.finish(); }
      };
      const shareBtn = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => lastBytes && shareFiles([new File([lastBytes], safeName(o.title || state.doc?.title) + '.pdf', { type: 'application/pdf' })]) }, icon('share-2'), t('act.share'));
      const printBtn = h('button', { type: 'button', class: 'btn', disabled: true, onclick: () => lastBytes && printBlobPdf(new Blob([lastBytes], { type: 'application/pdf' })) }, icon('printer'), t('act.print'));
      foot.append(result, h('span', { class: 'flex' }), shareBtn, printBtn,
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, t('act.close')),
        h('button', { type: 'button', class: 'btn primary', onclick: create }, icon('download'), t('exp.create')));
    },
  });
}
const fmt = (n) => (n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB');

export async function shareFiles(files, title = '') {
  try {
    if (navigator.canShare && navigator.canShare({ files })) { await navigator.share({ files, title }); return true; }
  } catch (e) { if (e.name === 'AbortError') return false; }
  toast(t('exp.shareUnsupported'), 'warn');
  for (const f of files) downloadBlob(f, f.name);
  return false;
}

export async function exportImages({ scope = 'all', format = 'image/jpeg', quality = 0.9, scale = 1 } = {}) {
  const tg = scope === 'current' ? [state.pages[state.cur]].filter(Boolean) : scopePages(scope);
  if (!tg.length) { toast(t('ws.noPages'), 'warn'); return; }
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[format];
  const base = safeName(state.doc?.title);
  const prog = new Progress(t('exp.creating'));
  try {
    const files = [];
    for (let i = 0; i < tg.length; i++) {
      if (prog.cancelled) throw new Error(t('batch.cancelled'));
      prog.set(i / tg.length, t('batch.page', { i: i + 1, n: tg.length }));
      const blob = await ensureProcessed(tg[i]);
      const bmp = await decode(blob);
      const c = makeCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale));
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(bmp, 0, 0, c.width, c.height); bmp.close && bmp.close();
      const out = await canvasToBlob(c, format, quality);
      files.push(new File([out], `${base}-${String(i + 1).padStart(3, '0')}.${ext}`, { type: format }));
    }
    if (files.length === 1) downloadBlob(files[0], files[0].name);
    else {
      const JSZip = await libJSZip(); const zip = new JSZip();
      files.forEach((f) => zip.file(f.name, f));
      downloadBlob(await zip.generateAsync({ type: 'blob' }), base + '-images.zip');
    }
    toast(t('exp.saved'), 'ok');
    return files;
  } catch (e) { errorToast(e, t('exp.failed')); return null; } finally { prog.finish(); }
}

export function openImageExportDialog() {
  return modal({
    title: t('exp.images'),
    build(body, foot, close) {
      const scope = h('select', {}, h('option', { value: 'all' }, t('scope.all')), h('option', { value: 'selected' }, t('scope.selected')), h('option', { value: 'current' }, t('scope.current')));
      const fmtSel = h('select', {}, h('option', { value: 'image/jpeg' }, 'JPEG'), h('option', { value: 'image/png' }, 'PNG'), h('option', { value: 'image/webp' }, 'WebP'));
      const q = h('select', {}, Object.entries(QUALITY).map(([k, v]) => h('option', { value: v, selected: k === 'high' }, t('q.' + k))));
      const sc = h('select', {}, [[1, '100%'], [0.75, '75%'], [0.5, '50%'], [0.25, '25%']].map(([v, l]) => h('option', { value: v }, l)));
      body.append(h('label', { class: 'field' }, h('span', {}, t('exp.scope')), scope), h('label', { class: 'field' }, h('span', {}, t('exp.format')), fmtSel),
        h('label', { class: 'field' }, h('span', {}, t('exp.quality')), q), h('label', { class: 'field' }, h('span', {}, t('exp.resize')), sc));
      foot.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { close(); exportImages({ scope: scope.value, format: fmtSel.value, quality: +q.value, scale: +sc.value }); } }, icon('download'), t('exp.create')));
    },
  });
}

/** Searchable PDF for given pages using defaults (used from OCR panel) */
export async function quickSearchablePdf(pages) {
  const o = { ...defaultExportOptions(), searchable: true, pageSize: 'original' };
  const prog = new Progress(t('exp.creating'));
  try {
    const bytes = await buildPdf(pages, o, { onProgress: (f, i, n) => prog.set(f, t('batch.page', { i, n })), cancelled: () => prog.cancelled });
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), safeName(state.doc?.title) + '-searchable.pdf');
    toast(t('exp.saved'), 'ok');
  } catch (e) { errorToast(e, t('exp.failed')); } finally { prog.finish(); }
}
