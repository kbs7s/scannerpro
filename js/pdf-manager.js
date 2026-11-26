// PDF import (PDF.js) and lossless PDF tools (pdf-lib): merge, split, extract, reorder, rotate, delete.
import { h, icon, libPdfjs, libPdfLib, libJSZip, readAsArrayBuffer, downloadBlob, safeName } from './util.js';
import { t } from './i18n.js';
import { modal, toast, Progress, errorToast, promptDialog } from './ui.js';
import { makeCanvas, canvasToBlob } from './image-io.js';
import { settings } from './settings.js';

const MAX_PIXELS = 16_000_000; // stays inside iOS Safari canvas limits

export async function openPdf(data) {
  const pdfjs = await libPdfjs();
  return pdfjs.getDocument({ data: data instanceof ArrayBuffer ? new Uint8Array(data.slice(0)) : data, isEvalSupported: false, useSystemFonts: true }).promise;
}

export async function renderPdfPage(pdf, n, dpi, { type = 'image/jpeg', quality = 0.92 } = {}) {
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  let scale = dpi / 72;
  const area = vp1.width * vp1.height * scale * scale;
  if (area > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / area);
  const vp = page.getViewport({ scale });
  const c = makeCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await canvasToBlob(c, type, quality);
  const res = { blob, width: c.width, height: c.height, pdfSize: { w: vp1.width, h: vp1.height }, dpi: Math.round(scale * 72) };
  page.cleanup();
  return res;
}

async function thumbCanvas(pdf, n, maxW = 150) {
  const page = await pdf.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: maxW / vp1.width });
  const c = h('canvas', { width: Math.ceil(vp.width), height: Math.ceil(vp.height) });
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  page.cleanup();
  return c;
}

/** Shows page selection + DPI dialog, renders chosen pages. Returns page items or null. */
export async function importPdfFile(file) {
  let pdf;
  try { pdf = await openPdf(await readAsArrayBuffer(file)); }
  catch (e) { errorToast(e.name === 'PasswordException' ? new Error(t('pdf.encrypted')) : e, t('pdf.openFailed')); return null; }
  const n = pdf.numPages;
  const chosen = await modal({
    title: t('pdf.importTitle') + ' — ' + file.name,
    big: n > 1,
    build(body, foot, close) {
      const sel = new Set(Array.from({ length: n }, (_, i) => i + 1));
      const dpiSel = h('select', {}, [72, 96, 150, 200, 300, 400].map((d) => h('option', { value: d, selected: d === settings.importDpi }, d + ' DPI')));
      const count = h('span', { class: 'muted' });
      const upd = () => { count.textContent = t('pdf.selectedCount', { n: sel.size, total: n }); };
      const grid = h('div', { class: 'pdf-grid' });
      body.append(h('div', { class: 'row-btns' },
        h('label', { class: 'field', style: { margin: 0 } }, h('span', {}, t('pdf.dpi')), dpiSel),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { for (let i = 1; i <= n; i++) sel.add(i); grid.querySelectorAll('.pdf-tile').forEach((x) => x.classList.add('sel')); upd(); } }, t('pages.selectAll')),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { sel.clear(); grid.querySelectorAll('.pdf-tile').forEach((x) => x.classList.remove('sel')); upd(); } }, t('pages.selectNone')),
        count), h('p', { class: 'hint' }, t('pdf.rasterNote')), grid);
      for (let i = 1; i <= n; i++) {
        const tile = h('div', { class: 'pdf-tile sel', onclick: () => { sel.has(i) ? sel.delete(i) : sel.add(i); tile.classList.toggle('sel', sel.has(i)); upd(); } }, h('span', {}, String(i)));
        grid.append(tile);
        if (i <= 200) thumbCanvas(pdf, i, 120).then((c) => tile.prepend(c)).catch(() => {});
      }
      upd();
      foot.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { if (!sel.size) return; settings.importDpi = +dpiSel.value; close({ pages: [...sel].sort((a, b) => a - b), dpi: +dpiSel.value }); } }, t('pdf.importBtn')));
    },
  });
  if (!chosen) { pdf.destroy(); return null; }
  const prog = new Progress(t('pdf.importing'), { cancellable: true });
  const items = [];
  try {
    for (let k = 0; k < chosen.pages.length; k++) {
      if (prog.cancelled) break;
      prog.set(k / chosen.pages.length, t('batch.page', { i: k + 1, n: chosen.pages.length }));
      try {
        const r = await renderPdfPage(pdf, chosen.pages[k], chosen.dpi);
        items.push({ ...r, source: 'pdf', label: `${file.name.replace(/\.pdf$/i, '')} p${chosen.pages[k]}` });
      } catch (e) { prog.error(`${t('batch.page', { i: chosen.pages[k], n: '' })}: ${e.message}`); }
    }
    prog.set(1);
  } finally { prog.finish(); pdf.destroy(); }
  return items;
}

