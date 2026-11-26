// Four-corner crop / perspective editor with touch handles, magnifier loupe and numeric fine adjustment.
import { $, h, clamp } from './util.js';
import { t } from './i18n.js';

const FULL = () => [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

/**
 * @param {object} o
 *  bitmap: ImageBitmap of the original (any resolution)
 *  corners: normalised corners or null
 *  origW/origH: full resolution size (for numeric fields)
 *  detect: async () => ({ corners, confidence }) to re-run automatic detection
 *  confidence: number|undefined
 * @returns Promise<{ corners, rotate } | null>
 */
export function openCropper(o) {
  return new Promise((resolve) => {
    const root = $('#cropper'), stage = $('#crop-stage'), cv = $('#crop-canvas'), loupe = $('#crop-loupe');
    const ctx = cv.getContext('2d'), lctx = loupe.getContext('2d');
    const img = o.bitmap;
    let q = (o.corners || FULL()).map((p) => ({ ...p }));
    const initial = q.map((p) => ({ ...p }));
    let rotate = 0;
    let view = { s: 1, x: 0, y: 0 };
    let drag = null;
    root.classList.remove('hidden');
    setConf(o.confidence);

    function setConf(c) {
      const el = $('#crop-conf');
      if (c == null) { el.textContent = ''; return; }
      const pct = Math.round(c * 100);
      el.innerHTML = '';
      el.append(h('span', { class: 'badge ' + (pct >= 75 ? 'ok' : pct >= 50 ? 'warn' : 'bad') }, t('detect.confidence') + ': ' + pct + '%'));
    }

    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const r = stage.getBoundingClientRect();
      cv.width = r.width * dpr; cv.height = r.height * dpr;
      const pad = 28;
      const s = Math.min((r.width - pad * 2) / img.width, (r.height - pad * 2) / img.height);
      view = { s, x: (r.width - img.width * s) / 2, y: (r.height - img.height * s) / 2, dpr };
      draw();
    }
    const toScreen = (p) => ({ x: view.x + p.x * img.width * view.s, y: view.y + p.y * img.height * view.s });
    const toNorm = (x, y) => ({ x: clamp((x - view.x) / (img.width * view.s), 0, 1), y: clamp((y - view.y) / (img.height * view.s), 0, 1) });

    function draw() {
      const { dpr } = view;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(img, view.x, view.y, img.width * view.s, img.height * view.s);
      const pts = q.map(toScreen);
      // darken outside
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.beginPath();
      ctx.rect(view.x, view.y, img.width * view.s, img.height * view.s);
      ctx.moveTo(pts[0].x, pts[0].y); for (let i = 3; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].y); ctx.closePath();
      ctx.fill('evenodd'); ctx.restore();
      ctx.strokeStyle = '#3d8bfd'; ctx.lineWidth = 2.5; ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
      // grid
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 1;
      for (const f of [1 / 3, 2 / 3]) {
        const a = lerp(pts[0], pts[1], f), b = lerp(pts[3], pts[2], f); line(a, b);
        const c = lerp(pts[0], pts[3], f), d = lerp(pts[1], pts[2], f); line(c, d);
      }
      // handles
      pts.forEach((p, i) => { handle(p, 13, drag && drag.i === i); });
      for (let i = 0; i < 4; i++) { const m = lerp(pts[i], pts[(i + 1) % 4], 0.5); handle(m, 8, drag && drag.e === i, true); }
      updateCoords();
    }
    function line(a, b) { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    function handle(p, r, active, edge) {
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = active ? '#3d8bfd' : edge ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.95)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = '#3d8bfd'; ctx.stroke();
    }
    const lerp = (a, b, f) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });

    function drawLoupe(sp) {
      loupe.classList.remove('hidden');
      const r = stage.getBoundingClientRect();
      loupe.style.left = (sp.x < r.width / 2 ? r.width - 152 : 12) + 'px';
      const L = 140, zoom = 3;
      const ix = (sp.x - view.x) / view.s, iy = (sp.y - view.y) / view.s;
      const span = L / (view.s * zoom);
      lctx.fillStyle = '#000'; lctx.fillRect(0, 0, L, L);
      lctx.drawImage(img, ix - span / 2, iy - span / 2, span, span, 0, 0, L, L);
      lctx.strokeStyle = '#3d8bfd'; lctx.lineWidth = 1.5;
      lctx.beginPath(); lctx.moveTo(L / 2, 0); lctx.lineTo(L / 2, L); lctx.moveTo(0, L / 2); lctx.lineTo(L, L / 2); lctx.stroke();
    }

    function hit(x, y) {
      const pts = q.map(toScreen);
      const tol = matchMedia('(pointer: coarse)').matches ? 34 : 22;
      let best = null, bd = tol;
      pts.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = { i }; } });
      if (best) return best;
      for (let i = 0; i < 4; i++) { const m = lerp(pts[i], pts[(i + 1) % 4], 0.5); if (Math.hypot(m.x - x, m.y - y) < tol) return { e: i }; }
      return null;
    }

    const onDown = (e) => {
      const r = stage.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      const hh = hit(x, y); if (!hh) return;
      stage.setPointerCapture(e.pointerId);
      drag = { ...hh, sx: x, sy: y, start: q.map((p) => ({ ...p })) };
      draw(); drawLoupe({ x, y });
    };
    const onMove = (e) => {
      if (!drag) return;
      const r = stage.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag.i != null) q[drag.i] = toNorm(x, y);
      else {
        const dn = { x: (x - drag.sx) / (img.width * view.s), y: (y - drag.sy) / (img.height * view.s) };
        const a = drag.e, b = (drag.e + 1) % 4;
        q[a] = { x: clamp(drag.start[a].x + dn.x, 0, 1), y: clamp(drag.start[a].y + dn.y, 0, 1) };
        q[b] = { x: clamp(drag.start[b].x + dn.x, 0, 1), y: clamp(drag.start[b].y + dn.y, 0, 1) };
      }
      draw(); drawLoupe({ x, y });
    };
    const onUp = () => { drag = null; loupe.classList.add('hidden'); draw(); };

    const coordsBox = $('#crop-coords');
    const names = ['tl', 'tr', 'br', 'bl'];
    coordsBox.innerHTML = '';
    const fields = names.map((n, i) => {
      const fx = h('input', { type: 'number', min: 0, max: o.origW, step: 1 });
      const fy = h('input', { type: 'number', min: 0, max: o.origH, step: 1 });
      const set = () => { q[i] = { x: clamp(+fx.value / o.origW, 0, 1), y: clamp(+fy.value / o.origH, 0, 1) }; draw(); };
      fx.addEventListener('change', set); fy.addEventListener('change', set);
      coordsBox.append(h('fieldset', {}, h('legend', {}, t('crop.' + n)), h('label', {}, 'X ', fx), h('label', {}, 'Y ', fy)));
      return [fx, fy];
    });
    function updateCoords() {
      fields.forEach(([fx, fy], i) => {
        if (document.activeElement !== fx) fx.value = Math.round(q[i].x * o.origW);
        if (document.activeElement !== fy) fy.value = Math.round(q[i].y * o.origH);
      });
    }

    const ro = new ResizeObserver(layout); ro.observe(stage);
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    const onKey = (e) => { if (e.key === 'Escape') finish(null); if (e.key === 'Enter' && !(e.target instanceof HTMLInputElement)) finish({ corners: q, rotate }); };
    document.addEventListener('keydown', onKey);

    $('#crop-full').onclick = () => { q = FULL(); draw(); };
    $('#crop-reset').onclick = () => { q = initial.map((p) => ({ ...p })); rotate = 0; draw(); };
    $('#crop-rot').onclick = () => { rotate = (rotate + 90) % 360; $('#crop-rot').classList.toggle('on', !!rotate); $('#crop-rot').querySelector('span').textContent = t('geo.right') + (rotate ? ` (+${rotate}°)` : ''); };
    $('#crop-auto').onclick = async () => {
      const b = $('#crop-auto'); b.disabled = true;
      try {
        const r = await o.detect();
        if (r && r.found) { q = r.corners.map((p) => ({ ...p })); setConf(r.confidence); draw(); }
        else { setConf(0); }
      } finally { b.disabled = false; }
    };
    $('#crop-cancel').onclick = () => finish(null);
    $('#crop-apply').onclick = () => finish({ corners: q, rotate });

    function finish(v) {
      ro.disconnect();
      stage.removeEventListener('pointerdown', onDown); stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerup', onUp); stage.removeEventListener('pointercancel', onUp);
      document.removeEventListener('keydown', onKey);
      root.classList.add('hidden');
      $('#crop-rot').querySelector('span').textContent = t('geo.right');
      if (v) {
        // a full-frame selection means "no crop"
        const full = v.corners.every((p, i) => Math.abs(p.x - FULL()[i].x) < 0.002 && Math.abs(p.y - FULL()[i].y) < 0.002);
        v.corners = full ? null : v.corners;
      }
      resolve(v);
    }
    requestAnimationFrame(layout);
  });
}
