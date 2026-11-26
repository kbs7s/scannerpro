// Local document archive: search (title, tags, notes, OCR text with Arabic normalisation), filters,
// sorting, categories, favourites, trash, bulk operations.
import { $, $$, h, icon, bus, normalizeText, fmtDate, debounce, escapeHtml, lsGet, lsSet } from './util.js';
import { t } from './i18n.js';
import * as db from './database.js';
import { listDocs, updateDocMeta, trashDocs, purgeDoc, duplicateDoc, mergeDocs, DEFAULT_CATEGORIES } from './project.js';
import { modal, confirmDialog, promptDialog, toast, showMenu, choiceDialog, Progress, errorToast } from './ui.js';
import { downloadBackup } from './storage.js';

const ui = { trash: false, selected: new Set(), docs: [] };
const thumbUrls = new Map();
let openHandler = null;
let exportHandler = null;

export function categories() {
  const custom = lsGet('ssp.categories', []);
  return [...DEFAULT_CATEGORIES, ...custom.filter((c) => !DEFAULT_CATEGORIES.includes(c))];
}
export const catLabel = (c) => (DEFAULT_CATEGORIES.includes(c) ? t('cat.' + c) : c);
function addCategory(name) {
  const custom = lsGet('ssp.categories', []);
  if (!custom.includes(name) && !DEFAULT_CATEGORIES.includes(name)) { custom.push(name); lsSet('ssp.categories', custom); }
}

export function initArchive({ onOpen, onExportDoc }) {
  openHandler = onOpen; exportHandler = onExportDoc;
  fillCategoryFilter();
  const re = debounce(renderLibrary, 150);
  ['#lib-q', '#lib-cat', '#lib-sort', '#lib-fav', '#lib-ocr', '#lib-from', '#lib-to'].forEach((s) => $(s).addEventListener('input', re));
  $('#lib-trash-toggle').onclick = () => { ui.trash = !ui.trash; ui.selected.clear(); $('#lib-trash-toggle').classList.toggle('primary', ui.trash); renderLibrary(); };
  $('#btn-empty-trash').onclick = emptyTrash;
  $$('#lib-bulk [data-bulk]').forEach((b) => { b.onclick = () => bulk(b.dataset.bulk); });
  bus.on('docs-changed', re);
  bus.on('doc-saved', re);
  bus.on('lang', () => { fillCategoryFilter(); renderLibrary(); });
}

function fillCategoryFilter() {
  const sel = $('#lib-cat'); const v = sel.value;
  sel.innerHTML = '';
  sel.append(h('option', { value: '' }, t('lib.allCategories')));
  for (const c of categories()) sel.append(h('option', { value: c }, catLabel(c)));
  sel.value = v;
}

function matchSnippet(doc, q) {
  if (!q || !doc.ocrText) return null;
  const nt = normalizeText(doc.ocrText);
  const i = nt.indexOf(q);
  if (i < 0) return null;
  // normalisation keeps string length for nearly all characters, so map the index back
  const start = Math.max(0, i - 40), end = Math.min(doc.ocrText.length, i + q.length + 60);
  const raw = doc.ocrText.slice(start, end).replace(/\s+/g, ' ');
  const qi = normalizeText(raw).indexOf(q);
  if (qi < 0) return escapeHtml(raw);
  return (start ? '…' : '') + escapeHtml(raw.slice(0, qi)) + '<mark>' + escapeHtml(raw.slice(qi, qi + q.length)) + '</mark>' + escapeHtml(raw.slice(qi + q.length)) + '…';
}

