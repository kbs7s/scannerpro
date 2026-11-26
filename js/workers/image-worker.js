/* Ultimate Smart Scanner Pro — image processing worker.
 * Runs OpenCV.js (WebAssembly) off the main thread: document detection,
 * perspective warp, geometric correction, enhancement, background cleaning, deskew.
 * Every operation modifies real pixels. All cv.Mat objects are freed per call.
 */
/* global cv, jscanify */
'use strict';

let cvReady = null;
let scanner = null;

function loadCV() {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    try {
      importScripts('../../libs/opencv/opencv.js');
    } catch (e) { reject(new Error('OpenCV.js failed to load: ' + e.message)); return; }
    const m = self.cv;
    const done = (mod) => {
      if (mod && typeof mod.then === 'function') { try { delete mod.then; } catch (_) { /* ignore */ } }
      self.cv = mod;
      try { importScripts('../../libs/jscanify/jscanify.js'); scanner = new self.jscanify(); } catch (e) { scanner = null; }
      resolve({ version: (mod.getBuildInformation ? (mod.getBuildInformation().match(/Version control:\s*(\S+)/) || [])[1] : '') || '4.x', jscanify: !!scanner });
    };
    if (m && typeof m.then === 'function') {
      m.then((mod) => done(mod));
    } else if (m && m.Mat) {
      done(m);
    } else if (m) {
      m.onRuntimeInitialized = () => done(m);
    } else reject(new Error('OpenCV.js global missing'));
    setTimeout(() => reject(new Error('OpenCV.js initialisation timed out')), 120000);
  });
  return cvReady;
}

/* ---------- Mat lifetime helpers ---------- */
class Scope {
  constructor() { this.items = []; }
  t(m) { this.items.push(m); return m; }
  mat() { return this.t(new cv.Mat()); }
  free() { for (const m of this.items) { try { if (m && !m.isDeleted()) m.delete(); } catch (_) { try { m.delete(); } catch (__) { /* */ } } } this.items = []; }
}

function toImageData(mat) {
  // mat is 8UC1/8UC3/8UC4
  const s = new Scope();
  try {
    let rgba = mat;
    if (mat.type() === cv.CV_8UC1) { rgba = s.mat(); cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA); }
    else if (mat.type() === cv.CV_8UC3) { rgba = s.mat(); cv.cvtColor(mat, rgba, cv.COLOR_RGB2RGBA); }
    return new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
  } finally { s.free(); }
}

function fromImageData(img, s) {
  const rgba = s.t(cv.matFromImageData(img));
  const rgb = s.mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  return rgb;
}

function resizeMax(src, maxSide, s) {
  const k = Math.min(1, maxSide / Math.max(src.cols, src.rows));
  if (k >= 1) return { mat: src, k: 1 };
  const dst = s.mat();
  cv.resize(src, dst, new cv.Size(Math.max(1, Math.round(src.cols * k)), Math.max(1, Math.round(src.rows * k))), 0, 0, cv.INTER_AREA);
  return { mat: dst, k };
}

const odd = (n) => { n = Math.max(1, Math.round(n)); return n % 2 ? n : n + 1; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ---------- Geometry helpers ---------- */
function orderCorners(pts) {
  const cx = pts.reduce((a, p) => a + p.x, 0) / 4;
  const cy = pts.reduce((a, p) => a + p.y, 0) / 4;
  const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // sorted clockwise starting from smallest angle (-PI). find top-left = min x+y
  let start = 0; let best = Infinity;
  sorted.forEach((p, i) => { if (p.x + p.y < best) { best = p.x + p.y; start = i; } });
  const o = [];
  for (let i = 0; i < 4; i++) o.push(sorted[(start + i) % 4]);
  return o; // tl, tr, br, bl (clockwise in image coords)
}

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const j = (i + 1) % p.length; a += p[i].x * p[j].y - p[j].x * p[i].y; }
  return Math.abs(a) / 2;
}

function interiorAngles(p) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const a = p[(i + 3) % 4], b = p[i], c = p[(i + 1) % 4];
    const v1 = { x: a.x - b.x, y: a.y - b.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y) + 1e-9);
    out.push(Math.acos(clamp(cos, -1, 1)) * 180 / Math.PI);
  }
  return out;
}

function matToPoints(m) {
  const pts = [];
  const d = m.data32S;
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

/* ---------- Detection ---------- */
function median8(gray) {
  const h = new Uint32Array(256); const d = gray.data;
  for (let i = 0; i < d.length; i++) h[d[i]]++;
  let acc = 0; const half = d.length / 2;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= half) return i; }
  return 128;
}

