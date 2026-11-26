// Application settings (persisted in IndexedDB kv store, mirrored to localStorage for fast boot)
import { kvGet, kvSet } from './database.js';
import { bus } from './util.js';

export const DEFAULTS = {
  lang: 'ar',
  theme: 'dark',
  // export
  exportFormat: 'pdf',
  pageSize: 'A4',
  orientation: 'auto',
  quality: 'high',
  dpi: 200,
  margin: 0,
  // camera
  cameraId: '',
  captureRes: '4k',
  autoCapture: true,
  continuous: true,
  timer: 0,
  // detection
  detectSensitivity: 50,
  detectEdgeThreshold: 0,
  detectMinArea: 15,
  detectNoise: 30,
  detectMinConfidence: 60,
  detectInterval: 250,
  autoCropOnImport: true,
  // enhancement
  defaultPreset: 'auto',
  defaultBrightness: 0,
  defaultContrast: 0,
  cleanIntensity: 80,
  maxProcessingPx: 4000,
  // ocr
  ocrLangs: ['ara', 'eng'],
  ocrQuality: 'balanced',
  ocrPsm: '3',
  autoOcr: false,
  searchablePdf: true,
  // pdf import
  importDpi: 200,
  // scanner bridge
  bridgeUrl: 'http://127.0.0.1:7800',
  // misc
  askRestore: true,
  debug: false,
};

let current = { ...DEFAULTS };

export async function loadSettings() {
  try {
    const ls = localStorage.getItem('ssp.settings');
    if (ls) current = { ...DEFAULTS, ...JSON.parse(ls) };
  } catch (_) { /* private mode */ }
  try {
    const db = await kvGet('settings');
    if (db) current = { ...DEFAULTS, ...db };
  } catch (_) { /* IndexedDB unavailable */ }
  return current;
}

export const settings = new Proxy({}, {
  get: (_, k) => current[k],
  set: (_, k, v) => { current[k] = v; persist(); bus.emit('settings', k, v); return true; },
});

let t;
function persist() {
  clearTimeout(t);
  t = setTimeout(() => {
    try { localStorage.setItem('ssp.settings', JSON.stringify(current)); } catch (_) { /* */ }
    kvSet('settings', current).catch(() => {});
  }, 150);
}

export function allSettings() { return { ...current }; }
export async function replaceSettings(obj) { current = { ...DEFAULTS, ...obj }; persist(); bus.emit('settings', '*'); }
export function resetSettings() { return replaceSettings({}); }
