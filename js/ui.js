// UI primitives: toasts, dialogs, menus, progress
import { $, h, icon } from './util.js';
import { t } from './i18n.js';

export function toast(msg, type = 'info', opts = {}) {
  const box = $('#toasts');
  const ic = { ok: 'check', warn: 'circle-alert', bad: 'circle-alert', info: 'info' }[type] || 'info';
  const el = h('div', { class: 'toast ' + type, role: type === 'bad' ? 'alert' : 'status' }, icon(ic), h('div', {}, msg));
  if (opts.action) el.append(h('button', { class: 'btn sm', onclick: () => { opts.action.fn(); el.remove(); } }, opts.action.label));
  el.addEventListener('click', (e) => { if (e.target === el) el.remove(); });
  box.append(el);
  setTimeout(() => el.remove(), opts.ms || (type === 'bad' ? 8000 : 3500));
  return el;
}

export function errorToast(err, prefix) {
  console.error(err);
  let m = err && err.quota ? t('err.quota') : (err && err.message) || String(err);
  if (prefix) m = prefix + ': ' + m;
  toast(m, 'bad');
}

/** Generic modal. build(body, foot, close) fills content. Resolves with close(value). */
export function modal({ title, build, big = false, onClose, className = '' }) {
  const dlg = big ? $('#dlg-big') : $('#dlg');
  const inner = big ? $('#dlg-big-inner') : $('#dlg-inner');
  if (dlg.open) dlg.close('replaced');
  inner.innerHTML = '';
  dlg.className = 'dlg' + (big ? ' big' : '') + (className ? ' ' + className : '');
  const head = h('div', { class: 'dlg-head' }, h('h3', {}, title), h('button', { type: 'button', class: 'ib', 'aria-label': t('act.close'), onclick: () => close(undefined) }, icon('x')));
  const body = h('div', { class: 'dlg-body' });
  const foot = h('div', { class: 'dlg-foot' });
  inner.append(head, body, foot);
  let resolve; let done = false;
  const p = new Promise((r) => { resolve = r; });
  function close(v) {
    if (done) return; done = true;
    try { onClose && onClose(v); } catch (e) { console.error(e); }
    if (dlg.open) dlg.close();
    resolve(v);
  }
  dlg.oncancel = (e) => { e.preventDefault(); close(undefined); };
  dlg.onclose = () => { if (!done) { done = true; resolve(undefined); } };
  build(body, foot, close);
  if (!foot.children.length) foot.remove();
  dlg.showModal();
  return p;
}

export function confirmDialog(message, { title = t('act.confirm'), okText = t('act.ok'), danger = false } = {}) {
  return modal({
    title,
    build(body, foot, close) {
      body.append(h('p', {}, message));
      foot.append(
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close(false) }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => close(true), autofocus: true }, okText),
      );
    },
  }).then((v) => !!v);
}

export function promptDialog(message, def = '', { title = '', type = 'text', placeholder = '' } = {}) {
  return modal({
    title: title || message,
    build(body, foot, close) {
      const inp = h('input', { type, value: def, placeholder, style: { width: '100%' } });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); close(inp.value); } });
      if (title) body.append(h('p', {}, message));
      body.append(inp);
      foot.append(
        h('button', { type: 'button', class: 'btn ghost', onclick: () => close(null) }, t('act.cancel')),
        h('button', { type: 'button', class: 'btn primary', onclick: () => close(inp.value) }, t('act.ok')),
      );
      setTimeout(() => { inp.focus(); inp.select(); }, 50);
    },
  }).then((v) => (v == null ? null : v));
}

export function choiceDialog(title, options, { message = '' } = {}) {
  return modal({
    title,
    build(body, foot, close) {
      if (message) body.append(h('p', {}, message));
      const list = h('div', { class: 'btn-col' });
      for (const o of options) list.append(h('button', { type: 'button', class: 'btn' + (o.primary ? ' primary' : ''), onclick: () => close(o.value) }, o.icon ? icon(o.icon) : null, o.label));
      body.append(list);
    },
  });
}

/* ---------- Context menu ---------- */
export function showMenu(anchor, items) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (!it || it.hidden) continue;
    m.append(h('button', { type: 'button', class: it.danger ? 'danger' : '', role: 'menuitem', disabled: it.disabled, onclick: () => { hideMenu(); it.fn(); } }, it.icon ? icon(it.icon) : null, it.label));
  }
  m.classList.remove('hidden');
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, top: anchor.y, bottom: anchor.y, right: anchor.x };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let x = document.dir === 'rtl' ? r.right - mw : r.left;
  let y = r.bottom + 4;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 4);
  x = Math.max(8, Math.min(innerWidth - mw - 8, x));
  m.style.left = x + 'px'; m.style.top = y + 'px';
  setTimeout(() => document.addEventListener('pointerdown', outside, { capture: true }), 0);
}
function outside(e) { if (!$('#menu').contains(e.target)) hideMenu(); }
export function hideMenu() { $('#menu').classList.add('hidden'); document.removeEventListener('pointerdown', outside, { capture: true }); }

/* ---------- Progress overlay (batch operations) ---------- */
export class Progress {
  constructor(title, { cancellable = true, pausable = false } = {}) {
    this.el = $('#progress');
    this.cancelled = false; this.paused = false; this.errors = [];
    $('#pg-title').textContent = title;
    $('#pg-bar').style.width = '0%';
    $('#pg-text').textContent = '';
    $('#pg-errors').innerHTML = '';
    $('#pg-cancel').hidden = !cancellable;
    $('#pg-pause').hidden = !pausable;
    $('#pg-retry').hidden = true;
    $('#pg-close').hidden = true;
    $('#pg-cancel').onclick = () => { this.cancelled = true; $('#pg-text').textContent = t('batch.cancelling'); if (this.onCancel) this.onCancel(); };
    $('#pg-pause').onclick = () => { this.paused = !this.paused; $('#pg-pause').lastElementChild.textContent = this.paused ? t('batch.resume') : t('batch.pause'); };
    this.el.classList.remove('hidden');
    this.statusBar(0);
  }
  set(frac, text) {
    const p = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    $('#pg-bar').style.width = p + '%';
    if (text != null) $('#pg-text').textContent = text + ' — ' + p + '%';
    this.statusBar(p);
  }
  statusBar(p) {
    const s = $('#st-progress'); s.classList.remove('hidden'); s.style.setProperty('--p', p + '%'); s.querySelector('i').style.setProperty('--p', p + '%'); s.querySelector('b').textContent = p + '%';
  }
  error(msg) { this.errors.push(msg); $('#pg-errors').append(h('li', {}, msg)); }
  async waitIfPaused() { while (this.paused && !this.cancelled) await new Promise((r) => setTimeout(r, 200)); }
  /** Finish: if there were errors keep the dialog open with retry/close; otherwise hide. */
  finish({ retry } = {}) {
    $('#st-progress').classList.add('hidden');
    if (this.errors.length && !this.cancelled) {
      $('#pg-cancel').hidden = true; $('#pg-pause').hidden = true; $('#pg-close').hidden = false;
      $('#pg-text').textContent = t('batch.doneWithErrors', { n: this.errors.length });
      if (retry) { $('#pg-retry').hidden = false; $('#pg-retry').onclick = () => { this.close(); retry(); }; }
      $('#pg-close').onclick = () => this.close();
      return;
    }
    this.close();
  }
  close() { this.el.classList.add('hidden'); $('#st-progress').classList.add('hidden'); }
}

export function setBusy(on) { $('#viewer-busy').classList.toggle('hidden', !on); }