function quadsFromBinary(bin, minArea, tag, s, out, mode) {
  const contours = s.t(new cv.MatVector());
  const hier = s.mat();
  cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
  const list = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const a = cv.contourArea(c);
    if (a >= minArea) list.push({ c, a }); else c.delete();
  }
  list.sort((x, y) => y.a - x.a);
  list.slice(0, 10).forEach(({ c, a }) => {
    const peri = cv.arcLength(c, true);
    let quad = null;
    for (const eps of [0.015, 0.02, 0.03, 0.045, 0.06]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(c, approx, eps * peri, true);
      if (approx.rows === 4 && cv.isContourConvex(approx)) { quad = matToPoints(approx); approx.delete(); break; }
      approx.delete();
    }
    if (!quad) {
      // fall back to hull approximation for slightly rounded/torn corners
      const hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const hp = cv.arcLength(hull, true);
      for (const eps of [0.02, 0.04, 0.06]) {
        const approx = new cv.Mat();
        cv.approxPolyDP(hull, approx, eps * hp, true);
        if (approx.rows === 4) { quad = matToPoints(approx); approx.delete(); break; }
        approx.delete();
      }
      hull.delete();
    }
    if (quad) out.push({ pts: orderCorners(quad), contourArea: a, tag });
  });
  list.forEach(({ c }) => c.delete());
}

function edgeSupport(edges, q) {
  // fraction of samples along quad sides that lie near an edge pixel
  const w = edges.cols, h = edges.rows, d = edges.data;
  let hit = 0, tot = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const n = Math.max(8, Math.round(dist(a, b) / 4));
    for (let k = 1; k < n; k++) {
      const x = Math.round(a.x + (b.x - a.x) * k / n), y = Math.round(a.y + (b.y - a.y) * k / n);
      tot++;
      let found = false;
      for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2 && !found; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && d[yy * w + xx]) found = true;
      }
      if (found) hit++;
    }
  }
  return tot ? hit / tot : 0;
}

function scoreQuad(cand, edges, W, H) {
  const q = cand.pts;
  const area = polyArea(q);
  const ar = area / (W * H);
  const diag = Math.hypot(W, H);
  for (let i = 0; i < 4; i++) if (dist(q[i], q[(i + 1) % 4]) < diag * 0.08) return 0;
  const angs = interiorAngles(q);
  if (angs.some((a) => a < 40 || a > 140)) return 0;
  const angleScore = 1 - angs.reduce((s, a) => s + Math.abs(a - 90), 0) / 4 / 50;
  const support = edgeSupport(edges, q);
  const solidity = cand.contourArea ? clamp(cand.contourArea / area, 0, 1) : 0.9;
  // a quad that hugs the whole frame is usually the image border, not paper
  const borderHug = q.filter((p) => p.x < 3 || p.y < 3 || p.x > W - 4 || p.y > H - 4).length;
  let sc = 0.42 * support + 0.25 * clamp(angleScore, 0, 1) + 0.18 * clamp(ar / 0.45, 0, 1) + 0.15 * solidity;
  if (borderHug >= 3) sc *= 0.55;
  if (ar > 0.97) sc *= 0.6;
  return clamp(sc, 0, 1);
}

function classifyPaper(q) {
  const w = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const h = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  const r = Math.max(w, h) / Math.max(1, Math.min(w, h));
  const types = [
    { id: 'a-series', r: Math.SQRT2 }, { id: 'letter', r: 11 / 8.5 }, { id: 'legal', r: 14 / 8.5 },
    { id: 'idcard', r: 85.6 / 53.98 }, { id: 'bizcard', r: 3.5 / 2 }, { id: 'passport', r: 125 / 88 },
  ];
  let best = null; let bd = Infinity;
  for (const t of types) { const d = Math.abs(t.r - r); if (d < bd) { bd = d; best = t; } }
  let type = 'document';
  if (r >= 2.1) type = 'receipt';
  else if (best && bd < 0.045) type = best.id === 'passport' ? 'a-series' : best.id;
  return { type, ratio: +r.toFixed(3), orientation: w >= h ? 'landscape' : 'portrait', w: Math.round(w), h: Math.round(h) };
}

function analyseRegion(rgb, q, s) {
  // colour / lighting analysis inside and outside the quad
  const mask = s.t(cv.Mat.zeros(rgb.rows, rgb.cols, cv.CV_8UC1));
  const pts = s.t(cv.matFromArray(4, 1, cv.CV_32SC2, q.flatMap((p) => [Math.round(p.x), Math.round(p.y)])));
  const mv = s.t(new cv.MatVector()); mv.push_back(pts);
  cv.fillPoly(mask, mv, new cv.Scalar(255));
  const inv = s.mat(); cv.bitwise_not(mask, inv);
  const hsv = s.mat(); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const mIn = cv.mean(hsv, mask), mOut = cv.mean(hsv, inv);
  const gray = s.mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const blur = s.mat(); cv.GaussianBlur(gray, blur, new cv.Size(31, 31), 0);
  const mean = s.mat(), sd = s.mat();
  cv.meanStdDev(blur, mean, sd, mask);
  const lightStd = sd.data64F[0];
  return {
    paperColor: mIn[1] > 55 ? 'colored' : (mIn[2] > 150 ? 'white' : 'gray'),
    darkBackground: mOut[2] < 95,
    unevenLighting: lightStd > 22,
    lightingStd: +lightStd.toFixed(1),
  };
}