export async function renderLibrary() {
  let docs = [];
  try { docs = await listDocs(); } catch (e) { errorToast(e); }
  const trashCount = docs.filter((d) => d.deleted).length;
  $('#trash-count').textContent = trashCount ? String(trashCount) : '';
  const q = normalizeText($('#lib-q').value.trim());
  const cat = $('#lib-cat').value, fav = $('#lib-fav').checked, ocr = $('#lib-ocr').checked;
  const from = $('#lib-from').value ? new Date($('#lib-from').value).getTime() : null;
  const to = $('#lib-to').value ? new Date($('#lib-to').value).getTime() + 86400000 : null;
  docs = docs.filter((d) => !!d.deleted === ui.trash);
  if (cat) docs = docs.filter((d) => d.category === cat);
  if (fav) docs = docs.filter((d) => d.favorite);
  if (ocr) docs = docs.filter((d) => d.hasOcr);
  if (from) docs = docs.filter((d) => (d.scanDate || d.createdAt) >= from);
  if (to) docs = docs.filter((d) => (d.scanDate || d.createdAt) < to);
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    docs = docs.filter((d) => { const idx = d.searchIndex || normalizeText([d.title, d.notes, (d.tags || []).join(' '), d.ocrText || ''].join(' ')); return terms.every((x) => idx.includes(x)); });
  }
  const sort = $('#lib-sort').value;
  const cmp = { 'updated-desc': (a, b) => b.updatedAt - a.updatedAt, 'updated-asc': (a, b) => a.updatedAt - b.updatedAt, 'name-asc': (a, b) => a.title.localeCompare(b.title, document.documentElement.lang), 'scan-desc': (a, b) => (b.scanDate || 0) - (a.scanDate || 0) }[sort];
  docs.sort(cmp);
  ui.docs = docs;
  const grid = $('#lib-grid'); grid.innerHTML = '';
  $('#lib-empty').classList.toggle('hidden', docs.length > 0);
  $('#lib-empty p').textContent = ui.trash ? t('lib.trashEmpty') : (q || cat || fav || ocr ? t('lib.noMatch') : t('lib.empty'));
  $('#trash-actions').classList.toggle('hidden', !ui.trash || !docs.length);
  for (const d of docs) grid.append(card(d, q));
  updateBulk();
}

function card(d, q) {
  const thumb = h('button', { class: 'doc-thumb', 'aria-label': d.title, onclick: () => (ui.trash ? null : openHandler(d.id)) });
  if (d.thumbId) {
    db.getBlob(d.thumbId).then((b) => {
      if (!b) return;
      const old = thumbUrls.get(d.id); if (old) URL.revokeObjectURL(old);
      const u = URL.createObjectURL(b); thumbUrls.set(d.id, u);
      thumb.style.backgroundImage = `url("${u}")`;
    }).catch(() => {});
  }
  const chk = h('input', { type: 'checkbox', class: 'doc-check', 'aria-label': t('act.select'), checked: ui.selected.has(d.id) });
  chk.onchange = () => { chk.checked ? ui.selected.add(d.id) : ui.selected.delete(d.id); el.classList.toggle('sel', chk.checked); updateBulk(); };
  const favBtn = h('button', { class: 'doc-fav' + (d.favorite ? ' on' : ''), 'aria-label': t('lib.toggleFav'), onclick: async () => { await updateDocMeta(d.id, { favorite: !d.favorite }); } }, icon('star'));
  const menuBtn = h('button', { class: 'doc-menu', 'aria-label': t('act.more'), onclick: (e) => docMenu(e.currentTarget, d) }, icon('ellipsis-vertical'));
  const snip = matchSnippet(d, q);
  const el = h('article', { class: 'doc-card' + (ui.selected.has(d.id) ? ' sel' : ''), role: 'listitem' },
    thumb, chk, ui.trash ? null : favBtn, menuBtn,
    h('div', { class: 'doc-meta' },
      h('div', { class: 'doc-title', title: d.title }, d.title),
      h('div', { class: 'doc-sub' }, h('span', {}, t('lib.pages', { n: d.pageCount || 0 })), h('span', {}, '·'), h('span', {}, fmtDate(d.updatedAt)),
        d.hasOcr ? h('span', { class: 'badge info' }, 'OCR') : null),
      h('div', { class: 'doc-tags' }, h('span', { class: 'badge' }, catLabel(d.category || 'general')), ...(d.tags || []).slice(0, 3).map((tg) => h('span', { class: 'badge' }, '#' + tg))),
      snip ? h('div', { class: 'doc-match', html: snip }) : null));
  return el;
}

