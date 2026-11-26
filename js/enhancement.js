// Enhancement presets and parameter controls (Enhance / Clean / Borders panels)
import { $, h, bus, uid, debounce } from './util.js';
import { t } from './i18n.js';
import * as db from './database.js';
import { currentPage, updatePage, updatePages, scopePages } from './project.js';
import { cvRun } from './cv-client.js';
import { getPreviewSource } from './render.js';
import { bitmapToImageData, makeCanvas } from './image-io.js';
import { toast, promptDialog, confirmDialog } from './ui.js';

export const PARAM_DEFAULTS = {
  brightness: 0, contrast: 0, exposure: 0, gamma: 1, highlights: 0, shadows: 0, saturation: 0, temperature: 0, tint: 0, sharpen: 0,
  denoise: 0, bilateral: 0, gaussian: 0, clahe: 0, histEq: false, autoLevels: false,
  mode: 'color', bwMethod: 'adaptive', threshold: 160, bwBlock: 0, bwC: 12, morph: 'none', morphSize: 2,
  bgClean: 0, whiten: 0, textPreserve: 0, bgNoise: 0, colorBgReduce: 0, paperColor: 'none',
  removeBorder: 0, addBorder: 0, borderColor: '#ffffff', resizePct: 100,
};
const GEOMETRY_KEYS = ['removeBorder', 'addBorder', 'borderColor', 'resizePct'];

// 20 professional presets — each is a real combination of image-processing operations
export const PRESETS = [
  { id: 'original', p: {} },
  { id: 'auto', p: { autoLevels: true, clahe: 15, sharpen: 25, bgClean: 35, whiten: 15 } },
  { id: 'docColor', p: { bgClean: 75, whiten: 40, textPreserve: 20, sharpen: 30, saturation: 15, autoLevels: true } },
  { id: 'cleanWhite', p: { bgClean: 100, whiten: 70, textPreserve: 30, colorBgReduce: 60, sharpen: 25 } },
  { id: 'bw', p: { mode: 'bw', bgClean: 80, bwMethod: 'adaptive', bgNoise: 30, bwC: 12 } },
  { id: 'gray', p: { mode: 'gray', autoLevels: true, sharpen: 15 } },
  { id: 'highContrast', p: { contrast: 45, autoLevels: true, sharpen: 35, bgClean: 40 } },
  { id: 'textClarity', p: { mode: 'gray', bgClean: 85, whiten: 40, textPreserve: 45, sharpen: 55 } },
  { id: 'oldDoc', p: { bgClean: 60, clahe: 35, contrast: 15, denoise: 30, colorBgReduce: 30, whiten: 25 } },
  { id: 'receipt', p: { mode: 'gray', bgClean: 100, whiten: 60, textPreserve: 50, clahe: 25, sharpen: 40 } },
  { id: 'book', p: { mode: 'gray', bgClean: 90, whiten: 50, textPreserve: 30, sharpen: 30 } },
  { id: 'idCard', p: { denoise: 20, autoLevels: true, saturation: 10, sharpen: 35, clahe: 15 } },
  { id: 'medical', p: { autoLevels: true, clahe: 20, sharpen: 20, bgClean: 45, whiten: 20 } },
  { id: 'handwritten', p: { bgClean: 90, whiten: 45, textPreserve: 55, sharpen: 20, contrast: 15, saturation: 20 } },
  { id: 'lowLight', p: { exposure: 0.8, shadows: 50, denoise: 40, clahe: 30, autoLevels: true } },
  { id: 'shadowRemoval', p: { bgClean: 100, whiten: 30, textPreserve: 20 } },
  { id: 'faded', p: { mode: 'gray', bgClean: 90, textPreserve: 70, clahe: 40, contrast: 25, sharpen: 40 } },
  { id: 'photocopy', p: { mode: 'bw', bwMethod: 'adaptive', bgClean: 100, bwBlock: 41, bwC: 15, bgNoise: 50, contrast: 20 } },
  { id: 'legal', p: { mode: 'gray', bgClean: 90, whiten: 50, textPreserve: 40, sharpen: 35, denoise: 15 } },
  { id: 'newspaper', p: { mode: 'gray', bgClean: 80, colorBgReduce: 50, whiten: 55, textPreserve: 35, clahe: 20, sharpen: 25 } },
];