function detectCandidates(img, opts, s) {
  const sens = clamp(opts.sensitivity ?? 50, 0, 100);
  const noise = clamp(opts.noise ?? 30, 0, 100);
  const minAreaFrac = clamp(opts.minArea ?? 0.15, 0.01, 0.9);
  const rgbFull = fromImageData(img, s);
  const { mat: rgb, k } = resizeMax(rgbFull, opts.maxSide || 720, s);
  const W = rgb.cols, H = rgb.rows, minArea = minAreaFrac * W * H;
  const gray = s.mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const blur = s.mat(); const bk = odd(3 + noise / 14);
  cv.GaussianBlur(gray, blur, new cv.Size(bk, bk), 0);
  const cands = [];
  const kernel3 = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));

  // A: adaptive Canny
  const med = median8(blur);
  const f = 1.6 - sens / 100;
  let lo = clamp(med * 0.45 * f, 8, 160);
  if (opts.edgeThreshold) lo = clamp(opts.edgeThreshold, 5, 250);
  const hi = clamp(lo * 2.6, 25, 255);
  const edges = s.mat(); cv.Canny(blur, edges, lo, hi);
  const edgesD = s.mat(); cv.dilate(edges, edgesD, kernel3, new cv.Point(-1, -1), 2);
  quadsFromBinary(edgesD, minArea, 'canny', s, cands, cv.RETR_LIST);

  // B: Otsu brightness segmentation (bright paper on darker background)
  const th = s.mat(); cv.threshold(blur, th, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
  const k9 = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)));
  const thc = s.mat(); cv.morphologyEx(th, thc, cv.MORPH_CLOSE, k9);
  quadsFromBinary(thc, minArea, 'otsu', s, cands, cv.RETR_EXTERNAL);

  // C: colour gradients (coloured paper on similarly bright background)
  const lab = s.mat(); cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
  const ch = s.t(new cv.MatVector()); cv.split(lab, ch);
  const combo = s.t(cv.Mat.zeros(H, W, cv.CV_8UC1));
  for (let i = 1; i < 3; i++) {
    const c = ch.get(i); const cb = new cv.Mat(); const ce = new cv.Mat();
    cv.GaussianBlur(c, cb, new cv.Size(5, 5), 0); cv.Canny(cb, ce, 12, 36);
    cv.bitwise_or(combo, ce, combo); c.delete(); cb.delete(); ce.delete();
  }
  const comboD = s.mat(); cv.dilate(combo, comboD, kernel3, new cv.Point(-1, -1), 2);
  quadsFromBinary(comboD, minArea, 'color', s, cands, cv.RETR_LIST);

  // D: jscanify
  if (scanner) {
    try {
      const rgba = s.mat(); cv.cvtColor(rgb, rgba, cv.COLOR_RGB2RGBA);
      const cnt = scanner.findPaperContour(rgba);
      if (cnt) {
        const a = cv.contourArea(cnt);
        const cp = scanner.getCornerPoints(cnt);
        cnt.delete();
        const p = [cp.topLeftCorner, cp.topRightCorner, cp.bottomRightCorner, cp.bottomLeftCorner];
        if (a >= minArea && p.every((x) => x && isFinite(x.x))) cands.push({ pts: orderCorners(p.map((x) => ({ x: x.x, y: x.y }))), contourArea: a, tag: 'jscanify' });
      }
    } catch (_) { /* jscanify failed on this frame */ }
  }

  const allEdges = s.mat(); cv.bitwise_or(edges, combo, allEdges);
  const allEdgesD = s.mat(); cv.dilate(allEdges, allEdgesD, kernel3);
  for (const c of cands) c.score = scoreQuad(c, allEdgesD, W, H);
  // agreement bonus
  const diag = Math.hypot(W, H);
  for (const c of cands) {
    if (!c.score) continue;
    const agree = cands.filter((o) => o !== c && o.tag !== c.tag && o.score > 0 && c.pts.every((p, i) => dist(p, o.pts[i]) < diag * 0.03)).length;
    c.agree = agree; c.conf = clamp(c.score + Math.min(agree, 2) * 0.07, 0, 1);
  }
  const valid = cands.filter((c) => c.score > 0).sort((a, b) => b.conf - a.conf);
  return { valid, rgb, W, H, k, scaleBack: 1 / k };
}

