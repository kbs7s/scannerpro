// Document & page model with write-through IndexedDB persistence and undo history.
import * as db from './database.js';
import { uid, bus, normalizeText } from './util.js';
import { record } from './history.js';
import { t } from './i18n.js';

export const state = {
  doc: null,
  pages: [],
  cur: 0,
  selected: new Set(),
};

export const DEFAULT_CATEGORIES = ['general', 'invoices', 'ids', 'medical', 'legal', 'receipts', 'books', 'work', 'personal'];

const ORIG = (id) => 'o_' + id;
const PROC = (id) => 'p_' + id;
const THUMB = (id) => 't_' + id;
const OCRPDF = (id) => 'x_' + id;
export const blobIds = { ORIG, PROC, THUMB, OCRPDF };

export function currentPage() { return state.pages[state.cur] || null; }
export function pageById(id) { return state.pages.find((p) => p.id === id) || null; }
export function pageIndex(id) { return state.pages.findIndex((p) => p.id === id); }

export function defaultTitle() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${t('doc.defaultName')} ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

/* ---------- Documents ---------- */
export async function createDoc(title, extra = {}) {
  const now = Date.now();
  const doc = { id: uid('d_'), title: title || defaultTitle(), category: 'general', tags: [], notes: '', createdAt: now, updatedAt: now, scanDate: now, favorite: false, deleted: false, pageIds: [], pageCount: 0, thumbId: null, ocrText: '', hasOcr: false, ...extra };
  await db.put('docs', doc);
  return doc;
}

export async function listDocs() { return db.getAll('docs'); }

export async function openDoc(id) {
  const doc = await db.get('docs', id);
  if (!doc) throw new Error(t('err.docMissing'));
  const pages = await db.byIndex('pages', 'docId', id);
  const order = new Map(doc.pageIds.map((pid, i) => [pid, i]));
  pages.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  // repair: page ids missing from doc order
  doc.pageIds = pages.map((p) => p.id);
  state.doc = doc; state.pages = pages; state.cur = 0; state.selected = new Set();
  bus.emit('doc-opened', doc);
  return doc;
}

export function closeDoc() { state.doc = null; state.pages = []; state.cur = 0; state.selected = new Set(); bus.emit('doc-closed'); }

export async function saveDoc(patch = {}) {
  if (!state.doc) return;
  Object.assign(state.doc, patch);
  state.doc.pageIds = state.pages.map((p) => p.id);
  state.doc.pageCount = state.pages.length;
  state.doc.updatedAt = Date.now();
  state.doc.thumbId = state.pages[0] ? (state.pages[0].thumbId || null) : null;
  const texts = state.pages.map((p) => (p.ocr && p.ocr.text) || '').filter(Boolean);
  state.doc.hasOcr = texts.length > 0;
  state.doc.ocrText = texts.join('\n\f\n');
  state.doc.searchIndex = normalizeText([state.doc.title, state.doc.notes, (state.doc.tags || []).join(' '), state.doc.ocrText].join(' '));
  await db.put('docs', state.doc);
  bus.emit('doc-saved', state.doc);
}

export async function updateDocMeta(id, patch) {
  const doc = state.doc && state.doc.id === id ? state.doc : await db.get('docs', id);
  if (!doc) return;
  Object.assign(doc, patch, { updatedAt: Date.now() });
  doc.searchIndex = normalizeText([doc.title, doc.notes, (doc.tags || []).join(' '), doc.ocrText || ''].join(' '));
  await db.put('docs', doc);
  bus.emit('docs-changed');
  if (state.doc && state.doc.id === id) bus.emit('doc-saved', doc);
}

export async function trashDocs(ids, deleted = true) {
  for (const id of ids) await updateDocMeta(id, { deleted, deletedAt: deleted ? Date.now() : null });
}

export async function purgeDoc(id) {
  const pages = await db.byIndex('pages', 'docId', id);
  await db.tx(['pages', 'blobs', 'docs'], (s) => {
    for (const p of pages) {
      s('pages').delete(p.id);
      for (const b of [ORIG(p.id), PROC(p.id), THUMB(p.id), OCRPDF(p.id)]) s('blobs').delete(b);
    }
    s('docs').delete(id);
  });
  bus.emit('docs-changed');
}

