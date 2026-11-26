// PWA: service worker registration, update detection, install prompt, SW messaging.
import { $ } from './util.js';
import { t } from './i18n.js';
import { toast } from './ui.js';

let deferredPrompt = null;
let waiting = null;

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('service-worker.js', { scope: './', updateViaCache: 'none' });
    const track = (w) => {
      if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) showUpdate(w); });
    };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => track(reg.installing));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading || !waiting) return; reloading = true; location.reload(); });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'precache-progress') document.dispatchEvent(new CustomEvent('precache-progress', { detail: e.data }));
    });
    // check for updates periodically and when the app regains focus
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
    return reg;
  } catch (e) {
    console.warn('SW registration failed', e);
    return null;
  }
}

function showUpdate(w) {
  waiting = w;
  $('#update-bar').classList.remove('hidden');
  $('#btn-update').onclick = () => { w.postMessage({ type: 'skip-waiting' }); };
}

export function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    try { if (localStorage.getItem('ssp.installDismissed')) return; } catch (_) { /* */ }
    $('#install-bar').classList.remove('hidden');
  });
  $('#btn-install').onclick = async () => {
    $('#install-bar').classList.add('hidden');
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const r = await deferredPrompt.userChoice.catch(() => null);
    deferredPrompt = null;
    if (r && r.outcome === 'accepted') toast(t('pwa.installed'), 'ok');
  };
  $('#btn-install-x').onclick = () => { $('#install-bar').classList.add('hidden'); try { localStorage.setItem('ssp.installDismissed', '1'); } catch (_) { /* */ } };
  window.addEventListener('appinstalled', () => { $('#install-bar').classList.add('hidden'); });
}

export const canInstall = () => !!deferredPrompt;
export async function promptInstall() { if (deferredPrompt) $('#btn-install').click(); else toast(isIOS() ? t('pwa.iosHint') : t('pwa.installManual'), 'info', { ms: 9000 }); }
export const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function swMessage(msg, timeout = 8000) {
  return new Promise((res) => {
    const c = navigator.serviceWorker?.controller;
    if (!c) { res(null); return; }
    const ch = new MessageChannel();
    const tm = setTimeout(() => res(null), timeout);
    ch.port1.onmessage = (e) => { clearTimeout(tm); res(e.data); };
    c.postMessage(msg, [ch.port2]);
  });
}
export const swInfo = () => swMessage({ type: 'status' }, 15000);
