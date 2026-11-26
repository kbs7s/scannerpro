// Camera scanning session: live edge detection, stability-based auto capture, timer, scan modes.
import { $, h, bus, sleep } from './util.js';
import { t } from './i18n.js';
import { Camera, CameraError, cameraSupported } from './camera.js';
import { cvTryLive, cvRun } from './cv-client.js';
import { detectOpts, minConfidence, detectBlob, paperLabel } from './detection.js';
import { decode, bitmapToImageData } from './image-io.js';
import { settings } from './settings.js';
import { toast } from './ui.js';

export const SCAN_MODES = [
  { id: 'document', preset: () => settings.defaultPreset || 'auto' },
  { id: 'book', preset: () => 'book' },
  { id: 'idcard', preset: () => 'idCard' },
  { id: 'passport', preset: () => 'idCard' },
  { id: 'receipt', preset: () => 'receipt' },
  { id: 'bizcard', preset: () => 'docColor' },
  { id: 'multi', preset: () => settings.defaultPreset || 'auto' },
];

let cam = null;
let session = null;

export function isScanning() { return !!session; }

/**
 * Opens the full-screen camera scanner.
 * onCapture(items, mode) is awaited for every capture; items = [{ blob, width, height, corners, detect, preset, source }]
 */
export async function openScanner({ onCapture, mode = 'document', single = false, onClose } = {}) {
  if (session) return;
  const root = $('#camera'), video = $('#cam-video'), overlay = $('#cam-overlay');
  root.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  cam = cam || new Camera(video);
  session = { mode, single, count: 0, running: true, last: null, history: [], capturing: false, onCapture, onClose, idSide: 0 };
  $('#cam-count').textContent = '0'; $('#cam-last').removeAttribute('src');
  $('#cam-auto').checked = !!settings.autoCapture;
  $('#cam-continuous').checked = single ? false : !!settings.continuous;
  $('#cam-continuous').disabled = single;
  $('#cam-timer').value = String(settings.timer || 0);
  $('#cam-res').value = settings.captureRes || '4k';
  renderModes();
  setStatus(t('cam.starting'));
  hideError();
  await startCamera();
  loop();
}

function renderModes() {
  const box = $('#cam-modes'); box.innerHTML = '';
  for (const m of SCAN_MODES) {
    box.append(h('button', { type: 'button', class: m.id === session.mode ? 'active' : '', onclick: () => { session.mode = m.id; session.idSide = 0; renderModes(); modeHint(); } }, t('mode.' + m.id)));
  }
}
function modeHint() {
  if (session.mode === 'idcard') setStatus(session.idSide === 0 ? t('cam.idFront') : t('cam.idBack'));
  else if (session.mode === 'book') setStatus(t('cam.bookHint'));
  else if (session.mode === 'multi') setStatus(t('cam.multiHint'));
}

async function startCamera(deviceId) {
  try {
    if (!cameraSupported()) throw new CameraError(window.isSecureContext ? 'unsupported' : 'insecure');
    await cam.start({ deviceId: deviceId ?? settings.cameraId ?? '', facing: cam.facing || 'environment', res: settings.captureRes });
    cam.onended = () => { if (session) showError(t('cam.err.ended'), true); };
    await fillDevices();
    renderCaps();
    const s = cam.settings();
    setStatus(t('cam.ready') + (s.width ? ` · ${s.width}×${s.height}` : ''));
    modeHint();
  } catch (e) {
    const code = e instanceof CameraError ? e.code : 'failed';
    showError(t('cam.err.' + code), code !== 'denied' && code !== 'insecure' && code !== 'unsupported');
  }
}

async function fillDevices() {
  const sel = $('#cam-device');
  const devs = await cam.listDevices();
  sel.innerHTML = '';
  const cur = cam.settings().deviceId;
  devs.forEach((d, i) => sel.append(h('option', { value: d.deviceId, selected: d.deviceId === cur }, d.label || `${t('cam.camera')} ${i + 1}`)));
  $('#cam-switch').hidden = devs.length < 2;
}