function docMenu(anchor, d) {
  if (ui.trash) {
    showMenu(anchor, [
      { icon: 'archive-restore', label: t('lib.restore'), fn: () => trashDocs([d.id], false) },
      { icon: 'trash-2', label: t('lib.deleteForever'), danger: true, fn: async () => { if (await confirmDialog(t('lib.confirmPurge', { n: 1 }), { danger: true, okText: t('lib.deleteForever') })) await purgeDoc(d.id); } },
    ]);
    return;
  }
  showMenu(anchor, [
    { icon: 'folder-open', label: t('act.open'), fn: () => openHandler(d.id) },
    { icon: 'pencil', label: t('lib.rename'), fn: async () => { const n = await promptDialog(t('lib.rename'), d.title); if (n && n.trim()) await updateDocMeta(d.id, { title: n.trim() }); } },
    { icon: 'info', label: t('doc.properties'), fn: () => editDocProperties(d) },
    { icon: 'copy', label: t('lib.duplicate'), fn: async () => { await duplicateDoc(d.id, ' (' + t('lib.copy') + ')'); toast(t('lib.duplicated'), 'ok'); } },
    { icon: 'folder', label: t('lib.moveCategory'), fn: async () => { const c = await pickCategory(d.category); if (c) await updateDocMeta(d.id, { category: c }); } },
    { icon: 'star', label: d.favorite ? t('lib.unfav') : t('lib.fav'), fn: () => updateDocMeta(d.id, { favorite: !d.favorite }) },
    { icon: 'download', label: t('lib.exportPdf'), fn: () => exportHandler(d.id, 'pdf') },
    { icon: 'package', label: t('act.saveProject'), fn: () => downloadBackup([d.id], d.title) },
    '-',
    { icon: 'trash-2', label: t('lib.toTrash'), danger: true, fn: () => trashDocs([d.id], true).then(() => toast(t('lib.trashed'), 'ok', { action: { label: t('act.undo'), fn: () => trashDocs([d.id], false) } })) },
  ]);
}

export async function pickCategory(current) {
  const opts = categories().map((c) => ({ value: c, label: catLabel(c) + (c === current ? ' ✓' : '') }));
  opts.push({ value: '__new', label: '+ ' + t('lib.newCategory'), icon: 'plus' });
  const v = await choiceDialog(t('lib.moveCategory'), opts);
  if (v === '__new') { const n = await promptDialog(t('lib.newCategory'), ''); if (!n || !n.trim()) return null; addCategory(n.trim()); fillCategoryFilter(); return n.trim(); }
  return v || null;
}

