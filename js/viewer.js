// Canvas page viewer: zoom, pan, pinch, fit/actual size, before/after comparison, OCR word boxes, swipe.
import { $, bus, clamp } from './util.js';

export class Viewer {
  constructor(root, canvas) {
    this.root = root; this.c = canvas; this.x = canvas.getContext('2d');
    this.img = null; this.base = null; this.realW = 0; this.realH = 0;
    this.scale = 1; this.ox = 0; this.oy = 0; this.fit = true;
    this.compare = false; this.split = 0.5; this.boxes = null; this.showBoxes = false; this.highlight = null;
    this.pointers = new Map();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.bind();
  }
  setImage(img, base, realW, realH) {
    const first = !this.img || this.img.width !== img?.width || this.img.height !== img?.height;
    if (this.img && this.img !== img && this.img.close) this.img.close();
    if (this.base && this.base !== base && this.base.close) this.base.close();
    this.img = img; this.base = base; this.realW = realW || img?.width; this.realH = realH || img?.height;
    if (first || this.fit) this.fitView(); else this.draw();
  }
  clear() { if (this.img && this.img.close) this.img.close(); this.img = null; this.base = null; this.draw(); }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.root.getBoundingClientRect();
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.dpr = dpr;
    if (this.fit) this.fitView(); else this.draw();
  }
  get viewW() { return this.c.width / (this.dpr || 1); }
  get viewH() { return this.c.height / (this.dpr || 1); }
  /** displayed scale relative to the real (full-resolution) image */
  get realZoom() { return this.img ? this.scale * this.img.width / (this.realW || this.img.width) : 1; }
  fitView() {
    this.fit = true;
    if (!this.img) { this.draw(); return; }
    const pad = 16;
    this.scale = Math.min((this.viewW - pad * 2) / this.img.width, (this.viewH - pad * 2) / this.img.height);
    this.ox = (this.viewW - this.img.width * this.scale) / 2; this.oy = (this.viewH - this.img.height * this.scale) / 2;
    this.draw();
  }
  actualSize() {
    if (!this.img) return;
    const target = (this.realW || this.img.width) / this.img.width;
    this.zoomAt(target, this.viewW / 2, this.viewH / 2, true);
  }
  zoomBy(f, cx = this.viewW / 2, cy = this.viewH / 2) { this.zoomAt(this.scale * f, cx, cy, true); }
  zoomAt(ns, cx, cy, absolute) {
    if (!this.img) return;
    const min = Math.min(0.05, this.scale), max = Math.max(8 * (this.realW || this.img.width) / this.img.width, 2);
    ns = clamp(ns, min, max);
    this.ox = cx - (cx - this.ox) * ns / this.scale; this.oy = cy - (cy - this.oy) * ns / this.scale;
    this.scale = ns; this.fit = false;
    this.draw();
  }
  draw() {
    const x = this.x, dpr = this.dpr || 1;
    x.setTransform(1, 0, 0, 1, 0, 0);
    x.clearRect(0, 0, this.c.width, this.c.height);
    if (!this.img) { bus.emit('zoom', null); return; }
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.imageSmoothingQuality = 'high';
    const w = this.img.width * this.scale, hgt = this.img.height * this.scale;
    x.shadowColor = 'rgba(0,0,0,.45)'; x.shadowBlur = 18;
    x.fillStyle = '#fff'; x.fillRect(this.ox, this.oy, w, hgt);
    x.shadowBlur = 0;
    const handle = $('#compare-handle');
    if (this.compare && this.base) {
      const sx = this.ox + w * this.split;
      const rtl = document.dir === 'rtl';
      // "before" on the right in RTL, on the left in LTR
      x.save(); x.beginPath();
      if (rtl) x.rect(sx, this.oy, this.ox + w - sx, hgt); else x.rect(this.ox, this.oy, sx - this.ox, hgt);
      x.clip(); x.drawImage(this.base, this.ox, this.oy, w, hgt); x.restore();
      x.save(); x.beginPath();
      if (rtl) x.rect(this.ox, this.oy, sx - this.ox, hgt); else x.rect(sx, this.oy, this.ox + w - sx, hgt);
      x.clip(); x.drawImage(this.img, this.ox, this.oy, w, hgt); x.restore();
      handle.classList.remove('hidden'); handle.style.left = sx + 'px';
    } else {
      x.drawImage(this.img, this.ox, this.oy, w, hgt);
      handle.classList.add('hidden');
    }
    if (this.showBoxes && this.boxes && this.boxes.words) {
      const k = this.scale * this.img.width / this.boxes.w;
      for (const wd of this.boxes.words) {
        const [x0, y0, x1, y1] = wd.b;
        const c = wd.c;
        const hit = this.highlight && wd.n && wd.n.includes(this.highlight);
        x.strokeStyle = hit ? 'rgba(255,201,64,1)' : c >= 85 ? 'rgba(47,191,113,.85)' : c >= 60 ? 'rgba(242,169,59,.9)' : 'rgba(239,90,90,.9)';
        x.lineWidth = hit ? 2.5 : 1.2;
        if (hit) { x.fillStyle = 'rgba(255,201,64,.3)'; x.fillRect(this.ox + x0 * k, this.oy + y0 * k, (x1 - x0) * k, (y1 - y0) * k); }
        x.strokeRect(this.ox + x0 * k, this.oy + y0 * k, (x1 - x0) * k, (y1 - y0) * k);
      }
    }
    bus.emit('zoom', this.realZoom);
  }
  bind() {
    const el = this.root;
    el.addEventListener('wheel', (e) => {
      if (!this.img) return;
      e.preventDefault();
      const r = this.c.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey || !e.shiftKey) this.zoomAt(this.scale * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, true);
      else { this.ox -= e.deltaX || e.deltaY; this.fit = false; this.draw(); }
    }, { passive: false });
    el.addEventListener('pointerdown', (e) => {
      if (!this.img || e.target.closest('.viewer-empty')) return;
      el.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
      if (this.pointers.size === 2) { const [a, b] = [...this.pointers.values()]; this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: this.scale }; }
      el.classList.add('panning');
    });
    el.addEventListener('pointermove', (e) => {
      const p = this.pointers.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      const r = this.c.getBoundingClientRect();
      if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.zoomAt(this.pinch.s * d / this.pinch.d, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, true);
        return;
      }
      if (this.compare && this.base) {
        const w = this.img.width * this.scale;
        this.split = clamp((e.clientX - r.left - this.ox) / w, 0, 1); this.draw(); return;
      }
      if (this.fit && e.pointerType !== 'mouse') return; // swipe gesture handled on up
      this.ox += dx; this.oy += dy; this.fit = false; this.draw();
    });
    const up = (e) => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (this.pointers.size < 2) this.pinch = null;
      if (!this.pointers.size) el.classList.remove('panning');
      if (p && this.fit && !this.compare && e.pointerType !== 'mouse') {
        const dx = e.clientX - p.sx, dy = e.clientY - p.sy, dt = performance.now() - p.t;
        if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600) {
          const forward = document.dir === 'rtl' ? dx > 0 : dx < 0;
          bus.emit('swipe', forward ? 1 : -1);
        }
      }
    };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
    el.addEventListener('dblclick', () => { if (this.fit) this.actualSize(); else this.fitView(); });
  }
}