function renderCaps() {
  const box = $('#cam-caps'); box.innerHTML = '';
  const caps = cam.capabilities(); const st = cam.settings();
  $('#cam-torch').hidden = !caps.torch;
  $('#cam-torch').classList.toggle('on', !!cam.torch);
  const slider = (key, label, min, max, step, value, apply) => {
    const inp = h('input', { type: 'range', min, max, step, value });
    const out = h('output', {}, String(value));
    inp.addEventListener('input', async () => { out.value = (+inp.value).toFixed(step < 1 ? 1 : 0); try { await apply(+inp.value); } catch (_) { /* */ } });
    box.append(h('label', { class: 'sl' }, h('span', {}, label), inp, out));
  };
  if (caps.zoom && caps.zoom.max > caps.zoom.min) slider('zoom', t('cam.zoom'), caps.zoom.min, caps.zoom.max, caps.zoom.step || 0.1, st.zoom || caps.zoom.min, (v) => cam.apply({ zoom: v }));
  if (caps.focusMode && caps.focusMode.length) {
    const sel = h('select', {}, caps.focusMode.map((m) => h('option', { value: m, selected: st.focusMode === m }, t('cam.focus.' + m))));
    sel.addEventListener('change', () => cam.apply({ focusMode: sel.value }).catch(() => toast(t('cam.err.constraint'), 'warn')));
    box.append(h('label', { class: 'field' }, h('span', {}, t('cam.focusMode')), sel));
  }
  if (caps.focusDistance && caps.focusDistance.max > caps.focusDistance.min) slider('fd', t('cam.focusDistance'), caps.focusDistance.min, caps.focusDistance.max, caps.focusDistance.step || 0.01, st.focusDistance ?? caps.focusDistance.min, (v) => cam.apply({ focusMode: 'manual', focusDistance: v }));
  if (caps.exposureCompensation && caps.exposureCompensation.max > caps.exposureCompensation.min) slider('ev', t('cam.exposure'), caps.exposureCompensation.min, caps.exposureCompensation.max, caps.exposureCompensation.step || 0.1, st.exposureCompensation ?? 0, (v) => cam.apply({ exposureCompensation: v }));
  if (!box.children.length) box.append(h('p', { class: 'hint' }, t('cam.noCaps')));
}

function setStatus(text, conf) {
  const el = $('#cam-status'); el.innerHTML = '';
  el.append(text);
  if (conf != null) {
    const pct = Math.round(conf * 100);
    const bar = h('span', { class: 'conf' }, h('i'));
    bar.style.setProperty('--c', pct + '%');
    bar.style.setProperty('--cc', conf >= minConfidence() ? '#2fbf71' : conf >= 0.4 ? '#f2a93b' : '#ef5a5a');
    el.append(bar);
  }
}
function showError(msg, retry) {
  const box = $('#cam-error'); box.innerHTML = '';
  box.append(h('p', {}, msg));
  const btns = h('div', { class: 'row-btns', style: { justifyContent: 'center' } });
  if (retry) btns.append(h('button', { class: 'btn primary', onclick: () => { hideError(); startCamera(); } }, t('act.retry')));
  btns.append(h('button', { class: 'btn', onclick: () => { $('#file-capture').click(); } }, t('cam.useFileCapture')));
  btns.append(h('button', { class: 'btn ghost', onclick: closeScanner }, t('act.close')));
  box.append(btns);
  box.classList.remove('hidden');
}
function hideError() { $('#cam-error').classList.add('hidden'); }

/* ---------- live detection loop ---------- */
async function loop() {
  let lastRun = 0;
  const tick = async (now) => {
    if (!session || !session.running) return;
    requestAnimationFrame(tick);
    const interval = settings.detectInterval || 250;
    if (now - lastRun < interval || session.capturing || !cam.active) return;
    lastRun = now;
    const fr = cam.frame(480);
    if (!fr) return;
    const p = cvTryLive('detect', { image: fr, opts: detectOpts({ analyse: false, maxSide: 480 }) });
    if (!p) return;
    try {
      const r = await p;
      if (!session) return;
      onDetection(r);
    } catch (_) { /* skip frame */ }
  };
  requestAnimationFrame(tick);
}

function videoRect() {
  const v = $('#cam-video'); const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
  const k = Math.min(r.width / vw, r.height / vh);
  return { x: (r.width - vw * k) / 2, y: (r.height - vh * k) / 2, w: vw * k, h: vh * k, cw: r.width, ch: r.height };
}