export async function duplicateDoc(id, titleSuffix = '') {
  const src = await db.get('docs', id);
  const pages = await db.byIndex('pages', 'docId', id);
  const order = new Map(src.pageIds.map((pid, i) => [pid, i]));
  pages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const doc = await createDoc(src.title + titleSuffix, { category: src.category, tags: [...(src.tags || [])], notes: src.notes, favorite: false, ocrText: src.ocrText, hasOcr: src.hasOcr, scanDate: src.scanDate });
  const ids = [];
  for (const p of pages) { const np = await clonePageRecord(p, doc.id); ids.push(np.id); if (!doc.thumbId) doc.thumbId = np.thumbId; }
  doc.pageIds = ids; doc.pageCount = ids.length;
  doc.searchIndex = normalizeText([doc.title, doc.notes, doc.tags.join(' '), doc.ocrText].join(' '));
  await db.put('docs', doc);
  bus.emit('docs-changed');
  return doc;
}

/** Merge several documents (in given order) into a new document. */
export async function mergeDocs(ids, title) {
  const doc = await createDoc(title || t('lib.mergedName'));
  const all = [];
  for (const id of ids) {
    const src = await db.get('docs', id); if (!src) continue;
    const pages = await db.byIndex('pages', 'docId', id);
    const order = new Map(src.pageIds.map((pid, i) => [pid, i]));
    pages.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const p of pages) all.push(await clonePageRecord(p, doc.id));
  }
  doc.pageIds = all.map((p) => p.id); doc.pageCount = all.length; doc.thumbId = all[0]?.thumbId || null;
  const texts = all.map((p) => p.ocr?.text || '').filter(Boolean);
  doc.hasOcr = texts.length > 0; doc.ocrText = texts.join('\n\f\n');
  doc.searchIndex = normalizeText([doc.title, doc.ocrText].join(' '));
  await db.put('docs', doc);
  bus.emit('docs-changed');
  return doc;
}

async function clonePageRecord(p, docId) {
  const np = JSON.parse(JSON.stringify(p));
  np.id = uid('p_'); np.docId = docId; np.createdAt = Date.now();
  const copies = [[ORIG(p.id), ORIG(np.id)], [PROC(p.id), PROC(np.id)], [THUMB(p.id), THUMB(np.id)], [OCRPDF(p.id), OCRPDF(np.id)]];
  for (const [a, b] of copies) { const bl = await db.getBlob(a); if (bl) await db.putBlob(b, bl); }
  np.origId = ORIG(np.id);
  np.procId = p.procId ? PROC(np.id) : null;
  np.thumbId = p.thumbId ? THUMB(np.id) : null;
  if (np.ocr && np.ocr.pdfId) np.ocr.pdfId = OCRPDF(np.id);
  await db.put('pages', np);
  return np;
}

/* ---------- Pages ---------- */
export function newPageRecord(docId, { width, height, source = 'import', pdfSize = null, dpi = null, corners = null, detect = null, params = null, preset = '', label = '', rotation = 0 } = {}) {
  const id = uid('p_');
  return {
    id, docId, origId: ORIG(id), origW: width, origH: height, source, pdfSize, dpi, label,
    corners, rotation: rotation || 0, angle: 0, flipH: false, flipV: false,
    params: params || {}, preset, rev: 1, procId: null, procRev: 0, procW: 0, procH: 0,
    thumbId: null, ocr: null, detect, createdAt: Date.now(),
  };
}

/** items: [{ blob, width, height, ...pageOpts }] */
export async function addPages(items, at = state.pages.length, { history = true } = {}) {
  if (!state.doc) throw new Error('No open document');
  const created = [];
  for (const it of items) {
    const p = newPageRecord(state.doc.id, it);
    await db.putBlob(p.origId, it.blob);
    await db.put('pages', p);
    created.push(p);
  }
  state.pages.splice(at, 0, ...created);
  state.cur = Math.min(at, state.pages.length - 1);
  await saveDoc();
  bus.emit('pages-changed', { added: created.map((p) => p.id) });
  if (history) {
    const ids = created.map((p) => p.id);
    const snap = await snapshotPages(ids);
    record(t('hist.addPages'), () => removePagesRaw(ids), () => restorePagesRaw(snap));
  }
  return created;
}