function detect({ image, opts = {} }) {
  const s = new Scope();
  try {
    const { valid, rgb, W, H } = detectCandidates(image, opts, s);
    if (!valid.length) return { found: false, confidence: 0 };
    const best = valid[0];
    const norm = best.pts.map((p) => ({ x: clamp(p.x / W, 0, 1), y: clamp(p.y / H, 0, 1) }));
    const res = { found: true, corners: norm, confidence: +best.conf.toFixed(3), method: best.tag, paper: classifyPaper(best.pts.map((p) => ({ x: p.x / W * image.width, y: p.y / H * image.height }))) };
    if (opts.analyse) Object.assign(res, analyseRegion(rgb, best.pts, s));
    return res;
  } finally { s.free(); }
}

function detectMulti({ image, opts = {} }) {
  const s = new Scope();
  try {
    const o = Object.assign({ minArea: 0.02 }, opts, { minArea: Math.min(opts.minArea ?? 0.02, 0.05) });
    const { valid, W, H } = detectCandidates(image, o, s);
    const picked = [];
    const bbox = (q) => { const xs = q.map((p) => p.x), ys = q.map((p) => p.y); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
    const overlap = (a, b) => {
      const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
      const inter = ix * iy; const ua = (a.x1 - a.x0) * (a.y1 - a.y0), ub = (b.x1 - b.x0) * (b.y1 - b.y0);
      return inter / Math.min(ua, ub);
    };
    for (const c of valid) {
      if (c.conf < (opts.minConfidence ?? 0.5)) continue;
      const b = bbox(c.pts);
      if (picked.some((p) => overlap(bbox(p.pts), b) > 0.15)) continue;
      picked.push(c);
      if (picked.length >= 8) break;
    }
    return { docs: picked.map((c) => ({ corners: c.pts.map((p) => ({ x: p.x / W, y: p.y / H })), confidence: +c.conf.toFixed(3), paper: classifyPaper(c.pts) })) };
  } finally { s.free(); }
}

/* ---------- Geometry pipeline ---------- */
function warpQuad(src, cornersNorm, s) {
  const W = src.cols, H = src.rows;
  const q = cornersNorm.map((p) => ({ x: p.x * W, y: p.y * H }));
  const w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
  const h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
  const ow = Math.max(8, Math.round(w)), oh = Math.max(8, Math.round(h));
  const from = s.t(cv.matFromArray(4, 1, cv.CV_32FC2, q.flatMap((p) => [p.x, p.y])));
  const to = s.t(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow - 1, 0, ow - 1, oh - 1, 0, oh - 1]));
  const M = s.t(cv.getPerspectiveTransform(from, to));
  const dst = s.mat();
  cv.warpPerspective(src, dst, M, new cv.Size(ow, oh), cv.INTER_CUBIC, cv.BORDER_REPLICATE, new cv.Scalar());
  return dst;
}

function rotate90(src, deg, s) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return src;
  const dst = s.mat();
  if (deg === 180) { cv.flip(src, dst, -1); return dst; }
  const t = s.mat(); cv.transpose(src, t);
  cv.flip(t, dst, deg === 90 ? 1 : 0);
  return dst;
}

function rotateFine(src, angle, s, fill = 255) {
  if (!angle || Math.abs(angle) < 0.01) return src;
  const W = src.cols, H = src.rows;
  const rad = Math.abs(angle) * Math.PI / 180;
  const nw = Math.round(W * Math.cos(rad) + H * Math.sin(rad)), nh = Math.round(W * Math.sin(rad) + H * Math.cos(rad));
  const M = s.t(cv.getRotationMatrix2D(new cv.Point(W / 2, H / 2), angle, 1));
  M.doublePtr(0, 2)[0] += (nw - W) / 2; M.doublePtr(1, 2)[0] += (nh - H) / 2;
  const dst = s.mat();
  const sc = src.channels() === 1 ? new cv.Scalar(fill) : new cv.Scalar(fill, fill, fill, 255);
  cv.warpAffine(src, dst, M, new cv.Size(nw, nh), cv.INTER_CUBIC, cv.BORDER_CONSTANT, sc);
  return dst;
}

function applyGeometry(rgb, st, s) {
  let m = rgb;
  if (st.corners && st.corners.length === 4) m = warpQuad(m, st.corners, s);
  m = rotate90(m, st.rotation || 0, s);
  if (st.angle) m = rotateFine(m, st.angle, s, st.fillBlack ? 0 : 255);
  if (st.flipH && st.flipV) { const d = s.mat(); cv.flip(m, d, -1); m = d; }
  else if (st.flipH) { const d = s.mat(); cv.flip(m, d, 1); m = d; }
  else if (st.flipV) { const d = s.mat(); cv.flip(m, d, 0); m = d; }
  const p = st.params || {};
  if (p.removeBorder > 0) {
    const bx = Math.round(m.cols * p.removeBorder / 100), by = Math.round(m.rows * p.removeBorder / 100);
    if (m.cols - 2 * bx > 8 && m.rows - 2 * by > 8) m = s.t(m.roi(new cv.Rect(bx, by, m.cols - 2 * bx, m.rows - 2 * by)));
  }
  if (p.resizePct && p.resizePct > 0 && p.resizePct < 100) {
    const d = s.mat(); const k = p.resizePct / 100;
    cv.resize(m, d, new cv.Size(Math.max(1, Math.round(m.cols * k)), Math.max(1, Math.round(m.rows * k))), 0, 0, cv.INTER_AREA); m = d;
  }
  return m;
}