export function presetParams(id, custom = customPresets) {
  const pr = PRESETS.find((x) => x.id === id) || custom.find((x) => x.id === id);
  return pr ? { ...pr.p } : null;
}

const BASIC = [
  ['brightness', -100, 100, 1], ['contrast', -100, 100, 1], ['exposure', -2, 2, 0.05], ['gamma', 0.3, 3, 0.05],
  ['highlights', -100, 100, 1], ['shadows', -100, 100, 1], ['saturation', -100, 100, 1], ['temperature', -100, 100, 1],
  ['tint', -100, 100, 1], ['sharpen', 0, 100, 1],
];
const ADV = [
  ['denoise', 0, 100, 1], ['bilateral', 0, 100, 1], ['gaussian', 0, 10, 1], ['clahe', 0, 100, 1],
  ['autoLevels', 'bool'], ['histEq', 'bool'],
  ['mode', 'select', ['color', 'gray', 'bw']], ['bwMethod', 'select', ['adaptive', 'otsu', 'fixed']],
  ['threshold', 0, 255, 1], ['bwBlock', 0, 151, 2], ['bwC', 0, 40, 1],
  ['morph', 'select', ['none', 'erode', 'dilate', 'open', 'close']], ['morphSize', 1, 9, 1],
];
const CLEAN = [
  ['bgClean', 0, 100, 1], ['whiten', 0, 100, 1], ['textPreserve', 0, 100, 1], ['bgNoise', 0, 100, 1],
  ['colorBgReduce', 0, 100, 1], ['threshold', 0, 255, 1], ['paperColor', 'select', ['none', 'white', 'cream', 'gray', 'blue']],
];
const BORDERS = [['removeBorder', 0, 20, 0.5], ['addBorder', 0, 200, 1], ['borderColor', 'color'], ['resizePct', 10, 100, 1]];

export let customPresets = [];
const controls = new Map(); // key -> [{input, output}]
let livePatch = {};

function val(page, k) { const v = page?.params?.[k]; return v === undefined ? PARAM_DEFAULTS[k] : v; }

function buildControl(def) {
  const [k, a, b, step] = def;
  let input; let out = null; let wrap;
  if (a === 'bool') {
    input = h('input', { type: 'checkbox' });
    wrap = h('label', { class: 'switch' }, input, h('span', {}, t('p.' + k)));
  } else if (a === 'select') {
    input = h('select', {}, b.map((o) => h('option', { value: o }, t('p.' + k + '.' + o))));
    wrap = h('label', { class: 'field' }, h('span', {}, t('p.' + k)), input);
  } else if (a === 'color') {
    input = h('input', { type: 'color', value: '#ffffff' });
    wrap = h('label', { class: 'field' }, h('span', {}, t('p.' + k)), input);
  } else {
    input = h('input', { type: 'range', min: a, max: b, step });
    out = h('output');
    wrap = h('label', { class: 'sl' }, h('span', {}, t('p.' + k)), input, out);
    input.addEventListener('dblclick', () => { input.value = PARAM_DEFAULTS[k]; input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); });
  }
  const read = () => (a === 'bool' ? input.checked : (a === 'select' || a === 'color') ? input.value : +input.value);
  const fmt = (v) => (k === 'bwBlock' && !v ? t('p.auto') : (Math.abs(v) < 10 && step < 1 ? (+v).toFixed(2) : String(v)));
  input.addEventListener('input', () => {
    if (out) out.value = fmt(read());
    livePatch[k] = read();
    for (const c of controls.get(k) || []) if (c.input !== input) setInput(c, read());
    requestLive();
  });
  input.addEventListener('change', () => commit({ [k]: read() }));
  const entry = { input, out, a, fmt };
  if (!controls.has(k)) controls.set(k, []);
  controls.get(k).push(entry);
  return wrap;
}

