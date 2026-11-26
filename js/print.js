// Printing: dedicated print layout (CSS @page), preview, paper/orientation/margins/scale, PDF printing.
import { $, h, icon, PAGE_SIZES } from './util.js';
import { t } from './i18n.js';
import { state, scopePages } from './project.js';
import { ensureProcessed } from './render.js';
import { modal, toast, Progress, errorToast } from './ui.js';

export function openPrintDialog() {
  if (!state.pages.length) { toast(t('ws.noPages'), 'warn'); return; }
  const o = { scope: 'all', paper: 'A4', orientation: 'auto', margin: 10, scale: 'fit', keepBg: true };
  return modal({
    title: t('print.title'), big: true,
    build(body, foot, close) {
      const sel = (k, opts) => { const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: o[k] === v }, l))); s.onchange = () => { o[k] = s.value; prev(); }; return s; };
      const margin = h('input', { type: 'number', min: 0, max: 40, value: o.margin }); margin.oninput = () => { o.margin = +margin.value; prev(); };
      const bg = h('input', { type: 'checkbox', checked: true }); bg.onchange = () => { o.keepBg = bg.checked; };
      const fld = (l, el) => h('label', { class: 'field' }, h('span', {}, l), el);
      const pv = h('div', { class: 'preview-pane' });
      body.append(h('div', { class: 'split-2' }, h('div', {},
        fld(t('exp.scope'), sel('scope', [['all', t('scope.all')], ['selected', t('scope.selected')], ['current', t('scope.current')]])),
        fld(t('print.paper'), sel('paper', [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal']])),
        fld(t('exp.orientation'), sel('orientation', [['auto', t('orient.auto')], ['portrait', t('orient.portrait')], ['landscape', t('orient.landscape')]])),
        fld(t('exp.margin'), margin),
        fld(t('print.scale'), sel('scale', [['fit', t('print.fit')], ['actual', t('print.actual')]])),
        h('label', { class: 'switch' }, bg, h('span', {}, t('print.keepBg'))),
        h('p', { class: 'hint' }, t('print.hint'))), h('div', {}, h('strong', {}, t('print.preview')), pv)));
      const targets = () => (o.scope === 'current' ? [state.pages[state.cur]] : scopePages(o.scope)).filter(Boolean);
      async function prev() {
        pv.innerHTML = '';
        const tg = targets();
        const { w, hh } = paperDims(o, tg[0]);
        for (const p of tg.slice(0, 12)) {
          const k = 150 / w;
          const sheet = h('div', { style: { width: w * k + 'px', height: hh * k + 'px', background: '#fff', padding: o.margin * k + 'px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 10px rgba(0,0,0,.4)' } });
          const blob = await ensureProcessed(p).catch(() => null);
          if (blob) { const img = h('img', { src: URL.createObjectURL(blob), style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' } }); img.onload = () => URL.revokeObjectURL(img.src); sheet.append(img); }
          pv.append(h('figure', {}, sheet, h('figcaption', {}, `${o.paper} ${t('orient.' + (w > hh ? 'landscape' : 'portrait'))}`)));
        }
        if (tg.length > 12) pv.append(h('p', { class: 'hint' }, `+${tg.length - 12}`));
      }
      prev();
      foot.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => close() }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => { close(); printPages(targets(), o); } }, icon('printer'), t('act.print')));
    },
  });
}

function paperDims(o, firstPage) {
  let [w, hh] = PAGE_SIZES[o.paper] || PAGE_SIZES.A4;
  const land = o.orientation === 'landscape' || (o.orientation === 'auto' && firstPage && firstPage.procW > firstPage.procH);
  if (land) [w, hh] = [hh, w];
  return { w, hh, land };
}

export async function printPages(pages, o) {
  const root = $('#print-root');
  const prog = new Progress(t('print.preparing'), { cancellable: false });
  const urls = [];
  try {
    root.innerHTML = '';
    const { hh, land } = paperDims(o, pages[0]);
    let style = $('#print-page-style');
    if (!style) { style = h('style', { id: 'print-page-style' }); document.head.append(style); }
    style.textContent = `@page { size: ${o.paper} ${land ? 'landscape' : 'portrait'}; margin: ${o.margin}mm; }`;
    root.style.setProperty('--print-h', (hh - 2 * o.margin - 0.5) + 'mm');
    root.classList.toggle('keep-bg', !!o.keepBg);
    for (let i = 0; i < pages.length; i++) {
      prog.set(i / pages.length, t('batch.page', { i: i + 1, n: pages.length }));
      const blob = await ensureProcessed(pages[i]);
      const url = URL.createObjectURL(blob); urls.push(url);
      const img = h('img', { src: url, alt: '' });
      if (o.scale === 'actual') { const d = pages[i].dpi || 300; img.style.width = (pages[i].procW / d) + 'in'; }
      root.append(h('div', { class: 'print-page' + (o.scale === 'actual' ? ' actual' : '') }, img));
      await img.decode().catch(() => {});
    }
    prog.close();
    const cleanup = () => { root.innerHTML = ''; urls.forEach((u) => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  } catch (e) { prog.close(); errorToast(e, t('print.failed')); }
}

/** Print an existing PDF blob via a hidden iframe (desktop browsers); falls back to opening it. */
export function printBlobPdf(blob) {
  const url = URL.createObjectURL(blob);
  const mobile = /Android|iPhone|iPad/.test(navigator.userAgent);
  if (mobile) { window.open(url, '_blank'); toast(t('print.mobilePdf'), 'info'); return; }
  const fr = h('iframe', { src: url, style: { position: 'fixed', width: '1px', height: '1px', opacity: '0', border: '0' } });
  fr.onload = () => { try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch (_) { window.open(url, '_blank'); } setTimeout(() => { fr.remove(); URL.revokeObjectURL(url); }, 60000); };
  document.body.append(fr);
}