/* ---------- Enhancement ---------- */
function backgroundNormalize(m, strength, s) {
  // Shadow / illumination removal: estimate the paper background per channel
  // (dilate removes text, median blur smooths), then divide.
  if (strength <= 0) return m;
  const { mat: small } = resizeMax(m, 640, s);
  const ksz = Math.max(5, Math.round(Math.max(small.cols, small.rows) / 90));
  const kernel = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(odd(ksz), odd(ksz))));
  const dil = s.mat(); cv.dilate(small, dil, kernel);
  const bgS = s.mat(); cv.medianBlur(dil, bgS, Math.min(99, odd(Math.max(15, Math.round(Math.max(small.cols, small.rows) / 25)))));
  const bgBlur = s.mat(); cv.GaussianBlur(bgS, bgBlur, new cv.Size(odd(ksz * 2), odd(ksz * 2)), 0);
  const bg = s.mat(); cv.resize(bgBlur, bg, new cv.Size(m.cols, m.rows), 0, 0, cv.INTER_LINEAR);
  const norm = s.mat(); cv.divide(m, bg, norm, 255);
  if (strength >= 1) return norm;
  const out = s.mat(); cv.addWeighted(m, 1 - strength, norm, strength, 0, out);
  return out;
}

function buildLUTs(p, stats) {
  const L = [new Uint8Array(256), new Uint8Array(256), new Uint8Array(256)];
  const ev = Math.pow(2, p.exposure || 0);
  const br = (p.brightness || 0) * 1.28;
  const c = clamp((p.contrast || 0) * 1.28, -127, 127);
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const g = p.gamma && p.gamma > 0 ? p.gamma : 1;
  const hl = (p.highlights || 0) / 100, sh = (p.shadows || 0) / 100;
  const temp = (p.temperature || 0) / 100, tint = (p.tint || 0) / 100;
  const gains = [1 + temp * 0.18, 1 - tint * 0.15, 1 - temp * 0.18];
  let black = 0, white = 255;
  if (stats && p.autoLevels) { black = stats.lo; white = stats.hi; }
  const tp = (p.textPreserve || 0) / 100; // darkens text strokes (raises black point)
  const wh = (p.whiten || 0) / 100; // pushes paper to pure white (lowers white point)
  for (let ch = 0; ch < 3; ch++) {
    for (let v = 0; v < 256; v++) {
      let x = v;
      x = (x - black) / Math.max(1, white - black) * 255; // auto levels
      x *= ev;
      x = x * gains[ch];
      x += br;
      x = cf * (x - 128) + 128;
      let n = clamp(x / 255, 0, 1);
      if (hl) n = n > 0.5 ? n + hl * (n - 0.5) * (1 - n) * 1.6 : n;
      if (sh) n = n < 0.5 ? n + sh * (0.5 - n) * n * 1.6 : n;
      n = Math.pow(clamp(n, 0, 1), 1 / g);
      x = n * 255;
      L[ch][v] = clamp(Math.round(x), 0, 255);
    }
  }
  if (tp || wh) {
    // clean, well-defined levels for the cleaning controls (applied after tone curve)
    const lv = new Uint8Array(256);
    const bp = tp * 70, wp = Math.max(bp + 20, 255 - wh * 95);
    for (let v = 0; v < 256; v++) lv[v] = clamp(Math.round((v - bp) / (wp - bp) * 255), 0, 255);
    for (let ch = 0; ch < 3; ch++) {
      // rebuild channel LUT without the inline approximation, then compose with levels
      for (let v = 0; v < 256; v++) L[ch][v] = lv[toneOnly(v, ch)];
    }
  }
  return L;

  function toneOnly(v, ch) {
    let x = (v - black) / Math.max(1, white - black) * 255;
    x *= ev; x *= gains[ch]; x += br; x = cf * (x - 128) + 128;
    let n = clamp(x / 255, 0, 1);
    if (hl) n = n > 0.5 ? n + hl * (n - 0.5) * (1 - n) * 1.6 : n;
    if (sh) n = n < 0.5 ? n + sh * (0.5 - n) * n * 1.6 : n;
    n = Math.pow(clamp(n, 0, 1), 1 / g);
    return clamp(Math.round(n * 255), 0, 255);
  }
}