function drawOverlay(r) {
  const c = $('#cam-overlay'); const dpr = window.devicePixelRatio || 1;
  const vr = videoRect();
  if (c.width !== Math.round(vr.cw * dpr)) { c.width = Math.round(vr.cw * dpr); c.height = Math.round(vr.ch * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, vr.cw, vr.ch);
  if (!r || !r.found) return;
  const ok = r.confidence >= minConfidence();
  const pts = r.corners.map((p) => ({ x: vr.x + p.x * vr.w, y: vr.y + p.y * vr.h }));
  x.fillStyle = ok ? 'rgba(47,191,113,.18)' : 'rgba(242,169,59,.14)';
  x.strokeStyle = ok ? '#2fbf71' : '#f2a93b'; x.lineWidth = 3; x.lineJoin = 'round';
  x.beginPath(); pts.forEach((p, i) => (i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y))); x.closePath(); x.fill(); x.stroke();
  for (const p of pts) { x.beginPath(); x.arc(p.x, p.y, 9, 0, Math.PI * 2); x.fillStyle = '#fff'; x.fill(); x.stroke(); }
}

function onDetection(r) {
  drawOverlay(r);
  const s = session;
  if (!r.found) { s.history = []; setStatus(t('cam.searching'), 0); return; }
  setStatus((r.confidence >= minConfidence() ? t('cam.detected') : t('cam.lowConf')) + ' · ' + paperLabel(r.paper?.type), r.confidence);
  s.last = r;
  const now = performance.now();
  s.history.push({ r, t: now });
  s.history = s.history.filter((x) => now - x.t < 2500);
  if (!$('#cam-auto').checked || s.capturing) return;
  const good = s.history.filter((x) => x.r.confidence >= minConfidence());
  if (good.length < 4) return;
  const span = now - good[0].t;
  if (span < 1100) return;
  // stable: corners moved less than 2% between consecutive good detections
  let stable = true;
  for (let i = 1; i < good.length; i++) {
    const a = good[i - 1].r.corners, b = good[i].r.corners;
    if (a.some((p, j) => Math.hypot(p.x - b[j].x, p.y - b[j].y) > 0.02)) { stable = false; break; }
  }
  if (stable) { s.history = []; doCapture(true); }
}

/* ---------- capture ---------- */
async function countdown(sec) {
  const el = $('#cam-countdown'); el.classList.remove('hidden');
  for (let i = sec; i > 0; i--) { if (!session) break; el.textContent = i; await sleep(1000); }
  el.classList.add('hidden');
}

async function doCapture(auto = false) {
  const s = session; if (!s || s.capturing || !cam.active) return;
  s.capturing = true;
  try {
    const timer = auto ? 0 : +$('#cam-timer').value;
    if (timer) await countdown(timer);
    if (!session) return;
    const flash = $('#cam-flash'); flash.classList.add('on'); setTimeout(() => flash.classList.remove('on'), 60);
    if (navigator.vibrate) try { navigator.vibrate(30); } catch (_) { /* */ }
    setStatus(t('cam.processing'));
    const blob = await cam.capture();
    const items = await buildItems(blob, s.mode);
    s.count += items.length;
    $('#cam-count').textContent = String(s.count);
    const url = URL.createObjectURL(blob); const img = $('#cam-last');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.src = url; img.dataset.url = url;
    await s.onCapture(items, s.mode);
    if (s.mode === 'idcard') { s.idSide++; if (s.idSide >= 2) { s.idSide = 0; bus.emit('idcard-pair'); } }
    if (s.single || !$('#cam-continuous').checked) { closeScanner(); return; }
    modeHint();
    if (!['idcard', 'book', 'multi'].includes(s.mode)) setStatus(t('cam.captured', { n: s.count }));
  } catch (e) {
    toast(t('cam.err.capture') + ': ' + e.message, 'bad');
  } finally {
    if (session) { await sleep(auto ? 1500 : 300); if (session) session.capturing = false; }
  }
}