export async function updatePage(page, patch, { history = true, label = t('hist.edit'), rerender = true } = {}) {
  const before = {};
  for (const k of Object.keys(patch)) before[k] = clone(page[k]);
  Object.assign(page, patch);
  if (rerender) page.rev = (page.rev || 0) + 1;
  await db.put('pages', page);
  bus.emit('page-changed', page, { rerender });
  if (history) {
    const id = page.id; const after = clone(patch);
    record(label, () => applyRaw(id, before, rerender), () => applyRaw(id, after, rerender));
  }
}

async function applyRaw(id, patch, rerender) {
  const p = pageById(id) || await db.get('pages', id);
  if (!p) return;
  Object.assign(p, clone(patch));
  if (rerender) p.rev = (p.rev || 0) + 1;
  await db.put('pages', p);
  const i = pageIndex(id); if (i >= 0) state.cur = i;
  bus.emit('page-changed', p, { rerender });
}

/** Apply same patch to many pages as one undoable action */
export async function updatePages(pages, patchFn, { label = t('hist.batchEdit') } = {}) {
  const befores = []; const afters = [];
  for (const p of pages) {
    const patch = typeof patchFn === 'function' ? patchFn(p) : patchFn;
    const b = {}; for (const k of Object.keys(patch)) b[k] = clone(p[k]);
    befores.push([p.id, b]); afters.push([p.id, clone(patch)]);
    Object.assign(p, patch); p.rev = (p.rev || 0) + 1;
    await db.put('pages', p);
    bus.emit('page-changed', p, { rerender: true });
  }
  record(label, async () => { for (const [id, b] of befores) await applyRaw(id, b, true); }, async () => { for (const [id, a] of afters) await applyRaw(id, a, true); });
}

async function snapshotPages(ids) {
  const out = [];
  for (const id of ids) {
    const p = pageById(id) || await db.get('pages', id);
    if (!p) continue;
    const blobs = {};
    for (const b of [ORIG(id), PROC(id), THUMB(id), OCRPDF(id)]) { const bl = await db.getBlob(b); if (bl) blobs[b] = bl; }
    out.push({ rec: clone(p), blobs, index: pageIndex(id) });
  }
  return out;
}

async function removePagesRaw(ids) {
  await db.tx(['pages', 'blobs'], (s) => {
    for (const id of ids) {
      s('pages').delete(id);
      for (const b of [ORIG(id), PROC(id), THUMB(id), OCRPDF(id)]) s('blobs').delete(b);
    }
  });
  state.pages = state.pages.filter((p) => !ids.includes(p.id));
  ids.forEach((id) => state.selected.delete(id));
  state.cur = Math.max(0, Math.min(state.cur, state.pages.length - 1));
  await saveDoc();
  bus.emit('pages-changed', { removed: ids });
}

async function restorePagesRaw(snap) {
  const sorted = snap.slice().sort((a, b) => a.index - b.index);
  for (const s of sorted) {
    for (const [k, v] of Object.entries(s.blobs)) await db.putBlob(k, v);
    await db.put('pages', s.rec);
    const rec = clone(s.rec);
    state.pages.splice(Math.min(s.index < 0 ? state.pages.length : s.index, state.pages.length), 0, rec);
  }
  state.cur = Math.max(0, pageIndex(sorted[0]?.rec.id));
  await saveDoc();
  bus.emit('pages-changed', { added: sorted.map((s) => s.rec.id) });
}

export async function deletePages(ids) {
  const snap = await snapshotPages(ids);
  await removePagesRaw(ids);
  record(t('hist.deletePages'), () => restorePagesRaw(snap), () => removePagesRaw(ids));
}

export async function duplicatePages(ids) {
  const created = [];
  for (const id of ids) {
    const p = pageById(id); if (!p) continue;
    const np = await clonePageRecord(p, state.doc.id);
    const i = pageIndex(id);
    state.pages.splice(i + 1, 0, np);
    created.push(np);
  }
  await saveDoc();
  bus.emit('pages-changed', { added: created.map((c) => c.id) });
  const nids = created.map((c) => c.id);
  const snap = await snapshotPages(nids);
  record(t('hist.duplicate'), () => removePagesRaw(nids), () => restorePagesRaw(snap));
  return created;
}