function lumaStats(m) {
  const d = m.data; const h = new Uint32Array(256); const step = Math.max(1, Math.floor(d.length / 3 / 400000)) * 3;
  let n = 0;
  for (let i = 0; i < d.length; i += step) { h[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; n++; }
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) { acc += h[i]; if (acc >= n * 0.005) { lo = i; break; } }
  acc = 0;
  for (let i = 255; i >= 0; i--) { acc += h[i]; if (acc >= n * 0.005) { hi = i; break; } }
  if (hi - lo < 30) { lo = 0; hi = 255; }
  return { lo, hi };
}

function applyTone(m, p) {
  const needLUT = p.autoLevels || p.exposure || p.brightness || p.contrast || (p.gamma && p.gamma !== 1) || p.highlights || p.shadows || p.temperature || p.tint || p.textPreserve || p.whiten;
  const sat = (p.saturation || 0) / 100;
  const cbr = (p.colorBgReduce || 0) / 100;
  const paper = p.paperColor && p.paperColor !== 'none' && p.paperColor !== 'white' ? PAPER[p.paperColor] : null;
  if (!needLUT && !sat && !cbr && !paper) return;
  const L = needLUT ? buildLUTs(p, p.autoLevels ? lumaStats(m) : null) : null;
  const d = m.data; const n = d.length;
  const L0 = L && L[0], L1 = L && L[1], L2 = L && L[2];
  for (let i = 0; i < n; i += 3) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    if (L) { r = L0[r]; g = L1[g]; b = L2[b]; }
    if (sat) {
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      r = y + (r - y) * (1 + sat); g = y + (g - y) * (1 + sat); b = y + (b - y) * (1 + sat);
    }
    if (cbr) {
      // reduce coloured/grey background tint on bright pixels while keeping coloured ink
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx > 150 && (mx - mn) < 90) {
        const w = cbr * clamp((mx - 150) / 70, 0, 1);
        const t = mx + (255 - mx) * w * 0.6;
        r = r + (t - r) * w; g = g + (t - g) * w; b = b + (t - b) * w;
      }
    }
    if (paper) {
      r = r * paper[0] / 255; g = g * paper[1] / 255; b = b * paper[2] / 255;
    }
    d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}
const PAPER = { cream: [252, 246, 228], gray: [236, 236, 236], blue: [232, 240, 252] };

function removeSpeckles(bin, maxArea, s) {
  // bin: 8UC1, text = 0 (black) on 255. Remove small black components.
  const inv = s.mat(); cv.bitwise_not(bin, inv);
  const labels = s.mat(), stats = s.mat(), cents = s.mat();
  let n;
  try { n = cv.connectedComponentsWithStats(inv, labels, stats, cents, 8, cv.CV_32S); } catch (_) {
    const k = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2)));
    const o = s.mat(); cv.morphologyEx(inv, o, cv.MORPH_OPEN, k); cv.bitwise_not(o, bin); return bin;
  }
  const remove = new Uint8Array(n);
  const sd = stats.data32S; // [x,y,w,h,area] per label
  for (let i = 1; i < n; i++) if (sd[i * 5 + 4] <= maxArea) remove[i] = 1;
  const ld = labels.data32S, bd = bin.data;
  for (let i = 0; i < ld.length; i++) if (remove[ld[i]]) bd[i] = 255;
  return bin;
}