/** Turns a captured blob into page items according to the scan mode. Exported for gallery/file-capture use. */
export async function buildItems(blob, mode = 'document') {
  const m = SCAN_MODES.find((x) => x.id === mode) || SCAN_MODES[0];
  const bmp = await decode(blob);
  const width = bmp.width, height = bmp.height;
  const preset = m.preset();
  try {
    if (mode === 'multi') {
      const k = Math.min(1, 1200 / Math.max(width, height));
      const small = await decode(blob, Math.round(Math.max(width, height) * k));
      const r = await cvRun('detectMulti', { image: bitmapToImageData(small), opts: detectOpts({ minConfidence: Math.max(0.45, minConfidence() - 0.1) }) });
      small.close && small.close();
      if (r.docs.length) return r.docs.map((d) => ({ blob, width, height, corners: d.corners, detect: { found: true, ...d }, preset, source: 'camera' }));
    }
    const det = await detectBlob(blob);
    const corners = det.found && det.confidence >= minConfidence() ? det.corners : null;
    if (mode === 'book' && corners) {
      // split a two-page spread into left/right pages at the detected gutter
      const small = await decode(blob, 1400);
      const g = await cvRun('findGutter', { image: bitmapToImageData(small), state: { corners } });
      small.close && small.close();
      const f = g.fraction;
      const [tl, tr, br, bl] = corners;
      const top = { x: tl.x + (tr.x - tl.x) * f, y: tl.y + (tr.y - tl.y) * f };
      const bot = { x: bl.x + (br.x - bl.x) * f, y: bl.y + (br.y - bl.y) * f };
      const left = [tl, top, bot, bl], right = [top, tr, br, bot];
      // in RTL books (Arabic) the right page comes first
      const order = document.documentElement.lang === 'ar' ? [right, left] : [left, right];
      return order.map((c) => ({ blob, width, height, corners: c, detect: det, preset, source: 'camera' }));
    }
    return [{ blob, width, height, corners, detect: det, preset, source: 'camera' }];
  } finally { bmp.close && bmp.close(); }
}

export function closeScanner() {
  if (!session) return;
  const s = session; session = null;
  if (cam) cam.stop();
  $('#camera').classList.add('hidden');
  $('#cam-panel').classList.add('hidden');
  $('#cam-countdown').classList.add('hidden');
  document.body.style.overflow = '';
  const c = $('#cam-overlay'); c.getContext('2d').clearRect(0, 0, c.width, c.height);
  if (s.onClose) s.onClose(s.count);
}

export function initScannerUI() {
  $('#cam-close').onclick = closeScanner;
  $('#cam-done').onclick = closeScanner;
  $('#cam-shutter').onclick = () => doCapture(false);
  $('#cam-settings-btn').onclick = () => $('#cam-panel').classList.toggle('hidden');
  $('#cam-gallery').onclick = () => $('#file-any').click();
  $('#cam-torch').onclick = async () => { try { const on = await cam.setTorch(!cam.torch); $('#cam-torch').classList.toggle('on', on); } catch (_) { toast(t('cam.err.notorch'), 'warn'); } };
  $('#cam-switch').onclick = async () => {
    const devs = await cam.listDevices();
    if (devs.length < 2) return;
    const cur = cam.settings().deviceId;
    const i = devs.findIndex((d) => d.deviceId === cur);
    const next = devs[(i + 1) % devs.length];
    settings.cameraId = next.deviceId;
    await startCamera(next.deviceId);
  };
  $('#cam-device').onchange = (e) => { settings.cameraId = e.target.value; startCamera(e.target.value); };
  $('#cam-res').onchange = (e) => { settings.captureRes = e.target.value; startCamera(); };
  $('#cam-auto').onchange = (e) => { settings.autoCapture = e.target.checked; $('#cam-shutter').classList.toggle('auto', e.target.checked); };
  $('#cam-continuous').onchange = (e) => { settings.continuous = e.target.checked; };
  $('#cam-timer').onchange = (e) => { settings.timer = +e.target.value; };
  document.addEventListener('visibilitychange', () => {
    if (!session) return;
    if (document.hidden) { cam.stop(); session.paused = true; }
    else if (session.paused) { session.paused = false; startCamera(); }
  });
  window.addEventListener('orientationchange', () => setTimeout(() => drawOverlay(session?.last), 300));
  document.addEventListener('keydown', (e) => {
    if (!session) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); doCapture(false); }
    if (e.key === 'Escape') closeScanner();
  });
}