function setInput(c, v) {
  if (c.a === 'bool') c.input.checked = !!v; else c.input.value = v;
  if (c.out) c.out.value = c.fmt(v);
}

const requestLive = debounce(() => bus.emit('preview-override', { params: { ...(currentPage()?.params || {}), ...livePatch } }), 90);

async function commit(patch) {
  const page = currentPage(); if (!page) return;
  livePatch = {};
  const params = { ...(page.params || {}), ...patch };
  await updatePage(page, { params, preset: page.preset && !Object.keys(patch).some((k) => !GEOMETRY_KEYS.includes(k)) ? page.preset : '' }, { label: t('hist.adjust') });
}

export function syncControls() {
  const page = currentPage();
  for (const [k, list] of controls) for (const c of list) setInput(c, val(page, k));
  $$presets().forEach((b) => b.classList.toggle('active', !!page && b.dataset.id === (page.preset || '')));
}
const $$presets = () => Array.from(document.querySelectorAll('#presets .preset'));

export async function applyPreset(id, pages = null) {
  const pr = presetParams(id);
  if (!pr) return;
  const targets = pages || [currentPage()].filter(Boolean);
  if (!targets.length) return;
  const mk = (p) => {
    const keep = {}; GEOMETRY_KEYS.forEach((k) => { if (p.params && p.params[k] !== undefined) keep[k] = p.params[k]; });
    return { params: { ...pr, ...keep }, preset: id };
  };
  if (targets.length === 1) await updatePage(targets[0], mk(targets[0]), { label: t('hist.preset') });
  else await updatePages(targets, mk, { label: t('hist.preset') });
}

function presetName(p) { return p.name || t('preset.' + p.id); }

export async function renderPresetButtons() {
  const box = $('#presets'); box.innerHTML = '';
  for (const p of [...PRESETS, ...customPresets]) {
    const cv = h('canvas', { class: 'pv', width: 120, height: 90 });
    const b = h('button', { type: 'button', class: 'preset', dataset: { id: p.id }, title: presetName(p), onclick: () => applyPreset(p.id) }, cv, h('span', {}, presetName(p)));
    if (p.custom) b.append(h('span', { class: 'x', role: 'button', 'aria-label': t('act.delete'), onclick: (e) => { e.stopPropagation(); deleteCustomPreset(p.id); } }, '×'));
    box.append(b);
  }
  syncControls();
  refreshPresetThumbs();
}

let thumbGen = 0;
export const refreshPresetThumbs = debounce(async () => {
  const page = currentPage();
  const g = ++thumbGen;
  if (!page) return;
  try {
    const src = await getPreviewSource(page);
    const k = Math.min(1, 200 / Math.max(src.width, src.height));
    const c = makeCanvas(Math.round(src.width * k), Math.round(src.height * k));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    const small = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    for (const b of $$presets()) {
      if (g !== thumbGen) return;
      const pr = presetParams(b.dataset.id); if (!pr) continue;
      const copy = new ImageData(new Uint8ClampedArray(small.data), small.width, small.height);
      const st = { corners: page.corners, rotation: page.rotation, angle: page.angle, flipH: page.flipH, flipV: page.flipV, params: pr };
      const res = await cvRun('process', { image: copy, state: st }, { worker: 0 });
      const cvs = b.querySelector('canvas');
      const bm = await createImageBitmap(res.image);
      const x = cvs.getContext('2d');
      x.fillStyle = '#1b2536'; x.fillRect(0, 0, cvs.width, cvs.height);
      const kk = Math.min(cvs.width / bm.width, cvs.height / bm.height);
      x.drawImage(bm, (cvs.width - bm.width * kk) / 2, (cvs.height - bm.height * kk) / 2, bm.width * kk, bm.height * kk);
      bm.close && bm.close();
    }
  } catch (e) { console.warn('preset thumbs', e); }
}, 400);

export async function loadCustomPresets() {
  try { customPresets = (await db.getAll('presets')).map((p) => ({ ...p, custom: true })); } catch (_) { customPresets = []; }
}