export async function editDocProperties(d) {
  d = (await db.get('docs', d.id)) || d;
  const res = await modal({
    title: t('doc.properties'),
    build(body, foot, close) {
      const title = h('input', { type: 'text', value: d.title });
      const cat = h('select', {}, categories().map((c) => h('option', { value: c, selected: c === d.category }, catLabel(c))));
      const tags = h('input', { type: 'text', value: (d.tags || []).join(', '), placeholder: t('doc.tagsPh') });
      const scan = h('input', { type: 'date', value: new Date(d.scanDate || d.createdAt).toISOString().slice(0, 10) });
      const notes = h('textarea', { rows: 4, style: { width: '100%' } }, d.notes || '');
      const fav = h('input', { type: 'checkbox', checked: !!d.favorite });
      const fld = (l, el) => h('label', { class: 'field' }, h('span', {}, l), el);
      body.append(fld(t('doc.title'), title), fld(t('doc.category'), cat), fld(t('doc.tags'), tags), fld(t('doc.scanDate'), scan), fld(t('doc.notes'), notes),
        h('label', { class: 'switch' }, fav, h('span', {}, t('lib.favorite'))),
        h('dl', { class: 'kv' }, h('dt', {}, t('doc.created')), h('dd', {}, fmtDate(d.createdAt)), h('dt', {}, t('doc.updated')), h('dd', {}, fmtDate(d.updatedAt)), h('dt', {}, t('doc.pageCount')), h('dd', {}, String(d.pageCount || 0))));
      foot.append(h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => close({ title: title.value.trim() || d.title, category: cat.value, tags: tags.value.split(/[,،]/).map((s) => s.trim().replace(/^#/, '')).filter(Boolean), scanDate: new Date(scan.value).getTime() || d.scanDate, notes: notes.value, favorite: fav.checked }) }, t('act.save')));
    },
  });
  if (res) { await updateDocMeta(d.id, res); toast(t('doc.saved'), 'ok'); }
  return res;
}

function updateBulk() {
  const n = ui.selected.size;
  $('#lib-bulk').classList.toggle('hidden', !n);
  $('#lib-bulk-count').textContent = t('lib.selectedN', { n });
  $('[data-bulk="restore"]').classList.toggle('hidden', !ui.trash);
  ['export', 'category', 'fav', 'merge'].forEach((k) => $(`[data-bulk="${k}"]`).classList.toggle('hidden', ui.trash));
  $('[data-bulk="delete"] span').textContent = ui.trash ? t('lib.deleteForever') : t('lib.toTrash');
}

async function bulk(action) {
  const ids = [...ui.selected];
  if (action === 'clear') { ui.selected.clear(); renderLibrary(); return; }
  if (!ids.length) return;
  try {
    if (action === 'delete') {
      if (ui.trash) { if (!(await confirmDialog(t('lib.confirmPurge', { n: ids.length }), { danger: true, okText: t('lib.deleteForever') }))) return; for (const id of ids) await purgeDoc(id); }
      else { await trashDocs(ids, true); toast(t('lib.trashed'), 'ok', { action: { label: t('act.undo'), fn: () => trashDocs(ids, false) } }); }
    } else if (action === 'restore') await trashDocs(ids, false);
    else if (action === 'category') { const c = await pickCategory(); if (c) for (const id of ids) await updateDocMeta(id, { category: c }); }
    else if (action === 'fav') { const all = ui.docs.filter((d) => ids.includes(d.id)); const on = !all.every((d) => d.favorite); for (const id of ids) await updateDocMeta(id, { favorite: on }); }
    else if (action === 'merge') {
      if (ids.length < 2) { toast(t('lib.mergeNeedTwo'), 'warn'); return; }
      const ordered = ui.docs.filter((d) => ids.includes(d.id)).map((d) => d.id);
      const nd = await mergeDocs(ordered, t('lib.mergedName'));
      toast(t('lib.merged'), 'ok', { action: { label: t('act.open'), fn: () => openHandler(nd.id) } });
    } else if (action === 'export') {
      const choice = await choiceDialog(t('lib.exportZip'), [{ value: 'pdf', label: t('lib.zipOfPdfs'), icon: 'file-text', primary: true }, { value: 'backup', label: t('lib.zipBackup'), icon: 'package' }]);
      if (choice === 'pdf') await exportHandler(ids, 'zip');
      else if (choice === 'backup') { const p = new Progress(t('backup.creating')); try { await downloadBackup(ids, 'documents'); } finally { p.finish(); } }
    }
  } catch (e) { errorToast(e); }
  ui.selected.clear();
  renderLibrary();
}

async function emptyTrash() {
  const docs = (await listDocs()).filter((d) => d.deleted);
  if (!docs.length) return;
  if (!(await confirmDialog(t('lib.confirmPurge', { n: docs.length }), { danger: true, okText: t('lib.emptyTrash') }))) return;
  for (const d of docs) await purgeDoc(d.id);
  toast(t('lib.trashEmptied'), 'ok');
}

export function recentDocs(n = 5) { return listDocs().then((d) => d.filter((x) => !x.deleted).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, n)); }
