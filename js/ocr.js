// Local OCR with Tesseract.js (WebAssembly) and locally hosted Arabic/English/French models.
import { libTesseract, normalizeText, bus } from './util.js';
import { t } from './i18n.js';
import * as db from './database.js';
import { blobIds, updatePage, saveDoc, pageById } from './project.js';
import { ensureProcessed } from './render.js';
import { decode, makeCanvas } from './image-io.js';
import { settings } from './settings.js';

export const OCR_LANGS = [
  { code: 'ara', file: 'models/ara.traineddata.gz' },
  { code: 'eng', file: 'models/eng.traineddata.gz' },
  { code: 'fra', file: 'models/fra.traineddata.gz' },
];
const abs = (p) => new URL(p, document.baseURI).href;

let worker = null; let workerKey = ''; let progressCb = null; let creating = null;

export async function langAvailability() {
  const out = {};
  for (const l of OCR_LANGS) {
    // the service worker cache is authoritative offline; otherwise ask the server
    let cached = false;
    try { cached = !!(await caches.match(abs(l.file))); } catch (_) { /* no Cache API */ }
    if (cached) { out[l.code] = true; continue; }
    if (!navigator.onLine) { out[l.code] = false; continue; }
    try { out[l.code] = (await fetch(l.file, { method: 'HEAD', cache: 'no-store' })).ok; } catch (_) { out[l.code] = false; }
  }
  return out;
}

async function getWorker(langs) {
  const key = langs.join('+');
  if (worker && workerKey === key) return worker;
  if (creating) { await creating.catch(() => {}); if (worker && workerKey === key) return worker; }
  if (worker) { try { await worker.terminate(); } catch (_) { /* */ } worker = null; }
  creating = (async () => {
    const T = await libTesseract();
    const w = await T.createWorker(langs, 1, {
      workerPath: abs('libs/tesseract/worker.min.js'),
      corePath: abs('libs/tesseract/core/'),
      langPath: abs('models'),
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: (m) => progressCb && progressCb(m),
      errorHandler: (e) => console.error('tesseract', e),
    });
    worker = w; workerKey = key;
    return w;
  })();
  try { return await creating; } finally { creating = null; }
}

export async function terminateOcr() { if (worker) { const w = worker; worker = null; workerKey = ''; try { await w.terminate(); } catch (_) { /* */ } } }

const MAXSIDE = { fast: 1700, balanced: 2600, best: 3600 };

/** Prepare a canvas for OCR at the chosen quality; returns { canvas, k } where k maps OCR px -> processed px */
async function prepare(blob, quality) {
  const bmp = await decode(blob);
  const max = MAXSIDE[quality] || MAXSIDE.balanced;
  let k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  if (quality === 'best' && Math.max(bmp.width, bmp.height) < 1800) k = 1.6; // upscale small scans for small text
  const w = Math.round(bmp.width * k), hh = Math.round(bmp.height * k);
  const c = makeCanvas(w, hh); const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh);
  x.drawImage(bmp, 0, 0, w, hh);
  const res = { canvas: c, k, w: bmp.width, h: bmp.height };
  bmp.close && bmp.close();
  if (!(c instanceof HTMLCanvasElement)) {
    // Tesseract.js accepts Blob/ImageData; convert OffscreenCanvas to a PNG blob
    res.input = await c.convertToBlob({ type: 'image/png' });
  } else res.input = c;
  return res;
}

/**
 * Run OCR on one page. Stores text, words (with confidence & boxes) and a text-only PDF layer.
 * @returns the ocr record
 */
export async function ocrPage(page, { langs = settings.ocrLangs, quality = settings.ocrQuality, psm = settings.ocrPsm, onProgress } = {}) {
  if (!langs || !langs.length) throw new Error(t('ocr.noLang'));
  progressCb = (m) => onProgress && onProgress(m);
  const rev = page.rev;
  const blob = await ensureProcessed(page);
  const prep = await prepare(blob, quality);
  const w = await getWorker(langs);
  await w.setParameters({ tessedit_pageseg_mode: String(psm || '3'), preserve_interword_spaces: '1', user_defined_dpi: '300' });
  const { data } = await w.recognize(prep.input, { pdfTitle: 'OCR', pdfTextOnly: true }, { text: true, blocks: true, pdf: true });
  progressCb = null;
  const inv = 1 / prep.k;
  const words = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const wd of l.words || []) {
    if (!wd.text || !wd.text.trim()) continue;
    words.push({ t: wd.text, n: normalizeText(wd.text), c: Math.round(wd.confidence), b: [wd.bbox.x0 * inv, wd.bbox.y0 * inv, wd.bbox.x1 * inv, wd.bbox.y1 * inv].map((v) => Math.round(v)) });
  }
  const text = cleanText(data.text || '');
  const live = pageById(page.id) || page;
  let pdfId = null;
  if (data.pdf && data.pdf.length) {
    pdfId = blobIds.OCRPDF(page.id);
    await db.putBlob(pdfId, new Blob([new Uint8Array(data.pdf)], { type: 'application/pdf' }));
  }
  const rec = { text, langs: [...langs], conf: Math.round(data.confidence || 0), words, w: prep.w, h: prep.h, pdfId, rev, at: Date.now(), edited: false, stale: live.rev !== rev, quality, psm };
  await updatePage(live, { ocr: rec }, { history: false, rerender: false });
  await saveDoc();
  bus.emit('ocr-done', live);
  return rec;
}

/** Normalise whitespace and common Arabic punctuation spacing in OCR output */
export function cleanText(s) {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([،؛؟.,:;!?])/g, '$1')
    .trim();
}

export async function saveEditedText(page, text) {
  if (!page.ocr) { await updatePage(page, { ocr: { text, langs: [], conf: 0, words: [], w: page.procW, h: page.procH, pdfId: null, rev: page.rev, at: Date.now(), edited: true } }, { history: false, rerender: false }); }
  else await updatePage(page, { ocr: { ...page.ocr, text, edited: true } }, { history: false, rerender: false });
  await saveDoc();
}

export function ocrStatus(page) {
  if (!page.ocr) return 'none';
  if (page.ocr.rev !== page.rev) return 'stale';
  return 'ok';
}