/** Move pages (by id) so that they start at index `to` (index in the list after removal). */
export async function movePages(ids, to) {
  const beforeOrder = state.pages.map((p) => p.id);
  applyOrderRaw(computeMove(beforeOrder, ids, to));
  const afterOrder = state.pages.map((p) => p.id);
  await saveDoc();
  bus.emit('pages-changed', { reordered: true });
  record(t('hist.reorder'), async () => { applyOrderRaw(beforeOrder); await saveDoc(); bus.emit('pages-changed', { reordered: true }); },
    async () => { applyOrderRaw(afterOrder); await saveDoc(); bus.emit('pages-changed', { reordered: true }); });
}

function computeMove(order, ids, to) {
  const moving = order.filter((id) => ids.includes(id));
  const rest = order.filter((id) => !ids.includes(id));
  to = Math.max(0, Math.min(rest.length, to));
  rest.splice(to, 0, ...moving);
  return rest;
}

function applyOrderRaw(order) {
  const curId = currentPage()?.id;
  const map = new Map(state.pages.map((p) => [p.id, p]));
  state.pages = order.map((id) => map.get(id)).filter(Boolean);
  const i = pageIndex(curId); state.cur = i >= 0 ? i : 0;
}

/** Split current document at index: pages from index onward move into a new document. */
export async function splitDocAt(index) {
  if (index <= 0 || index >= state.pages.length) throw new Error(t('err.splitRange'));
  const moving = state.pages.slice(index);
  const nd = await createDoc(state.doc.title + ' (2)', { category: state.doc.category, tags: [...(state.doc.tags || [])] });
  for (const p of moving) { p.docId = nd.id; await db.put('pages', p); }
  nd.pageIds = moving.map((p) => p.id); nd.pageCount = moving.length; nd.thumbId = moving[0].thumbId;
  const texts = moving.map((p) => p.ocr?.text || '').filter(Boolean); nd.ocrText = texts.join('\n\f\n'); nd.hasOcr = texts.length > 0;
  nd.searchIndex = normalizeText([nd.title, nd.ocrText].join(' '));
  await db.put('docs', nd);
  state.pages = state.pages.slice(0, index);
  state.cur = Math.min(state.cur, state.pages.length - 1);
  state.selected.clear();
  await saveDoc();
  bus.emit('pages-changed', { removed: moving.map((p) => p.id) });
  bus.emit('docs-changed');
  return nd;
}

/** Copy pages into a new document (extract) */
export async function extractToNewDoc(ids, title) {
  const nd = await createDoc(title || (state.doc.title + ' — ' + t('page.extracted')), { category: state.doc.category });
  const recs = [];
  for (const id of ids) { const p = pageById(id); if (p) recs.push(await clonePageRecord(p, nd.id)); }
  nd.pageIds = recs.map((p) => p.id); nd.pageCount = recs.length; nd.thumbId = recs[0]?.thumbId || null;
  const texts = recs.map((p) => p.ocr?.text || '').filter(Boolean); nd.ocrText = texts.join('\n\f\n'); nd.hasOcr = texts.length > 0;
  nd.searchIndex = normalizeText([nd.title, nd.ocrText].join(' '));
  await db.put('docs', nd);
  bus.emit('docs-changed');
  return nd;
}

export async function replaceOriginal(page, blob, width, height, { source } = {}) {
  const prevBlob = await db.getBlob(page.origId);
  const before = { origW: page.origW, origH: page.origH, corners: page.corners, source: page.source, rotation: page.rotation, angle: page.angle };
  await db.putBlob(page.origId, blob);
  await updatePage(page, { origW: width, origH: height, corners: null, rotation: 0, angle: 0, source: source || page.source, pdfSize: null }, { history: false });
  record(t('page.replace'), async () => { await db.putBlob(page.origId, prevBlob); await applyRaw(page.id, before, true); },
    async () => { await db.putBlob(page.origId, blob); await applyRaw(page.id, { origW: width, origH: height, corners: null, rotation: 0, angle: 0 }, true); });
}

export function selectedPages() {
  if (!state.selected.size) { const c = currentPage(); return c ? [c] : []; }
  return state.pages.filter((p) => state.selected.has(p.id));
}
export function scopePages(scope) { return scope === 'all' ? state.pages.slice() : selectedPages(); }

export async function persistSession(extra = {}) {
  try {
    await db.kvSet('session', { docId: state.doc?.id || null, pageId: currentPage()?.id || null, at: Date.now(), ...extra });
  } catch (_) { /* ignore */ }
}

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