function enhance(m, p, s) {
  p = p || {};
  // noise filters
  if (p.denoise > 0) { const d = s.mat(); cv.medianBlur(m, d, p.denoise > 55 ? 5 : 3); m = d; }
  if (p.bilateral > 0) {
    const d = s.mat(); cv.bilateralFilter(m, d, 5, 20 + p.bilateral * 1.2, 5 + p.bilateral / 10, cv.BORDER_DEFAULT); m = d;
  }
  if (p.gaussian > 0) { const d = s.mat(); const k = odd(p.gaussian * 2 + 1); cv.GaussianBlur(m, d, new cv.Size(k, k), 0); m = d; }
  // background / shadow removal
  if (p.bgClean > 0) m = backgroundNormalize(m, p.bgClean / 100, s);
  // ensure we own a writable continuous copy before in-place tone ops
  { const d = s.mat(); m.copyTo(d); m = d; }
  applyTone(m, p);
  // local contrast
  if (p.clahe > 0 || p.histEq) {
    const lab = s.mat(); cv.cvtColor(m, lab, cv.COLOR_RGB2Lab);
    const ch = s.t(new cv.MatVector()); cv.split(lab, ch);
    const l = ch.get(0); const lo = new cv.Mat();
    if (p.histEq) cv.equalizeHist(l, lo); else l.copyTo(lo);
    if (p.clahe > 0) {
      const cl = new cv.CLAHE(0.5 + p.clahe / 100 * 4.5, new cv.Size(8, 8));
      const t = new cv.Mat(); cl.apply(lo, t); t.copyTo(lo); t.delete(); cl.delete();
    }
    ch.set(0, lo); l.delete(); lo.delete();
    const merged = s.mat(); cv.merge(ch, merged);
    const d = s.mat(); cv.cvtColor(merged, d, cv.COLOR_Lab2RGB); m = d;
  }
  // unsharp mask
  if (p.sharpen > 0) {
    const amt = p.sharpen / 50; const sigma = 1 + Math.max(m.cols, m.rows) / 2500;
    const bl = s.mat(); cv.GaussianBlur(m, bl, new cv.Size(0, 0), sigma);
    const d = s.mat(); cv.addWeighted(m, 1 + amt, bl, -amt, 0, d); m = d;
  }
  // colour mode
  if (p.mode === 'gray' || p.mode === 'bw') {
    const g = s.mat(); cv.cvtColor(m, g, cv.COLOR_RGB2GRAY); m = g;
  }
  if (p.mode === 'bw') {
    const b = s.mat();
    const method = p.bwMethod || 'adaptive';
    if (method === 'otsu') cv.threshold(m, b, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    else if (method === 'fixed') cv.threshold(m, b, p.threshold ?? 160, 255, cv.THRESH_BINARY);
    else {
      const base = Math.min(m.cols, m.rows);
      const block = odd(p.bwBlock ? p.bwBlock : Math.max(15, base / 45));
      const pre = s.mat(); cv.GaussianBlur(m, pre, new cv.Size(3, 3), 0);
      cv.adaptiveThreshold(pre, b, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, Math.max(3, block), p.bwC ?? 12);
    }
    m = b;
    if (p.bgNoise > 0) m = removeSpeckles(m, Math.round(1 + p.bgNoise / 100 * Math.max(4, m.cols * m.rows / 400000)), s);
  } else if (p.bgNoise > 0) {
    const d = s.mat(); cv.medianBlur(m, d, 3); m = d;
  }
  if (p.morph && p.morph !== 'none') {
    const ks = Math.max(1, p.morphSize || 2);
    const k = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ks, ks)));
    const d = s.mat();
    const op = { erode: cv.MORPH_ERODE, dilate: cv.MORPH_DILATE, open: cv.MORPH_OPEN, close: cv.MORPH_CLOSE }[p.morph];
    cv.morphologyEx(m, d, op, k); m = d;
  }
  if (p.addBorder > 0) {
    const bw = Math.round(p.addBorder);
    const col = hexToRgb(p.borderColor || '#ffffff');
    const sc = m.channels() === 1 ? new cv.Scalar((col[0] + col[1] + col[2]) / 3) : new cv.Scalar(col[0], col[1], col[2], 255);
    const d = s.mat(); cv.copyMakeBorder(m, d, bw, bw, bw, bw, cv.BORDER_CONSTANT, sc); m = d;
  }
  return m;
}
function hexToRgb(h) { const v = parseInt(h.replace('#', ''), 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }

function processImage({ image, state, wantBase }) {
  const s = new Scope();
  try {
    const rgb = fromImageData(image, s);
    const geo = applyGeometry(rgb, state, s);
    const out = enhance(geo, state.params, s);
    const res = { image: toImageData(out) };
    if (wantBase) {
      let b = geo;
      if (state.params && state.params.addBorder > 0) { const d = s.mat(); const bw = Math.round(state.params.addBorder); cv.copyMakeBorder(geo, d, bw, bw, bw, bw, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255)); b = d; }
      res.base = toImageData(b);
    }
    return res;
  } finally { s.free(); }
}

/* ---------- Deskew / orientation ---------- */
function textMask(m, s) {
  const { mat: small } = resizeMax(m, 1100, s);
  const g = s.mat(); cv.cvtColor(small, g, cv.COLOR_RGB2GRAY);
  const bin = s.mat();
  cv.adaptiveThreshold(g, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, odd(Math.max(15, small.cols / 50)), 15);
  // ignore the outer 4% (page borders / shadows produce strong false lines)
  const mx = Math.round(bin.cols * 0.04), my = Math.round(bin.rows * 0.04);
  const roi = s.t(bin.roi(new cv.Rect(mx, my, bin.cols - 2 * mx, bin.rows - 2 * my)));
  const c = s.mat(); roi.copyTo(c);
  return c;
}

function profileScore(bin, angle, s) {
  const r = rotateFine(bin, angle, s, 0);
  const rows = r.rows, cols = r.cols, d = r.data;
  let prev = -1, score = 0;
  for (let y = 0; y < rows; y++) {
    let sum = 0; const o = y * cols;
    for (let x = 0; x < cols; x++) sum += d[o + x];
    sum /= 255;
    if (prev >= 0) score += (sum - prev) * (sum - prev);
    prev = sum;
  }
  if (r !== bin) r.delete();
  return score / Math.max(1, rows);
}