async function saveCustomPreset() {
  const page = currentPage(); if (!page) return;
  const name = await promptDialog(t('enh.presetName'), '');
  if (!name) return;
  const params = { ...(page.params || {}) };
  GEOMETRY_KEYS.forEach((k) => delete params[k]);
  const rec = { id: uid('cp_'), name: name.trim(), p: params, createdAt: Date.now() };
  await db.put('presets', rec);
  await loadCustomPresets();
  await renderPresetButtons();
  toast(t('enh.presetSaved'), 'ok');
}
async function deleteCustomPreset(id) {
  if (!(await confirmDialog(t('enh.presetDelete'), { danger: true, okText: t('act.delete') }))) return;
  await db.del('presets', id);
  await loadCustomPresets();
  await renderPresetButtons();
}

async function resetKeys(keys) {
  const page = currentPage(); if (!page) return;
  const params = { ...(page.params || {}) };
  keys.forEach((k) => delete params[k]);
  await updatePage(page, { params, preset: '' }, { label: t('hist.reset') });
}

async function applyParamsToScope(scope, keys) {
  const page = currentPage(); if (!page) return;
  const targets = scopePages(scope).filter((p) => p.id !== page.id);
  if (!targets.length) { toast(t('scope.nothing'), 'warn'); return; }
  const src = page.params || {};
  await updatePages(targets, (p) => {
    const params = { ...(p.params || {}) };
    for (const k of keys) { if (src[k] === undefined) delete params[k]; else params[k] = src[k]; }
    return { params, preset: page.preset || '' };
  }, { label: t('hist.applyMany') });
  toast(t('scope.applied', { n: targets.length }), 'ok');
}

export function initEnhancement() {
  const basic = $('#e-basic'), adv = $('#e-adv'), clean = $('#c-controls'), borders = $('#g-borders');
  BASIC.forEach((d) => basic.append(buildControl(d)));
  ADV.forEach((d) => adv.append(buildControl(d)));
  // master "cleaning strength" slider drives the cleaning parameters together
  const master = h('input', { type: 'range', min: 0, max: 100, step: 1, value: 0 });
  const mo = h('output', {}, '0');
  clean.append(h('label', { class: 'sl' }, h('span', {}, t('p.cleanStrength')), master, mo));
  const masterPatch = (s) => ({ bgClean: s, whiten: Math.round(s * 0.6), textPreserve: Math.round(s * 0.3), bgNoise: Math.round(s * 0.2) });
  master.addEventListener('input', () => { mo.value = master.value; Object.assign(livePatch, masterPatch(+master.value)); for (const [k, v] of Object.entries(masterPatch(+master.value))) (controls.get(k) || []).forEach((c) => setInput(c, v)); requestLive(); });
  master.addEventListener('change', () => commit(masterPatch(+master.value)));
  CLEAN.forEach((d) => clean.append(buildControl(d)));
  BORDERS.forEach((d) => borders.append(buildControl(d)));

  $('#e-save-preset').onclick = saveCustomPreset;
  $('#e-reset').onclick = () => resetKeys(Object.keys(PARAM_DEFAULTS).filter((k) => !GEOMETRY_KEYS.includes(k)));
  $('#c-reset').onclick = () => resetKeys(['bgClean', 'whiten', 'textPreserve', 'bgNoise', 'colorBgReduce', 'paperColor']);
  $('#c-quick').onclick = () => commit({ bgClean: 100, whiten: 55, textPreserve: 30, bgNoise: 20, colorBgReduce: 40 });
  $('#e-apply').onclick = () => applyParamsToScope($('#e-scope').value, Object.keys(PARAM_DEFAULTS).filter((k) => !GEOMETRY_KEYS.includes(k)));
  $('#c-apply').onclick = () => applyParamsToScope($('#c-scope').value, ['bgClean', 'whiten', 'textPreserve', 'bgNoise', 'colorBgReduce', 'paperColor', 'threshold']);

  bus.on('current-changed', () => { livePatch = {}; syncControls(); refreshPresetThumbs(); });
  bus.on('page-changed', (p) => { if (p === currentPage()) { syncControls(); refreshPresetThumbs(); } });
}

