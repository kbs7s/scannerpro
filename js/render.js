// Non-destructive render pipeline: original blob + edit state -> processed image.
// Previews run at reduced resolution; final renders at full (capped) resolution in the background.
import * as db from './database.js';
import { cvRun } from './cv-client.js';
import { decode, bitmapToImageData, imageDataToBlob, makeThumb, isBinary } from './image-io.js';
import { state, blobIds, pageById, saveDoc } from './project.js';
import { settings } from './settings.js';
import { bus, debounce } from './util.js';

const PREVIEW_MAX = () => (matchMedia('(max-width: 699px)').matches ? 1200 : 1600);
const srcCache = new Map(); // pageId -> { bmp, key }
const gen = new Map();

export function editState(page) {
  return { corners: page.corners, rotation: page.rotation, angle: page.angle, flipH: page.flipH, flipV: page.flipV, params: page.params || {} };
}

async function previewSource(page) {
  const key = page.origId + ':' + page.origW + 'x' + page.origH;
  const c = srcCache.get(page.id);
  if (c && c.key === key) { srcCache.delete(page.id); srcCache.set(page.id, c); return c.bmp; }
  const blob = await db.getBlob(page.origId);
  if (!blob) throw new Error('Original image missing');
  const bmp = await decode(blob, PREVIEW_MAX());
  srcCache.set(page.id, { bmp, key });
  while (srcCache.size > 5) { const [k, v] = srcCache.entries().next().value; v.bmp.close && v.bmp.close(); srcCache.delete(k); }
  return bmp;
}
export function dropSourceCache(id) { const c = srcCache.get(id); if (c) { c.bmp.close && c.bmp.close(); srcCache.delete(id); } }

export async function getPreviewSource(page) { return previewSource(page); }

/** Returns { out: ImageBitmap, base?: ImageBitmap } or null if superseded */
export async function renderPreview(page, { wantBase = false, override } = {}) {
  const g = (gen.get(page.id) || 0) + 1; gen.set(page.id, g);
  const bmp = await previewSource(page);
  const img = bitmapToImageData(bmp);
  const st = override ? Object.assign(editState(page), override) : editState(page);
  const res = await cvRun('process', { image: img, state: st, wantBase });
  if (gen.get(page.id) !== g) return null;
  const out = await createImageBitmap(res.image);
  const base = res.base ? await createImageBitmap(res.base) : null;
  return { out, base };
}

/** Full-resolution render; stores processed blob + thumbnail. */
export async function renderFull(page) {
  const rev = page.rev;
  const blob = await db.getBlob(page.origId);
  if (!blob) throw new Error('Original image missing');
  const bmp = await decode(blob, settings.maxProcessingPx || 4000);
  const img = bitmapToImageData(bmp); bmp.close && bmp.close();
  const res = await cvRun('process', { image: img, state: editState(page) });
  const out = res.image;
  const bin = isBinary(out);
  const mime = bin ? 'image/png' : 'image/jpeg';
  const pblob = await imageDataToBlob(out, mime, 0.92);
  const outBmp = await createImageBitmap(out);
  const tblob = await makeThumb(outBmp, 360); outBmp.close && outBmp.close();
  const live = pageById(page.id) || page;
  if (live.rev !== rev) return { blob: pblob, stale: true };
  await db.putBlob(blobIds.PROC(page.id), pblob);
  await db.putBlob(blobIds.THUMB(page.id), tblob);
  Object.assign(live, { procId: blobIds.PROC(page.id), procRev: rev, procW: out.width, procH: out.height, procMime: mime, thumbId: blobIds.THUMB(page.id) });
  if (live.ocr && live.ocr.rev !== rev) live.ocr.stale = true;
  await db.put('pages', live);
  bus.emit('page-rendered', live);
  if (state.pages[0] && state.pages[0].id === live.id) saveDoc().catch(() => {});
  return { blob: pblob, width: out.width, height: out.height };
}

const inflight = new Map();
/** Returns up-to-date processed blob (renders if needed). */
export async function ensureProcessed(page) {
  if (page.procId && page.procRev === page.rev) {
    const b = await db.getBlob(page.procId);
    if (b) return b;
  }
  if (inflight.has(page.id) && inflight.get(page.id).rev === page.rev) return (await inflight.get(page.id).p).blob;
  const p = renderFull(page);
  inflight.set(page.id, { rev: page.rev, p });
  try {
    const r = await p;
    if (r.stale) return ensureProcessed(pageById(page.id) || page);
    return r.blob;
  } finally { if (inflight.get(page.id)?.p === p) inflight.delete(page.id); }
}

export async function ensureThumb(page) {
  if (page.thumbId && page.procRev === page.rev) { const b = await db.getBlob(page.thumbId); if (b) return b; }
  await ensureProcessed(page);
  return db.getBlob(page.thumbId);
}

/* ---------- background renderer ---------- */
const queue = new Set();
let running = false;
const kick = debounce(() => runQueue(), 700);
export function scheduleRender(page) { queue.add(page.id); kick(); }

async function runQueue() {
  if (running) return; running = true;
  try {
    while (queue.size) {
      const id = queue.values().next().value; queue.delete(id);
      const p = pageById(id);
      if (!p || (p.procId && p.procRev === p.rev)) continue;
      bus.emit('page-status', id, 'busy');
      try { await ensureProcessed(p); } catch (e) { console.error('render failed', e); bus.emit('page-status', id, 'error', e.message); }
    }
  } finally { running = false; }
}

bus.on('page-changed', (page, o) => { if (!o || o.rerender !== false) scheduleRender(page); });
bus.on('pages-changed', (e) => { if (e && e.added) e.added.forEach((id) => { const p = pageById(id); if (p) scheduleRender(p); }); });
