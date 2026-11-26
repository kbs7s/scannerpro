// Shared helpers
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('class', 'ic ' + cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + ' ' + u[i];
}

export function fmtDate(ts, lang = document.documentElement.lang) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(lang === 'ar' ? 'ar-IQ-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return new Date(ts).toISOString(); }
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function safeName(s, fallback = 'document') {
  const n = String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return n || fallback;
}

const loaded = new Map();
export function loadScript(src) {
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res();
    s.onerror = () => { loaded.delete(src); rej(new Error('Failed to load ' + src)); };
    document.head.append(s);
  });
  loaded.set(src, p);
  return p;
}

export async function libPdfjs() {
  await loadScript('libs/pdfjs/pdf.min.js');
  const lib = window.pdfjsLib;
  if (!lib) throw new Error('PDF.js not available');
  lib.GlobalWorkerOptions.workerSrc = new URL('libs/pdfjs/pdf.worker.min.js', document.baseURI).href;
  return lib;
}
export async function libPdfLib() { await loadScript('libs/pdflib/pdf-lib.min.js'); if (!window.PDFLib) throw new Error('pdf-lib not available'); return window.PDFLib; }
export async function libJSZip() { await loadScript('libs/jszip/jszip.min.js'); if (!window.JSZip) throw new Error('JSZip not available'); return window.JSZip; }
export async function libTesseract() { await loadScript('libs/tesseract/tesseract.min.js'); if (!window.Tesseract) throw new Error('Tesseract.js not available'); return window.Tesseract; }

// Arabic-aware normalisation for search
export function normalizeText(s) {
  return String(s || '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '') // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .toLowerCase();
}

export function isArabicDominant(s) {
  const ar = (s.match(/[؀-ۿ]/g) || []).length;
  const lat = (s.match(/[A-Za-z]/g) || []).length;
  return ar >= lat;
}

export class Emitter {
  constructor() { this.l = {}; }
  on(e, f) { (this.l[e] ||= new Set()).add(f); return () => this.l[e].delete(f); }
  emit(e, ...a) { (this.l[e] || []).forEach((f) => { try { f(...a); } catch (err) { console.error(err); } }); }
}
export const bus = new Emitter();

export function readAsArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsArrayBuffer(file); });
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const mmToPt = (mm) => mm * 72 / 25.4;
export const PAGE_SIZES = { A3: [297, 420], A4: [210, 297], A5: [148, 210], Letter: [215.9, 279.4], Legal: [215.9, 355.6] };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function lsGet(key, def) { try { const v = localStorage.getItem(key); return v == null ? def : JSON.parse(v); } catch (_) { return def; } }
export function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* storage blocked */ } }

export function base64ToBlob(b64, type) {
  const bin = atob(b64); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}