/* =================== Lossless PDF tools =================== */
export async function openPdfTools(initialFiles = []) {
  const files = []; // { name, bytes, pdfjs }
  let tiles = []; // { f, p, rot, el }
  const selected = new Set();
  return modal({
    title: t('pdftools.title'),
    big: true,
    build(body, foot, close) {
      const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, hidden: true });
      const grid = h('div', { class: 'pdf-grid' });
      const info = h('span', { class: 'muted' });
      const empty = h('div', { class: 'empty' }, h('p', {}, t('pdftools.empty')));
      body.append(h('p', { class: 'hint' }, t('pdftools.intro')), h('div', { class: 'row-btns' },
        h('button', { type: 'button', class: 'btn primary', onclick: () => input.click() }, icon('file-up'), t('pdftools.add')),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { tiles.forEach((x) => selected.add(x)); refresh(); } }, t('pages.selectAll')),
        h('button', { type: 'button', class: 'btn sm', onclick: () => { selected.clear(); refresh(); } }, t('pages.selectNone')),
        h('button', { type: 'button', class: 'btn sm', onclick: () => rotateSel(90) }, icon('rotate-cw'), t('geo.right')),
        h('button', { type: 'button', class: 'btn sm danger', onclick: () => { tiles = tiles.filter((x) => !selected.has(x)); selected.clear(); refresh(); } }, icon('trash-2'), t('act.delete')),
        info), empty, grid, input);
      input.onchange = async () => { await addFiles([...input.files]); input.value = ''; };
      const busy = (b) => foot.querySelectorAll('button').forEach((x) => { x.disabled = b; });

      async function addFiles(list) {
        for (const f of list) {
          try {
            const bytes = new Uint8Array(await readAsArrayBuffer(f));
            const pdf = await openPdf(bytes.slice());
            const fi = files.push({ name: f.name, bytes, pdf }) - 1;
            for (let p = 0; p < pdf.numPages; p++) {
              const tile = { f: fi, p, rot: 0 };
              tiles.push(tile);
            }
          } catch (e) { errorToast(e, f.name); }
        }
        refresh();
      }
      function rotateSel(d) { for (const x of selected) x.rot = (x.rot + d) % 360; refresh(); }
      let dragTile = null;
      function refresh() {
        grid.innerHTML = '';
        empty.classList.toggle('hidden', tiles.length > 0);
        info.textContent = t('pdftools.info', { pages: tiles.length, files: files.length, sel: selected.size });
        tiles.forEach((x, idx) => {
          const el = h('div', { class: 'pdf-tile' + (selected.has(x) ? ' sel' : ''), draggable: 'true' });
          el.onclick = (e) => { if (e.target.closest('button')) return; selected.has(x) ? selected.delete(x) : selected.add(x); refresh(); };
          el.ondragstart = () => { dragTile = x; el.classList.add('dragging'); };
          el.ondragend = () => el.classList.remove('dragging');
          el.ondragover = (e) => e.preventDefault();
          el.ondrop = (e) => { e.preventDefault(); if (!dragTile || dragTile === x) return; const from = tiles.indexOf(dragTile); tiles.splice(from, 1); tiles.splice(tiles.indexOf(x) + (from <= idx ? 1 : 0), 0, dragTile); refresh(); };
          const holder = h('div', { style: { transform: `rotate(${x.rot}deg)`, transition: 'transform .2s' } });
          if (!x.thumb) x.thumb = thumbCanvas(files[x.f].pdf, x.p + 1, 120);
          x.thumb.then((c) => { const cc = h('canvas', { width: c.width, height: c.height }); cc.getContext('2d').drawImage(c, 0, 0); holder.append(cc); }).catch(() => holder.append('⚠'));
          el.append(holder, h('span', {}, `${idx + 1} · ${files[x.f].name.slice(0, 18)} p${x.p + 1}`),
            h('div', { class: 'tile-acts' },
              h('button', { type: 'button', title: t('view.moveUp'), onclick: () => { if (idx > 0) { tiles.splice(idx, 1); tiles.splice(idx - 1, 0, x); refresh(); } } }, icon('chevron-up')),
              h('button', { type: 'button', title: t('view.moveDown'), onclick: () => { if (idx < tiles.length - 1) { tiles.splice(idx, 1); tiles.splice(idx + 1, 0, x); refresh(); } } }, icon('chevron-down')),
              h('button', { type: 'button', title: t('geo.right'), onclick: () => { x.rot = (x.rot + 90) % 360; refresh(); } }, icon('rotate-cw')),
              h('button', { type: 'button', title: t('act.delete'), onclick: () => { tiles.splice(idx, 1); selected.delete(x); refresh(); } }, icon('x'))));
          grid.append(el);
        });
      }
      async function build(list) {
        const { PDFDocument, degrees } = await libPdfLib();
        const out = await PDFDocument.create();
        const loaded = new Map();
        for (const x of list) {
          if (!loaded.has(x.f)) loaded.set(x.f, await PDFDocument.load(files[x.f].bytes, { ignoreEncryption: false }));
          const [pg] = await out.copyPages(loaded.get(x.f), [x.p]);
          if (x.rot) pg.setRotation(degrees((pg.getRotation().angle + x.rot) % 360));
          out.addPage(pg);
        }
        out.setProducer('Ultimate Smart Scanner Pro'); out.setCreator('Ultimate Smart Scanner Pro');
        return out.save();
      }
      const baseName = () => safeName(files[0]?.name.replace(/\.pdf$/i, '') || 'document');
      const run = (fn) => async () => {
        if (!tiles.length) { toast(t('pdftools.empty'), 'warn'); return; }
        busy(true);
        try { await fn(); } catch (e) { errorToast(e, t('pdftools.failed')); } finally { busy(false); }
      };
      foot.append(
        h('button', { type: 'button', class: 'btn', onclick: run(async () => {
          const list = tiles.filter((x) => selected.has(x));
          if (!list.length) { toast(t('pdftools.selectFirst'), 'warn'); return; }
          downloadBlob(new Blob([await build(list)], { type: 'application/pdf' }), baseName() + '-extract.pdf');
        }) }, icon('split'), t('pdftools.extract')),
        h('button', { type: 'button', class: 'btn', onclick: run(async () => {
          const JSZip = await libJSZip(); const zip = new JSZip();
          for (let i = 0; i < tiles.length; i++) zip.file(`${baseName()}-${String(i + 1).padStart(3, '0')}.pdf`, await build([tiles[i]]));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), baseName() + '-pages.zip');
        }) }, icon('scissors'), t('pdftools.splitAll')),
        h('button', { type: 'button', class: 'btn', onclick: run(async () => {
          const v = await promptDialog(t('pdftools.everyN'), '2', { type: 'number' }); const nn = parseInt(v, 10);
          if (!nn || nn < 1) return;
          const JSZip = await libJSZip(); const zip = new JSZip();
          for (let i = 0, k = 1; i < tiles.length; i += nn, k++) zip.file(`${baseName()}-part${k}.pdf`, await build(tiles.slice(i, i + nn)));
          downloadBlob(await zip.generateAsync({ type: 'blob' }), baseName() + '-split.zip');
        }) }, icon('scissors'), t('pdftools.splitN')),
        h('button', { type: 'button', class: 'btn', onclick: run(async () => {
          const list = selected.size ? tiles.filter((x) => selected.has(x)) : tiles;
          const items = [];
          const prog = new Progress(t('pdf.importing'));
          try {
            for (let i = 0; i < list.length && !prog.cancelled; i++) {
              prog.set(i / list.length, t('batch.page', { i: i + 1, n: list.length }));
              const r = await renderPdfPage(files[list[i].f].pdf, list[i].p + 1, settings.importDpi);
              items.push({ ...r, source: 'pdf', label: `${files[list[i].f].name.replace(/\.pdf$/i, '')} p${list[i].p + 1}`, rotation: list[i].rot });
            }
          } finally { prog.finish(); }
          close({ items });
        }) }, icon('image-plus'), t('pdftools.toProject')),
        h('button', { type: 'button', class: 'btn primary', onclick: run(async () => {
          downloadBlob(new Blob([await build(tiles)], { type: 'application/pdf' }), baseName() + (files.length > 1 ? '-merged' : '-edited') + '.pdf');
          toast(t('pdftools.saved'), 'ok');
        }) }, icon('save'), files.length > 1 ? t('pdftools.saveMerged') : t('pdftools.save')),
      );
      if (initialFiles.length) addFiles(initialFiles); else refresh();
    },
    onClose: () => files.forEach((f) => f.pdf.destroy && f.pdf.destroy()),
  });
}
