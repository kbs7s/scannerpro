// Automatic document detection helpers (OpenCV worker + jscanify candidates)
import { cvRun } from './cv-client.js';
import { decode, bitmapToImageData, makeCanvas } from './image-io.js';
import { settings } from './settings.js';
import { h } from './util.js';
import { t } from './i18n.js';

export function detectOpts(extra = {}) {
  return {
    sensitivity: settings.detectSensitivity,
    edgeThreshold: settings.detectEdgeThreshold || 0,
    minArea: (settings.detectMinArea || 15) / 100,
    noise: settings.detectNoise,
    analyse: true,
    ...extra,
  };
}
export const minConfidence = () => (settings.detectMinConfidence || 60) / 100;

function scaled(bmp, maxSide) {
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = makeCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0, c.width, c.height);
  return x.getImageData(0, 0, c.width, c.height);
}

export async function detectBitmap(bmp, extra) {
  return cvRun('detect', { image: scaled(bmp, 1000), opts: detectOpts(extra) });
}

export async function detectBlob(blob, extra) {
  const bmp = await decode(blob, 1000);
  try { return await cvRun('detect', { image: bitmapToImageData(bmp), opts: detectOpts(extra) }); } finally { bmp.close && bmp.close(); }
}

export async function detectMultiBitmap(bmp) {
  return cvRun('detectMulti', { image: scaled(bmp, 1200), opts: detectOpts({ minConfidence: Math.max(0.45, minConfidence() - 0.1) }) });
}

export function paperLabel(type) { return t('paper.' + (type || 'document')); }

export function renderDetectInfo(box, det) {
  box.innerHTML = '';
  if (!det) { box.append(h('p', { class: 'muted' }, t('detect.none'))); return; }
  if (!det.found) { box.append(h('p', {}, h('span', { class: 'badge bad' }, t('detect.notFound'))), h('p', { class: 'hint' }, t('detect.notFoundHint'))); return; }
  const pct = Math.round(det.confidence * 100);
  const cls = pct >= 75 ? 'ok' : pct >= minConfidence() * 100 ? 'warn' : 'bad';
  const row = (k, v) => h('div', { class: 'row' }, h('span', { class: 'muted' }, k), h('span', {}, v));
  box.append(
    row(t('detect.confidence'), h('span', { class: 'badge ' + cls }, pct + '%')),
    row(t('detect.paperType'), '≈ ' + paperLabel(det.paper?.type) + ` (${det.paper?.ratio ?? '?'}:1)`),
    row(t('detect.orientation'), t('orient.' + (det.paper?.orientation || 'portrait'))),
  );
  if (det.paperColor) box.append(row(t('detect.paperColor'), t('paperColor.' + det.paperColor)));
  if (det.darkBackground != null) box.append(row(t('detect.background'), det.darkBackground ? t('detect.bgDark') : t('detect.bgLight')));
  if (det.unevenLighting) box.append(h('p', { class: 'hint' }, h('span', { class: 'badge warn' }, t('detect.uneven')), ' ', t('detect.unevenHint')));
  if (det.method) box.append(h('p', { class: 'hint' }, t('detect.method') + ': ' + det.method));
  if (det.paper?.type === 'a-series') box.append(h('p', { class: 'hint' }, t('detect.aSeriesNote')));
}