function estimateSkew(m, s) {
  const bin = textMask(m, s);
  // Hough on horizontally-smeared text lines for a coarse estimate
  let coarse = 0;
  try {
    const k = s.t(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(odd(bin.cols / 60), 1)));
    const sm = s.mat(); cv.dilate(bin, sm, k);
    const edges = s.mat(); cv.Canny(sm, edges, 50, 150);
    const lines = s.mat();
    cv.HoughLinesP(edges, lines, 1, Math.PI / 720, 60, bin.cols / 6, 12);
    const angs = [];
    const ld = lines.data32S;
    for (let i = 0; i < lines.rows; i++) {
      const x1 = ld[i * 4], y1 = ld[i * 4 + 1], x2 = ld[i * 4 + 2], y2 = ld[i * 4 + 3];
      const a = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
      if (Math.abs(a) < 30) angs.push({ a, w: Math.hypot(x2 - x1, y2 - y1) });
    }
    if (angs.length >= 3) {
      angs.sort((p, q) => p.a - q.a);
      const tot = angs.reduce((t, x) => t + x.w, 0); let acc = 0;
      for (const x of angs) { acc += x.w; if (acc >= tot / 2) { coarse = x.a; break; } }
    }
  } catch (_) { coarse = 0; }
  // projection-profile refinement (search around Hough estimate and around 0)
  const { mat: pb } = resizeMax(bin, 700, s);
  let best = 0, bs = -1;
  const tryA = (a) => { const sc = profileScore(pb, a, s); if (sc > bs) { bs = sc; best = a; } };
  for (let a = -15; a <= 15; a += 1) tryA(a);
  for (let a = coarse - 2; a <= coarse + 2; a += 0.5) tryA(a);
  const c1 = best;
  for (let a = c1 - 0.6; a <= c1 + 0.6; a += 0.1) tryA(+a.toFixed(2));
  const zero = profileScore(pb, 0, s);
  return { angle: +best.toFixed(2), hough: +coarse.toFixed(2), gain: zero > 0 ? +(bs / zero).toFixed(3) : 1 };
}

function deskew({ image, state }) {
  const s = new Scope();
  try {
    const rgb = fromImageData(image, s);
    const geo = applyGeometry(rgb, Object.assign({}, state, { angle: 0, params: {} }), s);
    const r = estimateSkew(geo, s);
    // rotateFine(+a) turns the image counter-clockwise by a degrees; the profile search
    // returns the rotation that best aligns text lines, so it is the correction itself.
    return { angle: Math.abs(r.angle) < 0.05 ? 0 : r.angle, hough: r.hough, gain: r.gain };
  } finally { s.free(); }
}

function orientation({ image, state }) {
  const s = new Scope();
  try {
    const rgb = fromImageData(image, s);
    const geo = applyGeometry(rgb, Object.assign({}, state, { params: {} }), s);
    const bin = textMask(geo, s);
    const { mat: pb } = resizeMax(bin, 600, s);
    const h = profileScore(pb, 0, s);
    const r = rotate90(pb, 90, s);
    const v = profileScore(r, 0, s);
    return { rotate: v > h * 1.35 ? 90 : 0, h, v };
  } finally { s.free(); }
}

function findGutter({ image, state }) {
  const s = new Scope();
  try {
    const rgb = fromImageData(image, s);
    const geo = applyGeometry(rgb, Object.assign({}, state, { params: {} }), s);
    const { mat: sm } = resizeMax(geo, 800, s);
    const g = s.mat(); cv.cvtColor(sm, g, cv.COLOR_RGB2GRAY);
    const W = g.cols, H = g.rows, d = g.data;
    const col = new Float64Array(W);
    for (let y = Math.round(H * 0.1); y < H * 0.9; y++) for (let x = 0; x < W; x++) col[x] += d[y * W + x];
    let best = W / 2, bv = Infinity;
    const r = Math.max(2, Math.round(W / 100));
    for (let x = Math.round(W * 0.35); x < W * 0.65; x++) {
      let v = 0; for (let k = -r; k <= r; k++) v += col[clamp(x + k, 0, W - 1)];
      if (v < bv) { bv = v; best = x; }
    }
    return { fraction: best / W };
  } finally { s.free(); }
}

/* ---------- Message loop ---------- */
const OPS = { detect, detectMulti, process: processImage, deskew, orientation, findGutter };

self.onmessage = async (e) => {
  const { id, op, payload } = e.data;
  try {
    const info = await loadCV();
    if (op === 'init') { self.postMessage({ id, ok: true, result: info }); return; }
    const fn = OPS[op];
    if (!fn) throw new Error('Unknown op ' + op);
    const result = fn(payload);
    const transfer = [];
    if (result && result.image) transfer.push(result.image.data.buffer);
    if (result && result.base) transfer.push(result.base.data.buffer);
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    let msg = err && err.message ? err.message : String(err);
    if (typeof err === 'number' && self.cv && self.cv.exceptionFromPtr) { try { msg = self.cv.exceptionFromPtr(err).msg; } catch (_) { /* */ } }
    self.postMessage({ id, ok: false, error: msg });
  }
};
