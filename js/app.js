// Ultimate Smart Scanner Pro — application bootstrap and workspace wiring.
import { $, $$, h, icon, bus, debounce, fmtBytes, fmtDate, downloadBlob, safeName, isArabicDominant, normalizeText, clamp, lsGet, lsSet, PAGE_SIZES } from './util.js';
import { t, setLang, getLang, applyI18n } from './i18n.js';
import * as db from './database.js';
import { loadSettings, settings, allSettings, resetSettings } from './settings.js';
import { toast, errorToast, modal, confirmDialog, promptDialog, choiceDialog, showMenu, setBusy, Progress } from './ui.js';
import { cvInit, cvRun } from './cv-client.js';
import {
  state, currentPage, pageById, pageIndex, createDoc, openDoc, closeDoc, saveDoc, addPages, updatePage, updatePages, deletePages,
  duplicatePages, movePages, splitDocAt, extractToNewDoc, replaceOriginal, selectedPages, scopePages, persistSession, listDocs, updateDocMeta,
} from './project.js';
import { undo, redo, canUndo, canRedo, peekUndo, peekRedo, clearHistory } from './history.js';
import { renderPreview, ensureProcessed, ensureThumb, getPreviewSource, editState, dropSourceCache } from './render.js';
import { Viewer } from './viewer.js';
import { openCropper } from './perspective.js';
import { detectBitmap, detectMultiBitmap, renderDetectInfo, minConfidence } from './detection.js';
import { initEnhancement, renderPresetButtons, loadCustomPresets, presetParams, PRESETS, applyPreset, refreshPresetThumbs } from './enhancement.js';
import { openScanner, initScannerUI, buildItems, isScanning } from './scanner.js';
import { importPdfFile, openPdfTools } from './pdf-manager.js';
import { openExportDialog, openImageExportDialog, buildPdf, defaultExportOptions, shareFiles, quickSearchablePdf } from './pdf-export.js';
import { ocrPage, saveEditedText, langAvailability, OCR_LANGS, ocrStatus, terminateOcr } from './ocr.js';
import { initArchive, renderLibrary, editDocProperties, catLabel, categories } from './archive.js';
import { storageInfo, requestPersistence, downloadBackup, restoreBackup, clearCaches, deleteAllData, blobsUsage } from './storage.js';
import { openPrintDialog } from './print.js';
import { runBatch } from './batch.js';
import { openScannerPanel } from './bridge.js';
import { openDiagnostics } from './diagnostics.js';
import { registerSW, initInstallPrompt, promptInstall, swInfo } from './pwa.js';
import { APP_VERSION } from './version.js';
import { decode, imageSize, makeCanvas, canvasToBlob, blankImageBlob } from './image-io.js';
import { libJSZip } from './util.js';

let viewer;
let compare = false;
let showBoxes = false;
let overrideState = null;

/* =================== boot =================== */
async function boot() {
  await loadSettings();
  setLang(settings.lang || 'ar');
  applyTheme();
  applyI18n();
  try { await db.openDB(); } catch (e) { errorToast(new Error(t('err.noIdb') + ' — ' + e.message)); }
  viewer = new Viewer($('#viewer'), $('#viewer-canvas'));
  initHeader(); initWorkspace(); initScannerUI(); initEnhancement(); initOcrPanel(); initPagePanel(); initGeometry(); initDetectPanel(); initExportPanel();
  initArchive({ onOpen: openDocument, onExportDoc: exportDocsFromLibrary });
  initDnD(); initShortcuts(); initStatus(); initInstallPrompt();
  await loadCustomPresets();
  await renderPresetButtons();
  bus.on('lang', () => { applyI18n(); renderPresetButtons(); renderThumbs(); updateStatus(); renderOcrPanel(); renderPageInfo(); renderLangs(); });
  registerSW();
  cvInit().catch((e) => toast(t('err.opencv') + ': ' + e.message, 'bad'));
  await renderLibrary();
  await restoreSession();
  launchQueueHandler();
  checkStorageWarnings();
}

function applyTheme() {
  const th = settings.theme === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : settings.theme;
  document.documentElement.dataset.theme = th;
  document.querySelector('meta[name="theme-color"]').content = th === 'light' ? '#ffffff' : '#0f1420';
}

async function restoreSession() {
  let s = null;
  try { s = await db.kvGet('session'); } catch (_) { /* */ }
  if (!s || !s.docId) { setView('library'); return; }
  const doc = await db.get('docs', s.docId).catch(() => null);
  if (!doc || doc.deleted) { setView('library'); return; }
  await openDocument(doc.id, { pageId: s.pageId, silent: true });
  toast(t('session.restored', { title: doc.title }), 'info', { action: { label: t('nav.library'), fn: () => goLibrary() } });
}

/* =================== views =================== */
function setView(v) {
  $('#app').dataset.view = v;
  $$('.bottomnav [data-nav]').forEach((b) => b.classList.toggle('active', (v === 'library' && b.dataset.nav === 'library')));
  closeSheets();
  if (v === 'library') renderLibrary();
  else requestAnimationFrame(() => viewer.resize());
}

async function goLibrary() {
  if (state.doc) await saveDoc().catch(() => {});
  closeDoc(); clearHistory();
  await db.kvSet('session', { docId: null }).catch(() => {});
  setView('library');
}

async function openDocument(id, { pageId, silent } = {}) {
  try {
    await openDoc(id);
    clearHistory();
    if (pageId) { const i = pageIndex(pageId); if (i >= 0) state.cur = i; }
    setView('workspace');
    renderAll();
    persistSession();
    // pages without an up-to-date render are processed in the background
    state.pages.forEach((p) => { if (!p.procId || p.procRev !== p.rev) bus.emit('page-changed', p, { rerender: true }); });
  } catch (e) { errorToast(e); if (!silent) setView('library'); }
}

async function newDocument({ scan = false } = {}) {
  if (state.doc) await saveDoc().catch(() => {});
  const doc = await createDoc();
  await openDocument(doc.id);
  if (scan) startCamera();
  return doc;
}

async function ensureDoc() { if (!state.doc) await newDocument(); }

function renderAll() {
  $('#doc-title-text').textContent = state.doc ? state.doc.title : '';
  renderThumbs(); showCurrent(); updateStatus(); renderOcrPanel(); renderPageInfo(); renderDetect();
  bus.emit('current-changed');
}

/* =================== header =================== */
function initHeader() {
  $('#btn-home').onclick = goLibrary;
  $('#btn-new').onclick = () => newDocument();
  $('#btn-open').onclick = () => $('#file-project').click();
  $('#btn-save').onclick = saveProjectFile;
  $('#btn-undo').onclick = doUndo; $('#btn-redo').onclick = doRedo;
  $('#btn-scanner').onclick = openPhysicalScanner;
  $('#btn-pdftools').onclick = pdfTools;
  $('#btn-settings').onclick = openSettings;
  $('#btn-lang').onclick = () => { settings.lang = getLang() === 'ar' ? 'en' : 'ar'; setLang(settings.lang); };
  $('#btn-help').onclick = openHelp;
  $('#btn-doc-title').onclick = async () => { if (state.doc) { await editDocProperties(state.doc); const d = await db.get('docs', state.doc.id); Object.assign(state.doc, d); $('#doc-title-text').textContent = state.doc.title; } };
  $('#btn-more').onclick = (e) => showMenu(e.currentTarget, [
    { icon: 'library', label: t('nav.library'), fn: goLibrary },
    { icon: 'file-plus', label: t('act.newSession'), fn: () => newDocument() },
    { icon: 'folder-open', label: t('act.openProject'), fn: () => $('#file-project').click() },
    { icon: 'save', label: t('act.saveProject'), fn: saveProjectFile, hidden: !state.doc },
    '-',
    { icon: 'printer-check', label: t('scanner.title'), fn: openPhysicalScanner },
    { icon: 'file-stack', label: t('pdftools.title'), fn: pdfTools },
    { icon: 'settings', label: t('nav.settings'), fn: openSettings },
    { icon: 'activity', label: t('diag.title'), fn: openDiagnostics },
    { icon: 'languages', label: getLang() === 'ar' ? 'English' : 'العربية', fn: () => { settings.lang = getLang() === 'ar' ? 'en' : 'ar'; setLang(settings.lang); } },
    { icon: 'circle-help', label: t('nav.help'), fn: openHelp },
    { icon: 'smartphone', label: t('pwa.install'), fn: promptInstall },
  ]);
  $('#hero-scan').onclick = () => newDocument({ scan: true });
  $('#hero-import').onclick = () => { $('#file-any').dataset.newdoc = '1'; $('#file-any').click(); };
  $('#hero-scanner').onclick = openPhysicalScanner;
  $('#hero-pdftools').onclick = pdfTools;
  $('#ws-scan').onclick = startCamera;
  $('#ws-import').onclick = () => $('#file-any').click();
  $('#file-any').onchange = async (e) => {
    const files = [...e.target.files]; const nd = e.target.dataset.newdoc; e.target.value = ''; delete e.target.dataset.newdoc;
    if (nd && state.doc) await goLibrary();
    await handleFiles(files);
  };
  $('#file-capture').onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; await handleFiles(f, { mode: 'document' }); };
  $('#file-project').onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; await openProjectFiles(f); };
  bus.on('history', () => {
    $('#btn-undo').disabled = !canUndo(); $('#btn-redo').disabled = !canRedo();
    $('#btn-undo').title = t('act.undo') + (peekUndo() ? ': ' + peekUndo() : '');
    $('#btn-redo').title = t('act.redo') + (peekRedo() ? ': ' + peekRedo() : '');
  });
  $$('.bottomnav [data-nav]').forEach((b) => { b.onclick = () => bottomNav(b.dataset.nav); });
  const grip = $('#panel-grip'); grip.onclick = () => $('#panel').classList.toggle('expanded');
}

async function doUndo() { const l = await undo(); if (l) { afterHistory(); toast(t('act.undone') + ': ' + l, 'info', { ms: 1800 }); } }
async function doRedo() { const l = await redo(); if (l) { afterHistory(); toast(t('act.redone') + ': ' + l, 'info', { ms: 1800 }); } }
function afterHistory() { renderThumbs(); showCurrent(); updateStatus(); bus.emit('current-changed'); }

function bottomNav(n) {
  if (n === 'library') { goLibrary(); return; }
  if (n === 'scan') { startCamera(); return; }
  if (!state.doc) { toast(t('ws.noDoc'), 'info'); return; }
  if ($('#app').dataset.view !== 'workspace') setView('workspace');
  const app = $('#app');
  const cls = n === 'pages' ? 'sheet-pages' : 'sheet-edit';
  const was = app.classList.contains(cls);
  closeSheets();
  if (n === 'export') { activateTab('export'); app.classList.add('sheet-edit'); }
  else if (!was) app.classList.add(cls);
  $$('.bottomnav [data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === n && app.classList.contains(cls === 'sheet-pages' && n === 'pages' ? 'sheet-pages' : 'sheet-edit')));
}
function closeSheets() { $('#app').classList.remove('sheet-pages', 'sheet-edit'); }

/* =================== file handling =================== */
async function handleFiles(files, { mode = 'document' } = {}) {
  files = files.filter(Boolean);
  if (!files.length) return;
  const zips = files.filter((f) => /\.(zip|sspz)$/i.test(f.name) || f.type === 'application/zip');
  if (zips.length) { await openProjectFiles(zips); files = files.filter((f) => !zips.includes(f)); if (!files.length) return; }
  await ensureDoc();
  const startCount = state.pages.length;
  for (const f of files) {
    try {
      if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) {
        const items = await importPdfFile(f);
        if (items && items.length) await addItems(items, { detect: false });
      } else if (f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i.test(f.name)) {
        const prog = files.length > 1 ? null : null;
        setBusy(true);
        try {
          const items = settings.autoCropOnImport ? await buildItems(f, mode) : [{ blob: f, ...(await imageSize(f)), corners: null, preset: settings.defaultPreset, source: 'import' }];
          items.forEach((it) => { it.source = 'import'; it.label = f.name.replace(/\.[^.]+$/, ''); });
          await addItems(items);
        } finally { setBusy(false); void prog; }
      } else toast(t('err.unsupportedFile', { name: f.name }), 'warn');
    } catch (e) { errorToast(e, f.name); }
  }
  const added = state.pages.length - startCount;
  if (added > 0) {
    toast(t('ws.added', { n: added }), 'ok');
    if (settings.autoOcr) autoOcr(state.pages.slice(startCount));
  }
}

/** Adds captured/imported items as pages, applying default preset + default brightness/contrast. */
async function addItems(items, { detect = true } = {}) {
  void detect;
  const list = items.map((it) => {
    const pre = it.preset !== undefined ? it.preset : (it.source === 'pdf' ? 'original' : settings.defaultPreset);
    const params = { ...(presetParams(pre) || {}) };
    if (settings.defaultBrightness) params.brightness = (params.brightness || 0) + settings.defaultBrightness;
    if (settings.defaultContrast) params.contrast = (params.contrast || 0) + settings.defaultContrast;
    return { ...it, params, preset: pre };
  });
  const created = await addPages(list, state.pages.length);
  state.cur = pageIndex(created[0].id);
  renderAll();
  return created;
}

async function openProjectFiles(files) {
  for (const f of files) {
    if (/\.(zip|sspz)$/i.test(f.name) || f.type === 'application/zip') {
      const prog = new Progress(t('backup.restoring'), { cancellable: false });
      try {
        const r = await restoreBackup(f, { asCopy: true, onProgress: (x) => prog.set(x) });
        prog.close();
        toast(t('backup.imported', { docs: r.docs.length, pages: r.pages }), 'ok');
        if (r.docs.length === 1) await openDocument(r.docs[0]); else { setView('library'); }
      } catch (e) { prog.close(); errorToast(e, f.name); }
    } else { if (state.doc) await goLibrary(); await handleFiles([f]); }
  }
}

async function saveProjectFile() {
  if (!state.doc) { toast(t('ws.noDoc'), 'info'); return; }
  await saveDoc();
  const prog = new Progress(t('backup.creating'), { cancellable: false });
  try { const n = await downloadBackup([state.doc.id], state.doc.title, { onProgress: (x) => prog.set(x) }); toast(t('backup.projectSaved', { size: fmtBytes(n) }), 'ok'); }
  catch (e) { errorToast(e); } finally { prog.close(); }
}

function initDnD() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth++; document.body.classList.add('dropping'); } });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dropping'); });
  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
    await handleFiles([...e.dataTransfer.files]);
  });
  window.addEventListener('paste', async (e) => {
    if (e.target.closest && e.target.closest('input, textarea')) return;
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (files.length) { e.preventDefault(); await handleFiles(files); }
  });
}

function launchQueueHandler() {
  if (!('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((fh) => fh.getFile()));
    await handleFiles(files);
  });
}

/* =================== camera =================== */
async function startCamera({ replace = null, mode } = {}) {
  if (isScanning()) return;
  if (!replace) await ensureDoc();
  const created = [];
  openScanner({
    single: !!replace,
    mode: mode || (replace ? 'document' : 'document'),
    onCapture: async (items) => {
      if (replace) {
        const it = items[0];
        await replaceOriginal(replace, it.blob, it.width, it.height, { source: 'camera' });
        if (it.corners) await updatePage(replace, { corners: it.corners, detect: it.detect }, { history: false });
        dropSourceCache(replace.id);
        return;
      }
      const c = await addItems(items);
      created.push(...c);
    },
    onClose: (n) => {
      if (n) { setView('workspace'); renderAll(); toast(t('cam.addedPages', { n }), 'ok'); if (settings.autoOcr && created.length) autoOcr(created); }
    },
  });
}

bus.on('idcard-pair', () => {
  toast(t('id.pairReady'), 'info', { ms: 9000, action: { label: t('page.idCombine'), fn: () => combineIdCard(state.pages.slice(-2)) } });
});

async function openPhysicalScanner() {
  await openScannerPanel(async (items) => { await ensureDoc(); setView('workspace'); await addItems(items.map((i) => ({ ...i, preset: 'original' }))); });
}

async function pdfTools() {
  const r = await openPdfTools();
  if (r && r.items && r.items.length) { await ensureDoc(); setView('workspace'); await addItems(r.items.map((i) => ({ ...i, preset: 'original' }))); }
}

/* =================== workspace: thumbnails =================== */
const thumbUrls = new Map();
function thumbSrc(p, img) {
  const key = p.thumbId + ':' + p.procRev;
  if (img.dataset.key === key) return;
  img.dataset.key = key;
  const load = p.thumbId && p.procRev === p.rev ? db.getBlob(p.thumbId) : ensureThumb(p).catch(() => null);
  load.then((b) => {
    if (!b) return;
    const old = thumbUrls.get(p.id); if (old) setTimeout(() => URL.revokeObjectURL(old), 10000); // other views may still be loading it
    const u = URL.createObjectURL(b); thumbUrls.set(p.id, u); img.src = u;
    const fs = $(`#filmstrip [data-id="${p.id}"]`); if (fs) fs.style.backgroundImage = `url("${u}")`;
  });
}

function pageStatusDots(p) {
  const s = h('span', { class: 'tstat' });
  const proc = p.procId && p.procRev === p.rev;
  s.append(h('i', { class: 'dot ' + (proc ? 'ok' : 'busy'), title: proc ? t('status.processed') : t('status.processing') }));
  const o = ocrStatus(p);
  if (o !== 'none') s.append(h('i', { class: 'dot ' + (o === 'ok' ? 'ok' : 'warn'), title: o === 'ok' ? t('status.ocrOk') : t('status.ocrStale') }), h('small', {}, 'T'));
  return s;
}

function renderThumbs() {
  const ol = $('#thumbs'); ol.innerHTML = '';
  const fs = $('#filmstrip'); fs.innerHTML = '';
  state.pages.forEach((p, i) => {
    const img = h('img', { alt: '', loading: 'lazy', draggable: 'false' });
    const chk = h('input', { type: 'checkbox', class: 'tcheck', checked: state.selected.has(p.id), 'aria-label': t('act.select') });
    chk.onclick = (e) => { e.stopPropagation(); toggleSel(p.id, chk.checked); };
    const grip = h('span', { class: 'tgrip', title: t('pages.drag') }, icon('grip-vertical'));
    const li = h('li', { class: 'thumb' + (i === state.cur ? ' current' : '') + (state.selected.has(p.id) ? ' selected' : ''), dataset: { id: p.id }, draggable: 'true', tabindex: '0' },
      chk, grip, img, h('div', { class: 'tmeta' }, h('span', { class: 'tnum' }, String(i + 1)), h('span', { class: 'tlabel' }, p.label || ''), pageStatusDots(p)));
    li.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) { toggleSel(p.id, !state.selected.has(p.id)); return; }
      if (e.shiftKey && state.pages[state.cur]) { const a = Math.min(i, state.cur), b = Math.max(i, state.cur); for (let k = a; k <= b; k++) state.selected.add(state.pages[k].id); renderThumbs(); return; }
      setCurrent(i);
      if (matchMedia('(max-width: 699px)').matches) closeSheets();
    };
    li.oncontextmenu = (e) => { e.preventDefault(); thumbMenu(e, p); };
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCurrent(i); } });
    // HTML5 drag & drop (mouse)
    li.ondragstart = (e) => { li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-page', p.id); };
    li.ondragend = () => li.classList.remove('dragging');
    li.ondragover = (e) => { if (!e.dataTransfer.types.includes('text/x-page')) return; e.preventDefault(); const r = li.getBoundingClientRect(); const after = e.clientY > r.top + r.height / 2; li.classList.toggle('drop-after', after); li.classList.toggle('drop-before', !after); };
    li.ondragleave = () => li.classList.remove('drop-after', 'drop-before');
    li.ondrop = (e) => {
      const id = e.dataTransfer.getData('text/x-page'); if (!id) return;
      e.preventDefault(); e.stopPropagation();
      const after = li.classList.contains('drop-after'); li.classList.remove('drop-after', 'drop-before');
      const ids = state.selected.has(id) ? state.pages.filter((x) => state.selected.has(x.id)).map((x) => x.id) : [id];
      dropAt(ids, p.id, after);
    };
    // touch reordering via grip
    grip.addEventListener('pointerdown', (e) => touchDrag(e, p, li));
    ol.append(li);
    thumbSrc(p, img);
    const fb = h('button', { class: i === state.cur ? 'current' : '', dataset: { id: p.id }, onclick: () => setCurrent(i) }, h('span', {}, String(i + 1)));
    const u = thumbUrls.get(p.id); if (u) fb.style.backgroundImage = `url("${u}")`;
    fs.append(fb);
  });
  fs.append(h('button', { class: 'add', 'aria-label': t('pages.add'), onclick: (e) => addMenu(e.currentTarget) }, icon('plus')));
  const sel = state.selected.size;
  $('#sel-info').textContent = sel ? t('pages.selected', { n: sel }) : t('pages.count', { n: state.pages.length });
  $('#viewer-empty').classList.toggle('hidden', state.pages.length > 0);
  const cur = ol.querySelector('.current'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  const fcur = fs.querySelector('.current'); if (fcur) fcur.scrollIntoView({ inline: 'nearest', block: 'nearest' });
}

function dropAt(ids, targetId, after) {
  const rest = state.pages.filter((x) => !ids.includes(x.id));
  let to = rest.findIndex((x) => x.id === targetId);
  if (to < 0) return;
  if (after) to++;
  movePages(ids, to).then(() => { renderThumbs(); updateStatus(); });
}

function touchDrag(e, p, li) {
  e.preventDefault(); e.stopPropagation();
  const ol = $('#thumbs');
  li.classList.add('dragging');
  let target = null; let after = false;
  const move = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.thumb');
    $$('.thumb', ol).forEach((x) => x.classList.remove('drop-after', 'drop-before'));
    if (el && el !== li) {
      const r = el.getBoundingClientRect();
      after = ol.clientWidth > r.width * 1.6 ? ev.clientX > r.left + r.width / 2 === (document.dir !== 'rtl') : ev.clientY > r.top + r.height / 2;
      el.classList.add(after ? 'drop-after' : 'drop-before'); target = el.dataset.id;
    } else target = null;
    const r = ol.getBoundingClientRect();
    if (ev.clientY < r.top + 40) ol.scrollTop -= 12; else if (ev.clientY > r.bottom - 40) ol.scrollTop += 12;
  };
  const up = () => {
    document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', up);
    li.classList.remove('dragging'); $$('.thumb', ol).forEach((x) => x.classList.remove('drop-after', 'drop-before'));
    if (target) dropAt(state.selected.has(p.id) ? state.pages.filter((x) => state.selected.has(x.id)).map((x) => x.id) : [p.id], target, after);
  };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', up);
}

function toggleSel(id, on) { on ? state.selected.add(id) : state.selected.delete(id); renderThumbs(); }

function thumbMenu(e, p) {
  const i = pageIndex(p.id);
  showMenu({ x: e.clientX, y: e.clientY, getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY }) }, [
    { icon: 'copy', label: t('pages.duplicate'), fn: () => duplicatePages([p.id]).then(renderAll) },
    { icon: 'rotate-cw', label: t('geo.right'), fn: () => rotatePages([p], 90) },
    { icon: 'chevron-up', label: t('view.moveUp'), disabled: i === 0, fn: () => movePages([p.id], i - 1).then(renderAll) },
    { icon: 'chevron-down', label: t('view.moveDown'), disabled: i === state.pages.length - 1, fn: () => movePages([p.id], i + 1).then(renderAll) },
    { icon: 'image-plus', label: t('page.replace'), fn: () => { setCurrent(i); $('#p-replace').click(); } },
    { icon: 'file-plus', label: t('pages.blankAfter'), fn: () => insertBlank(i + 1) },
    { icon: 'scissors', label: t('page.splitHere'), disabled: i === 0, fn: () => splitHere(i) },
    '-',
    { icon: 'trash-2', label: t('pages.delete'), danger: true, fn: () => removePages([p.id]) },
  ]);
}

function addMenu(anchor) {
  showMenu(anchor, [
    { icon: 'camera', label: t('act.scanCamera'), fn: startCamera },
    { icon: 'image-plus', label: t('act.importFiles'), fn: () => $('#file-any').click() },
    { icon: 'smartphone', label: t('act.systemCamera'), fn: () => $('#file-capture').click() },
    { icon: 'printer-check', label: t('act.physicalScanner'), fn: openPhysicalScanner },
    { icon: 'file-plus', label: t('pages.blank'), fn: () => insertBlank(state.cur + 1) },
  ]);
}

/* =================== current page & viewer =================== */
function setCurrent(i) {
  if (!state.pages.length) return;
  state.cur = clamp(i, 0, state.pages.length - 1);
  overrideState = null;
  renderThumbs(); showCurrent(); updateStatus(); renderOcrPanel(); renderPageInfo(); renderDetect();
  bus.emit('current-changed');
  persistSession();
}

let showGen = 0;
async function showCurrent() {
  const p = currentPage();
  $('#page-ind').textContent = state.pages.length ? `${state.cur + 1} / ${state.pages.length}` : '';
  if (!p) { viewer.clear(); return; }
  const g = ++showGen;
  setBusy(true);
  try {
    const r = await renderPreview(p, { wantBase: compare, override: overrideState });
    if (!r || g !== showGen) return;
    viewer.boxes = p.ocr && p.ocr.words ? { words: p.ocr.words, w: p.procW && p.ocr.w ? p.ocr.w : p.procW } : null;
    viewer.setImage(r.out, r.base, p.procW || r.out.width, p.procH || r.out.height);
  } catch (e) { if (g === showGen) errorToast(e, t('err.render')); }
  finally { if (g === showGen) setBusy(false); }
}

function initWorkspace() {
  $('#z-in').onclick = () => viewer.zoomBy(1.25);
  $('#z-out').onclick = () => viewer.zoomBy(0.8);
  $('#z-fit').onclick = () => viewer.fitView();
  $('#z-100').onclick = () => viewer.actualSize();
  $('#z-full').onclick = () => { const el = $('#stage'); if (document.fullscreenElement) document.exitFullscreen(); else if (el.requestFullscreen) el.requestFullscreen().catch(() => toast(t('err.fullscreen'), 'warn')); else toast(t('err.fullscreen'), 'warn'); };
  $('#v-compare').onclick = () => toggleCompare();
  $('#c-compare').onclick = () => toggleCompare();
  $('#v-crop').onclick = editCorners;
  $('#v-ocrboxes').onclick = () => { showBoxes = !showBoxes; $('#v-ocrboxes').classList.toggle('on', showBoxes); viewer.showBoxes = showBoxes; if (showBoxes && !currentPage()?.ocr) toast(t('ocr.noResultYet'), 'info'); viewer.draw(); };
  $('#v-prev').onclick = () => setCurrent(state.cur - 1);
  $('#v-next').onclick = () => setCurrent(state.cur + 1);
  bus.on('swipe', (d) => setCurrent(state.cur + d));
  bus.on('zoom', (z) => { const v = z ? Math.round(z * 100) + '%' : '—'; $('#zoom-val').textContent = v; $('#st-zoom').textContent = t('status.zoom') + ' ' + v; });
  bus.on('preview-override', (o) => { overrideState = o; showCurrent(); });
  bus.on('page-changed', (p) => { if (p === currentPage()) { overrideState = null; showCurrent(); renderPageInfo(); renderOcrPanel(); } refreshThumb(p); });
  bus.on('page-rendered', (p) => { refreshThumb(p); if (p === currentPage()) { renderPageInfo(); updateStatus(); } });
  bus.on('pages-changed', () => { renderThumbs(); if (!state.pages.length) viewer.clear(); showCurrent(); updateStatus(); renderPageInfo(); renderOcrPanel(); });
  bus.on('doc-saved', (d) => { $('#doc-title-text').textContent = d.title; });
  $$('.panel-tabs [data-tab]').forEach((b) => { b.onclick = () => activateTab(b.dataset.tab); });
  activateTab(lsGet('ssp.tab', 'enhance'));
  document.addEventListener('fullscreenchange', () => setTimeout(() => viewer.resize(), 100));

  $('#pg-add').onclick = (e) => addMenu(e.currentTarget);
  $('#pg-dup').onclick = () => { const ids = selectedPages().map((p) => p.id); if (ids.length) duplicatePages(ids).then(renderAll); };
  $('#pg-rot').onclick = () => rotatePages(selectedPages(), 90);
  $('#pg-blank').onclick = () => insertBlank(state.cur + 1);
  $('#pg-selall').onclick = () => { if (state.selected.size === state.pages.length) state.selected.clear(); else state.pages.forEach((p) => state.selected.add(p.id)); renderThumbs(); };
  $('#pg-del').onclick = () => removePages(selectedPages().map((p) => p.id));
  $('#pg-more').onclick = (e) => showMenu(e.currentTarget, [
    { icon: 'chevron-up', label: t('view.moveUp'), fn: () => moveSelected(-1) },
    { icon: 'chevron-down', label: t('view.moveDown'), fn: () => moveSelected(1) },
    { icon: 'rotate-ccw', label: t('geo.left'), fn: () => rotatePages(selectedPages(), -90) },
    '-',
    { icon: 'wand-sparkles', label: t('batch.enhance'), fn: batchEnhance },
    { icon: 'eraser', label: t('batch.shadow'), fn: () => batchParams(t('batch.shadow'), { bgClean: 100, whiten: 40, textPreserve: 25 }) },
    { icon: 'ruler', label: t('batch.deskew'), fn: () => batchDeskew(selectedPagesOrAll()) },
    { icon: 'scan-text', label: t('ocr.batch'), fn: () => batchOcr(selectedPagesOrAll()) },
    { icon: 'refresh-cw', label: t('batch.render'), fn: batchRender },
    '-',
    { icon: 'split', label: t('page.extract'), fn: extractSelected },
    { icon: 'scissors', label: t('page.splitHere'), fn: () => splitHere(state.cur) },
    { icon: 'list-checks', label: t('pages.selectNone'), fn: () => { state.selected.clear(); renderThumbs(); } },
  ]);
}

function selectedPagesOrAll() { return state.selected.size ? selectedPages() : state.pages.slice(); }

function refreshThumb(p) {
  const li = $(`#thumbs [data-id="${p.id}"]`);
  if (!li) return;
  thumbSrc(p, li.querySelector('img'));
  const st = li.querySelector('.tstat'); if (st) st.replaceWith(pageStatusDots(p));
}

function activateTab(name) {
  $$('.panel-tabs [data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tabpane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  lsSet('ssp.tab', name);
  if (name === 'ocr') renderLangs();
}

function toggleCompare() {
  compare = !compare;
  viewer.compare = compare;
  $('#v-compare').classList.toggle('on', compare);
  showCurrent();
}

async function removePages(ids) {
  if (!ids.length) return;
  if (ids.length > 1 && !(await confirmDialog(t('pages.confirmDelete', { n: ids.length }), { danger: true, okText: t('act.delete') }))) return;
  await deletePages(ids);
  ids.forEach((id) => dropSourceCache(id));
  renderAll();
  toast(t('pages.deleted', { n: ids.length }), 'ok', { action: { label: t('act.undo'), fn: doUndo } });
}

async function rotatePages(pages, deg) {
  if (!pages.length) return;
  const f = (p) => ({ rotation: (((p.rotation || 0) + deg) % 360 + 360) % 360 });
  if (pages.length === 1) await updatePage(pages[0], f(pages[0]), { label: t('hist.rotate') }); else await updatePages(pages, f, { label: t('hist.rotate') });
}

async function moveSelected(d) {
  const ids = selectedPages().map((p) => p.id);
  const first = Math.min(...ids.map(pageIndex));
  await movePages(ids, Math.max(0, first + d));
  renderAll();
}

async function insertBlank(at) {
  await ensureDoc();
  const size = await choiceDialog(t('pages.blank'), Object.keys(PAGE_SIZES).map((k) => ({ value: k, label: k, primary: k === 'A4' })));
  if (!size) return;
  const [wmm, hmm] = PAGE_SIZES[size];
  const dpi = 150; const w = Math.round(wmm / 25.4 * dpi), hh = Math.round(hmm / 25.4 * dpi);
  const blob = await blankImageBlob(w, hh);
  const c = await addPages([{ blob, width: w, height: hh, source: 'blank', dpi, label: t('pages.blankLabel'), pdfSize: { w: wmm * 72 / 25.4, h: hmm * 72 / 25.4 } }], at);
  state.cur = pageIndex(c[0].id); renderAll();
}

async function splitHere(i) {
  if (i <= 0) { toast(t('err.splitRange'), 'warn'); return; }
  if (!(await confirmDialog(t('page.splitConfirm', { n: i + 1 })))) return;
  const nd = await splitDocAt(i);
  clearHistory(); renderAll();
  toast(t('page.splitDone'), 'ok', { action: { label: t('act.open'), fn: () => openDocument(nd.id) } });
}

async function extractSelected() {
  const ids = selectedPages().map((p) => p.id);
  if (!ids.length) return;
  const nd = await extractToNewDoc(ids);
  toast(t('page.extractDone', { n: ids.length }), 'ok', { action: { label: t('act.open'), fn: () => openDocument(nd.id) } });
}

/* =================== detect & crop =================== */
function initDetectPanel() {
  $('#d-auto').onclick = () => autoDetect(currentPage());
  $('#d-edit').onclick = editCorners;
  $('#d-reset').onclick = async () => { const p = currentPage(); if (p) await updatePage(p, { corners: null }, { label: t('hist.crop') }); };
  $('#d-multi').onclick = multiDetect;
  $$('[data-setting]').forEach((inp) => {
    const k = inp.dataset.setting; const out = inp.parentElement.querySelector('output');
    const show = () => { if (out) out.value = k === 'detectEdgeThreshold' && !+inp.value ? t('p.auto') : inp.value; };
    inp.value = settings[k]; show();
    inp.oninput = show; inp.onchange = () => { settings[k] = +inp.value; };
  });
}

function renderDetect() { renderDetectInfo($('#d-info'), currentPage()?.detect || null); }

async function autoDetect(p) {
  if (!p) return;
  setBusy(true);
  try {
    const src = await getPreviewSource(p);
    const r = await detectBitmap(src);
    p.detect = r;
    if (r.found && r.confidence >= minConfidence()) {
      await updatePage(p, { corners: r.corners, detect: r }, { label: t('hist.crop') });
      toast(t('detect.applied', { c: Math.round(r.confidence * 100) }), 'ok');
    } else {
      await updatePage(p, { detect: r }, { history: false, rerender: false });
      toast(r.found ? t('detect.lowConfidence', { c: Math.round(r.confidence * 100) }) : t('detect.notFound'), 'warn');
      if (r.found) editCorners(r.corners, r.confidence);
    }
    renderDetect();
  } catch (e) { errorToast(e); } finally { setBusy(false); }
}

async function editCorners(suggest, conf) {
  const p = currentPage(); if (!p) return;
  const bmp = await getPreviewSource(p);
  const res = await openCropper({
    bitmap: bmp, corners: Array.isArray(suggest) ? suggest : p.corners, origW: p.origW, origH: p.origH,
    confidence: typeof conf === 'number' ? conf : p.detect?.confidence,
    detect: async () => { const r = await detectBitmap(bmp); return r; },
  });
  if (!res) return;
  const patch = { corners: res.corners };
  if (res.rotate) patch.rotation = ((p.rotation || 0) + res.rotate) % 360;
  await updatePage(p, patch, { label: t('hist.crop') });
}

async function multiDetect() {
  const p = currentPage(); if (!p) return;
  setBusy(true);
  try {
    const r = await detectMultiBitmap(await getPreviewSource(p));
    if (!r.docs.length) { toast(t('detect.multiNone'), 'warn'); return; }
    if (!(await confirmDialog(t('detect.multiFound', { n: r.docs.length })))) return;
    const blob = await db.getBlob(p.origId);
    const items = r.docs.map((d, i) => ({ blob, width: p.origW, height: p.origH, corners: d.corners, detect: { found: true, ...d }, params: { ...p.params }, preset: p.preset, source: p.source, label: (p.label || '') + ` #${i + 1}` }));
    const at = state.cur + 1;
    await addPages(items, at);
    renderAll();
    toast(t('ws.added', { n: items.length }), 'ok');
  } catch (e) { errorToast(e); } finally { setBusy(false); }
}

/* =================== geometry =================== */
function initGeometry() {
  $('#g-left').onclick = () => rotatePages([currentPage()].filter(Boolean), -90);
  $('#g-right').onclick = () => rotatePages([currentPage()].filter(Boolean), 90);
  $('#g-fliph').onclick = () => { const p = currentPage(); if (p) updatePage(p, { flipH: !p.flipH }, { label: t('hist.flip') }); };
  $('#g-flipv').onclick = () => { const p = currentPage(); if (p) updatePage(p, { flipV: !p.flipV }, { label: t('hist.flip') }); };
  const ang = $('#g-angle'); const out = ang.parentElement.querySelector('output');
  ang.oninput = () => { out.value = (+ang.value).toFixed(1) + '°'; const p = currentPage(); if (p) bus.emit('preview-override', { angle: +ang.value }); };
  ang.onchange = () => { const p = currentPage(); if (p) updatePage(p, { angle: +ang.value }, { label: t('hist.angle') }); };
  ang.ondblclick = () => { ang.value = 0; ang.dispatchEvent(new Event('input')); ang.dispatchEvent(new Event('change')); };
  $('#g-auto').onclick = async () => { const p = currentPage(); if (p) await deskewPage(p, true); };
  $('#g-orient').onclick = async () => {
    const p = currentPage(); if (!p) return;
    setBusy(true);
    try {
      const src = await getPreviewSource(p);
      const r = await cvRun('orientation', { image: bmpData(src), state: editState(p) });
      if (r.rotate) { await updatePage(p, { rotation: ((p.rotation || 0) + r.rotate) % 360 }, { label: t('hist.rotate') }); toast(t('geo.orientFixed'), 'ok'); }
      else toast(t('geo.orientOk'), 'info');
    } catch (e) { errorToast(e); } finally { setBusy(false); }
  };
  $('#g-reset').onclick = () => { const p = currentPage(); if (p) updatePage(p, { rotation: 0, angle: 0, flipH: false, flipV: false }, { label: t('hist.reset') }); };
  $('#g-book').onclick = bookSplit;
  $('#g-apply-auto').onclick = () => batchDeskew(scopePages($('#g-scope').value));
  bus.on('current-changed', syncAngle); bus.on('page-changed', (p) => { if (p === currentPage()) syncAngle(); });
}
function syncAngle() { const p = currentPage(); const a = $('#g-angle'); a.value = p ? p.angle || 0 : 0; a.parentElement.querySelector('output').value = (+a.value).toFixed(1) + '°'; }
function bmpData(bmp) { const c = makeCanvas(bmp.width, bmp.height); const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0); return x.getImageData(0, 0, bmp.width, bmp.height); }

async function deskewPage(p, interactive) {
  const src = await getPreviewSource(p);
  if (interactive) setBusy(true);
  try {
    const r = await cvRun('deskew', { image: bmpData(src), state: editState(p) });
    if (Math.abs(r.angle - (p.angle || 0)) < 0.05) { if (interactive) toast(t('geo.alreadyStraight'), 'info'); return 0; }
    if (interactive) await updatePage(p, { angle: r.angle }, { label: t('hist.angle') });
    if (interactive) toast(t('geo.straightened', { a: r.angle.toFixed(2) }), 'ok');
    return r.angle;
  } finally { if (interactive) setBusy(false); }
}

async function bookSplit() {
  const p = currentPage(); if (!p) return;
  if (p.rotation || p.flipH || p.flipV) { toast(t('geo.bookNeedsUpright'), 'warn'); return; }
  setBusy(true);
  try {
    const src = await getPreviewSource(p);
    const g = await cvRun('findGutter', { image: bmpData(src), state: { corners: p.corners } });
    const c = p.corners || [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
    const f = g.fraction; const [tl, tr, br, bl] = c;
    const top = { x: tl.x + (tr.x - tl.x) * f, y: tl.y + (tr.y - tl.y) * f }, bot = { x: bl.x + (br.x - bl.x) * f, y: bl.y + (br.y - bl.y) * f };
    const left = [tl, top, bot, bl], right = [top, tr, br, bot];
    const order = getLang() === 'ar' ? [right, left] : [left, right];
    const blob = await db.getBlob(p.origId);
    const items = order.map((cc, i) => ({ blob, width: p.origW, height: p.origH, corners: cc, params: { ...p.params }, preset: p.preset, source: p.source, label: (p.label || t('mode.book')) + (i ? ' B' : ' A') }));
    const at = state.cur;
    await addPages(items, at + 1);
    await deletePages([p.id]);
    state.cur = at; renderAll();
    toast(t('geo.bookDone'), 'ok');
  } catch (e) { errorToast(e); } finally { setBusy(false); }
}

/* =================== batch operations =================== */
async function batchEnhance() {
  const pages = selectedPagesOrAll();
  const id = await choiceDialog(t('batch.enhance'), PRESETS.map((p) => ({ value: p.id, label: t('preset.' + p.id) })), { message: t('batch.pagesN', { n: pages.length }) });
  if (!id) return;
  await applyPreset(id, pages);
  await runBatch(t('batch.enhance'), pages, (p) => ensureProcessed(p));
}
async function batchParams(title, patch) {
  const pages = selectedPagesOrAll();
  await updatePages(pages, (p) => ({ params: { ...(p.params || {}), ...patch } }), { label: title });
  await runBatch(title, pages, (p) => ensureProcessed(p));
}
async function batchDeskew(pages) {
  const res = [];
  await runBatch(t('batch.deskew'), pages, async (p) => { const a = await deskewPage(p, false); res.push([p, a]); });
  const changed = res.filter(([p, a]) => a && Math.abs(a - (p.angle || 0)) >= 0.05);
  if (changed.length) await updatePages(changed.map(([p]) => p), (p) => ({ angle: res.find((x) => x[0] === p)[1] }), { label: t('batch.deskew') });
  toast(t('batch.deskewDone', { n: changed.length }), 'ok');
}
async function batchRender() { await runBatch(t('batch.render'), selectedPagesOrAll(), (p) => ensureProcessed(p)); }

/* =================== OCR =================== */
let availability = null;
async function renderLangs() {
  const box = $('#ocr-langs');
  if (!availability) { box.textContent = t('ocr.checkingModels'); availability = await langAvailability(); }
  box.innerHTML = '';
  for (const l of OCR_LANGS) {
    const avail = availability[l.code];
    const cb = h('input', { type: 'checkbox', checked: settings.ocrLangs.includes(l.code) && avail, disabled: !avail });
    cb.onchange = () => { const set = new Set(settings.ocrLangs); cb.checked ? set.add(l.code) : set.delete(l.code); settings.ocrLangs = OCR_LANGS.map((x) => x.code).filter((c) => set.has(c)); };
    box.append(h('label', { class: avail ? '' : 'missing', title: avail ? t('ocr.modelReady') : t('ocr.modelMissing') }, cb, t('lang.' + l.code), h('span', { class: 'badge ' + (avail ? 'ok' : 'bad') }, avail ? '✓' : '✗')));
  }
}

function initOcrPanel() {
  $('#ocr-quality').value = settings.ocrQuality; $('#ocr-psm').value = settings.ocrPsm;
  $('#ocr-quality').onchange = (e) => { settings.ocrQuality = e.target.value; };
  $('#ocr-psm').onchange = (e) => { settings.ocrPsm = e.target.value; };
  $('#ocr-run').onclick = () => { const p = currentPage(); if (p) batchOcr([p]); };
  $('#ocr-batch').onclick = async () => {
    const v = await choiceDialog(t('ocr.batch'), [{ value: 'missing', label: t('ocr.batchMissing'), primary: true }, { value: 'selected', label: t('scope.selected') }, { value: 'all', label: t('scope.all') }]);
    if (!v) return;
    const pages = v === 'missing' ? state.pages.filter((p) => ocrStatus(p) !== 'ok') : scopePages(v);
    if (!pages.length) { toast(t('ocr.nothingToDo'), 'info'); return; }
    batchOcr(pages);
  };
  $('#ocr-save').onclick = async () => { const p = currentPage(); if (!p) return; await saveEditedText(p, $('#ocr-text').value); toast(t('ocr.saved'), 'ok'); renderOcrPanel(); };
  $('#ocr-copy').onclick = async () => { try { await navigator.clipboard.writeText($('#ocr-text').value); toast(t('act.copied'), 'ok'); } catch (_) { $('#ocr-text').select(); document.execCommand('copy'); toast(t('act.copied'), 'ok'); } };
  $('#ocr-txt').onclick = exportTxt;
  $('#ocr-spdf').onclick = searchablePdf;
  const find = debounce(() => {
    const q = normalizeText($('#ocr-find').value.trim());
    const p = currentPage();
    viewer.highlight = q || null;
    if (q && !showBoxes) { showBoxes = true; viewer.showBoxes = true; $('#v-ocrboxes').classList.add('on'); }
    const words = p?.ocr?.words || [];
    const n = q ? words.filter((w) => w.n.includes(q)).length : 0;
    const textN = q ? (normalizeText($('#ocr-text').value).split(q).length - 1) : 0;
    $('#ocr-find-count').textContent = q ? t('ocr.matches', { n: Math.max(n, textN) }) : '';
    const ta = $('#ocr-text'); const idx = q ? normalizeText(ta.value).indexOf(q) : -1;
    if (idx >= 0) { ta.focus({ preventScroll: true }); ta.setSelectionRange(idx, idx + q.length); $('#ocr-find').focus(); }
    viewer.draw();
  }, 200);
  $('#ocr-find').addEventListener('input', find);
}

function renderOcrPanel() {
  const p = currentPage();
  const meta = $('#ocr-meta'); meta.innerHTML = '';
  const ta = $('#ocr-text');
  if (!p || !p.ocr) { ta.value = ''; meta.append(h('span', { class: 'muted' }, t('ocr.noResult'))); return; }
  const o = p.ocr;
  ta.value = o.text || '';
  ta.dir = isArabicDominant(o.text || '') ? 'rtl' : 'ltr';
  const cls = o.conf >= 80 ? 'ok' : o.conf >= 60 ? 'warn' : 'bad';
  meta.append(h('span', { class: 'badge ' + cls }, t('ocr.confidence') + ': ' + o.conf + '%'),
    h('span', { class: 'badge' }, (o.langs || []).map((l) => t('lang.' + l)).join(' + ')),
    h('span', { class: 'badge' }, t('ocr.words', { n: (o.words || []).length })),
    o.edited ? h('span', { class: 'badge info' }, t('ocr.edited')) : null,
    ocrStatus(p) === 'stale' ? h('span', { class: 'badge warn' }, t('status.ocrStale')) : null,
    h('span', { class: 'muted' }, fmtDate(o.at)));
  if (viewer) { viewer.boxes = o.words ? { words: o.words, w: o.w || p.procW } : null; viewer.draw(); }
}
bus.on('ocr-done', (p) => { if (p === currentPage()) renderOcrPanel(); refreshThumb(p); });

async function batchOcr(pages) {
  const langs = settings.ocrLangs.filter((c) => !availability || availability[c]);
  if (!langs.length) { toast(t('ocr.noLang'), 'warn'); activateTab('ocr'); return; }
  const r = await runBatch(t('ocr.running'), pages, (p, report) => ocrPage(p, {
    langs,
    onProgress: (m) => { if (m.status === 'recognizing text') report(m.progress, t('ocr.recognizing')); else if (m.status) report(0, t('ocr.st.' + m.status.replace(/\s+/g, '_'), {}, m.status)); },
  }), { pausable: true });
  if (r.cancelled) await terminateOcr();
  if (r.done) toast(t('ocr.done', { n: r.done }), 'ok');
  renderOcrPanel(); renderThumbs();
}
function autoOcr(pages) { if (pages.length) batchOcr(pages); }

function exportTxt() {
  const pages = state.pages.filter((p) => p.ocr && p.ocr.text);
  if (!pages.length) { toast(t('ocr.noText'), 'warn'); return; }
  const txt = pages.map((p) => `=== ${t('batch.page', { i: pageIndex(p.id) + 1, n: state.pages.length })} ===\n${p.ocr.text}`).join('\n\n');
  downloadBlob(new Blob(['﻿' + txt], { type: 'text/plain;charset=utf-8' }), safeName(state.doc?.title) + '.txt');
}

async function searchablePdf() {
  const missing = state.pages.filter((p) => ocrStatus(p) !== 'ok');
  if (missing.length) {
    const v = await choiceDialog(t('ocr.searchablePdf'), [{ value: 'run', label: t('ocr.runMissingFirst', { n: missing.length }), primary: true }, { value: 'skip', label: t('ocr.exportAnyway') }]);
    if (!v) return;
    if (v === 'run') await batchOcr(missing);
  }
  await quickSearchablePdf(state.pages);
}

/* =================== page panel =================== */
function initPagePanel() {
  $('#p-label').onchange = async (e) => { const p = currentPage(); if (p) { await updatePage(p, { label: e.target.value }, { rerender: false, label: t('hist.label') }); renderThumbs(); } };
  $('#p-replace').onclick = () => $('#file-one').click();
  $('#file-one').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; const p = currentPage(); if (!f || !p) return;
    try {
      const items = await buildItems(f, 'document');
      const it = items[0];
      await replaceOriginal(p, f, it.width, it.height, { source: 'import' });
      if (it.corners) await updatePage(p, { corners: it.corners, detect: it.detect }, { history: false });
      dropSourceCache(p.id); showCurrent(); toast(t('page.replaced'), 'ok');
    } catch (err) { errorToast(err); }
  };
  $('#p-replace-cam').onclick = () => { const p = currentPage(); if (p) startCamera({ replace: p }); };
  $('#p-split').onclick = () => splitHere(state.cur);
  $('#p-extract').onclick = extractSelected;
  $('#p-idcard').onclick = () => { const sel = selectedPages(); combineIdCard(sel.length >= 2 ? sel.slice(0, 2) : state.pages.slice(state.cur, state.cur + 2)); };
  $('#p-download').onclick = async () => {
    const p = currentPage(); if (!p) return;
    const b = await ensureProcessed(p);
    downloadBlob(b, `${safeName(state.doc?.title)}-${state.cur + 1}.${b.type === 'image/png' ? 'png' : 'jpg'}`);
  };
}

function renderPageInfo() {
  const p = currentPage(); const dl = $('#p-info'); dl.innerHTML = '';
  $('#p-label').value = p?.label || '';
  if (!p) return;
  const row = (k, v) => { dl.append(h('dt', {}, k), h('dd', {}, v)); };
  row(t('page.source'), t('src.' + (p.source || 'import')));
  row(t('page.original'), `${p.origW} × ${p.origH} px`);
  row(t('page.processed'), p.procW ? `${p.procW} × ${p.procH} px` : t('status.processing'));
  if (p.dpi) row('DPI', String(p.dpi));
  if (p.pdfSize) row(t('page.pdfSize'), `${Math.round(p.pdfSize.w / 72 * 25.4)} × ${Math.round(p.pdfSize.h / 72 * 25.4)} mm`);
  row(t('page.crop'), p.corners ? t('page.cropped') : t('page.uncropped'));
  row(t('page.rotation'), `${p.rotation || 0}° ${p.angle ? (p.angle > 0 ? '+' : '') + p.angle.toFixed(2) + '°' : ''}`);
  if (p.preset) row(t('page.preset'), t('preset.' + p.preset, {}, p.preset));
  row('OCR', t('status.ocr.' + ocrStatus(p)));
  row(t('page.created'), fmtDate(p.createdAt));
}

/** Front + back ID card composed at real size (85.6 × 54 mm) on one A4 page at 300 DPI */
async function combineIdCard(pages) {
  if (pages.length < 2) { toast(t('id.needTwo'), 'warn'); return; }
  const prog = new Progress(t('id.composing'), { cancellable: false });
  try {
    const dpi = 300, A4w = Math.round(210 / 25.4 * dpi), A4h = Math.round(297 / 25.4 * dpi);
    const cw = Math.round(85.6 / 25.4 * dpi), ch = Math.round(53.98 / 25.4 * dpi);
    const c = makeCanvas(A4w, A4h); const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, A4w, A4h);
    const gap = Math.round(15 / 25.4 * dpi);
    const top = Math.round((A4h - (2 * ch + gap)) / 3);
    for (let i = 0; i < 2; i++) {
      const bmp = await decode(await ensureProcessed(pages[i]));
      let w = bmp.width, hh = bmp.height;
      if ((w < hh) !== (cw < ch)) { /* card captured in portrait: fit as-is */ }
      const k = Math.min(cw / w, ch / hh); w = Math.round(w * k); hh = Math.round(hh * k);
      const px = Math.round((A4w - w) / 2), py = top + i * (ch + gap) + Math.round((ch - hh) / 2);
      x.drawImage(bmp, px, py, w, hh); bmp.close && bmp.close();
      x.strokeStyle = '#d0d0d0'; x.lineWidth = 2; x.strokeRect(px, py, w, hh);
      prog.set((i + 1) / 2);
    }
    const blob = await canvasToBlob(c, 'image/jpeg', 0.93);
    const created = await addPages([{ blob, width: A4w, height: A4h, source: 'composite', dpi, label: t('id.label'), pdfSize: { w: 595.28, h: 841.89 }, preset: 'original' }], pageIndex(pages[1].id) + 1);
    state.cur = pageIndex(created[0].id); renderAll();
    toast(t('id.done'), 'ok');
  } catch (e) { errorToast(e); } finally { prog.close(); }
}

/* =================== export panel =================== */
function initExportPanel() {
  $('#x-pdf').onclick = () => openExportDialog();
  $('#x-images').onclick = openImageExportDialog;
  $('#x-share').onclick = sharePdf;
  $('#x-print').onclick = openPrintDialog;
  $('#x-project').onclick = saveProjectFile;
}

async function sharePdf() {
  if (!state.pages.length) { toast(t('ws.noPages'), 'warn'); return; }
  const prog = new Progress(t('exp.creating'));
  try {
    const bytes = await buildPdf(state.pages, defaultExportOptions(), { onProgress: (f, i, n) => prog.set(f, t('batch.page', { i, n })), cancelled: () => prog.cancelled });
    prog.close();
    await shareFiles([new File([bytes], safeName(state.doc?.title) + '.pdf', { type: 'application/pdf' })], state.doc?.title);
  } catch (e) { prog.close(); errorToast(e, t('exp.failed')); }
}

/** Export from library: single doc PDF or several docs as ZIP of PDFs */
async function exportDocsFromLibrary(ids, kind) {
  if (kind === 'pdf') { await openDocument(ids); openExportDialog(); return; }
  const JSZip = await libJSZip(); const zip = new JSZip();
  const prog = new Progress(t('exp.creating'));
  const prevDoc = state.doc?.id;
  try {
    for (let i = 0; i < ids.length; i++) {
      if (prog.cancelled) break;
      await openDoc(ids[i]);
      prog.set(i / ids.length, state.doc.title);
      const bytes = await buildPdf(state.pages, { ...defaultExportOptions(), title: state.doc.title }, { cancelled: () => prog.cancelled });
      let name = safeName(state.doc.title) + '.pdf'; let k = 2;
      while (zip.file(name)) name = safeName(state.doc.title) + ` (${k++}).pdf`;
      zip.file(name, bytes);
    }
    downloadBlob(await zip.generateAsync({ type: 'blob' }), 'documents.zip');
  } catch (e) { errorToast(e, t('exp.failed')); }
  finally {
    prog.finish();
    if (prevDoc) await openDoc(prevDoc).catch(() => {}); else closeDoc();
  }
}

/* =================== status bar & storage =================== */
function initStatus() {
  const net = () => { const on = navigator.onLine; const el = $('#st-net'); el.classList.toggle('off', !on); el.querySelector('use').setAttribute('href', on ? '#i-wifi' : '#i-wifi-off'); el.querySelector('b').textContent = on ? t('status.online') : t('status.offline'); };
  window.addEventListener('online', () => { net(); toast(t('status.backOnline'), 'ok'); });
  window.addEventListener('offline', () => { net(); toast(t('status.wentOffline'), 'info'); });
  net(); updateStorage();
  setInterval(updateStorage, 30000);
  bus.on('doc-saved', debounce(updateStorage, 1000));
  document.addEventListener('precache-progress', (e) => { const d = e.detail; if (d.done === d.total) toast(t('pwa.offlineReady'), 'ok'); });
}
async function updateStorage() {
  const s = await storageInfo();
  $('#st-storage b').textContent = s.usage != null ? `${fmtBytes(s.usage)} / ${fmtBytes(s.quota)}` : '—';
  $('#st-storage').title = s.persisted ? t('diag.persisted') : t('diag.notPersisted');
}
function updateStatus() {
  const p = currentPage();
  $('#st-pages').textContent = t('status.pages', { n: state.pages.length });
  $('#st-current').textContent = p ? t('status.current', { n: state.cur + 1 }) : '';
  $('#st-res').textContent = p ? `${p.procW || p.origW}×${p.procH || p.origH}px` : '';
}
async function checkStorageWarnings() {
  const s = await storageInfo();
  if (s.quota && s.usage / s.quota > 0.85) toast(t('storage.nearlyFull'), 'warn', { ms: 10000 });
  const docs = (await listDocs().catch(() => [])).filter((d) => !d.deleted);
  if (docs.length && !s.persisted) {
    const asked = lsGet('ssp.persistAsked', 0);
    if (Date.now() - asked > 7 * 86400000) {
      lsSet('ssp.persistAsked', Date.now());
      const granted = await requestPersistence();
      if (!granted) toast(t('storage.notPersistent'), 'warn', { ms: 12000, action: { label: t('backup.now'), fn: () => downloadBackup(null) } });
    }
  }
}

/* =================== settings =================== */
async function openSettings(initialTab = 'general') {
  const tabs = ['general', 'camera', 'enhance', 'ocr', 'storage', 'advanced'];
  await modal({
    title: t('nav.settings'), big: true,
    build(body, foot, close) {
      const bar = h('div', { class: 'tabs-inline' });
      const panes = {};
      const fld = (l, el) => h('label', { class: 'field' }, h('span', {}, l), el);
      const bindSel = (k, opts, cb) => { const s = h('select', {}, opts.map(([v, l]) => h('option', { value: v, selected: String(settings[k]) === String(v) }, l))); s.onchange = () => { settings[k] = typeof settings[k] === 'number' ? +s.value : s.value; cb && cb(s.value); }; return s; };
      const bindChk = (k, label) => { const c = h('input', { type: 'checkbox', checked: !!settings[k] }); c.onchange = () => { settings[k] = c.checked; }; return h('label', { class: 'switch' }, c, h('span', {}, label)); };
      const bindRange = (k, label, min, max, step = 1) => { const i = h('input', { type: 'range', min, max, step, value: settings[k] }); const o = h('output', {}, String(settings[k])); i.oninput = () => { o.value = i.value; }; i.onchange = () => { settings[k] = +i.value; }; return h('label', { class: 'sl' }, h('span', {}, label), i, o); };
      for (const tb of tabs) {
        const b = h('button', { type: 'button', onclick: () => show(tb) }, t('set.tab.' + tb));
        b.dataset.tab = tb; bar.append(b);
        panes[tb] = h('div', { class: 'hidden' });
      }
      const show = (tb) => { Object.entries(panes).forEach(([k, el]) => el.classList.toggle('hidden', k !== tb)); bar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tb)); };
      // general
      panes.general.append(
        fld(t('set.lang'), bindSel('lang', [['ar', 'العربية'], ['en', 'English']], (v) => setLang(v))),
        fld(t('set.theme'), bindSel('theme', [['dark', t('set.dark')], ['light', t('set.light')], ['auto', t('set.auto')]], applyTheme)),
        fld(t('set.exportFormat'), bindSel('exportFormat', [['pdf', 'PDF'], ['jpg', 'JPEG'], ['png', 'PNG']])),
        fld(t('set.pageSize'), bindSel('pageSize', [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['original', t('exp.original')]])),
        fld(t('set.orientation'), bindSel('orientation', [['auto', t('orient.auto')], ['portrait', t('orient.portrait')], ['landscape', t('orient.landscape')]])),
        fld(t('set.quality'), bindSel('quality', [['low', t('q.low')], ['medium', t('q.medium')], ['high', t('q.high')], ['max', t('q.max')]])),
        fld(t('set.dpi'), bindSel('dpi', [150, 200, 300, 400, 600].map((d) => [d, d + ' DPI']))),
        fld(t('set.importDpi'), bindSel('importDpi', [96, 150, 200, 300, 400].map((d) => [d, d + ' DPI']))),
        h('div', { class: 'row-btns' }, h('button', { type: 'button', class: 'btn', onclick: promptInstall }, icon('smartphone'), t('pwa.install'))));
      // camera
      panes.camera.append(
        fld(t('cam.resolution'), bindSel('captureRes', [['4k', '4K'], ['1080', '1080p'], ['720', '720p']])),
        bindChk('autoCapture', t('cam.autoCapture')), bindChk('continuous', t('cam.continuous')),
        fld(t('cam.timer'), bindSel('timer', [[0, t('cam.timerOff')], [3, '3s'], [5, '5s'], [10, '10s']])),
        bindRange('detectSensitivity', t('detect.sensitivity'), 0, 100), bindRange('detectMinConfidence', t('detect.minConfidence'), 20, 95),
        bindChk('autoCropOnImport', t('set.autoCropImport')),
        h('p', { class: 'hint' }, t('set.cameraHint')));
      // enhancement
      panes.enhance.append(
        fld(t('set.defaultPreset'), bindSel('defaultPreset', PRESETS.map((p) => [p.id, t('preset.' + p.id)]))),
        bindRange('defaultBrightness', t('p.brightness'), -50, 50), bindRange('defaultContrast', t('p.contrast'), -50, 50),
        bindRange('cleanIntensity', t('set.cleanIntensity'), 0, 100),
        fld(t('set.maxPx'), bindSel('maxProcessingPx', [[2500, '2500 px'], [3000, '3000 px'], [4000, '4000 px'], [5000, '5000 px'], [6500, '6500 px']])),
        h('p', { class: 'hint' }, t('set.maxPxHint')));
      // ocr
      panes.ocr.append(
        fld(t('set.ocrDefault'), bindSel('ocrLangs', [], null)),
        fld(t('ocr.quality'), bindSel('ocrQuality', [['fast', t('ocr.fast')], ['balanced', t('ocr.balanced')], ['best', t('ocr.best')]])),
        bindChk('autoOcr', t('set.autoOcr')), bindChk('searchablePdf', t('set.searchableDefault')));
      const langSel = panes.ocr.querySelector('select');
      langSel.innerHTML = '';
      [['ara,eng', t('lang.ara') + ' + ' + t('lang.eng')], ['ara', t('lang.ara')], ['eng', t('lang.eng')], ['fra', t('lang.fra')], ['ara,eng,fra', t('lang.ara') + ' + ' + t('lang.eng') + ' + ' + t('lang.fra')]].forEach(([v, l]) => langSel.append(h('option', { value: v, selected: settings.ocrLangs.join(',') === v }, l)));
      langSel.onchange = () => { settings.ocrLangs = langSel.value.split(','); };
      // storage
      const stInfo = h('dl', { class: 'kv' });
      const fillSt = async () => {
        const s = await storageInfo(); const docs = await listDocs(); const blobs = await blobsUsage();
        const last = await db.kvGet('lastBackupAt');
        stInfo.innerHTML = '';
        const row = (k, v) => stInfo.append(h('dt', {}, k), h('dd', {}, v));
        row(t('set.used'), s.usage != null ? `${fmtBytes(s.usage)} / ${fmtBytes(s.quota)}` : '—');
        row(t('set.docsData'), fmtBytes(blobs));
        row(t('set.docCount'), String(docs.filter((d) => !d.deleted).length) + ' (+' + docs.filter((d) => d.deleted).length + ' ' + t('lib.trash') + ')');
        row(t('set.persistent'), s.persisted ? '✓ ' + t('diag.persisted') : '✗ ' + t('diag.notPersisted'));
        row(t('set.lastBackup'), last ? fmtDate(last) : t('set.never'));
      };
      fillSt();
      const restoreInput = h('input', { type: 'file', accept: '.zip,.sspz,application/zip', hidden: true });
      restoreInput.onchange = async () => {
        const f = restoreInput.files[0]; restoreInput.value = ''; if (!f) return;
        if (!(await confirmDialog(t('backup.restoreConfirm')))) return;
        const prog = new Progress(t('backup.restoring'), { cancellable: false });
        try { const r = await restoreBackup(f, { asCopy: false, onProgress: (x) => prog.set(x) }); toast(t('backup.restored', { docs: r.docs.length, pages: r.pages }), 'ok'); fillSt(); renderLibrary(); applyTheme(); }
        catch (e) { errorToast(e); } finally { prog.close(); }
      };
      panes.storage.append(stInfo, h('p', { class: 'hint' }, t('storage.explain')),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn primary', onclick: async () => { const p = new Progress(t('backup.creating'), { cancellable: false }); try { const n = await downloadBackup(null, null, { onProgress: (x) => p.set(x) }); toast(t('backup.saved', { size: fmtBytes(n) }), 'ok'); fillSt(); } catch (e) { errorToast(e); } finally { p.close(); } } }, icon('download'), t('backup.exportAll')),
          h('button', { type: 'button', class: 'btn', onclick: () => restoreInput.click() }, icon('archive-restore'), t('backup.restore')),
          h('button', { type: 'button', class: 'btn', onclick: async () => { const g = await requestPersistence(); toast(g ? t('diag.persisted') : t('diag.persistDenied'), g ? 'ok' : 'warn'); fillSt(); } }, icon('shield-check'), t('diag.requestPersist')),
          h('button', { type: 'button', class: 'btn', onclick: () => { close(); goLibrary(); } }, icon('library'), t('set.manageDocs')),
          h('button', { type: 'button', class: 'btn', onclick: async () => { if (!(await confirmDialog(t('set.clearCacheConfirm')))) return; const n = await clearCaches(); toast(t('set.cacheCleared', { n }), 'ok'); } }, icon('refresh-cw'), t('set.clearCache')),
          h('button', { type: 'button', class: 'btn danger', onclick: async () => {
            if (!(await confirmDialog(t('set.deleteAllConfirm'), { danger: true, okText: t('set.deleteAll') }))) return;
            const typed = await promptDialog(t('set.deleteAllType'), '');
            if ((typed || '').trim().toUpperCase() !== 'DELETE' && (typed || '').trim() !== 'حذف') { toast(t('set.deleteAllCancelled'), 'info'); return; }
            await terminateOcr(); closeDoc(); clearHistory(); await deleteAllData(); await clearCaches();
            toast(t('set.allDeleted'), 'ok'); close(); setView('library');
          } }, icon('trash-2'), t('set.deleteAll'))), restoreInput);
      // advanced
      panes.advanced.append(
        h('dl', { class: 'kv' }, h('dt', {}, t('diag.version')), h('dd', {}, APP_VERSION)),
        h('div', { class: 'btn-col' },
          h('button', { type: 'button', class: 'btn', onclick: () => { close(); openDiagnostics(); } }, icon('activity'), t('diag.title')),
          h('button', { type: 'button', class: 'btn', onclick: async () => { const i = await swInfo(); toast(i ? `${i.version} · ${i.cached}/${i.total}` : t('diag.swNone'), 'info'); } }, icon('database'), t('set.cacheStatus')),
          h('button', { type: 'button', class: 'btn', onclick: async () => { await resetSettings(); toast(t('set.resetDone'), 'ok'); close(); setLang(settings.lang); applyTheme(); } }, icon('refresh-cw'), t('set.reset'))),
        bindChk('debug', t('set.debug')),
        h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', color: 'var(--muted)', direction: 'ltr' } }, JSON.stringify(allSettings(), null, 1)));
      body.append(bar, ...Object.values(panes));
      show(tabs.includes(initialTab) ? initialTab : 'general');
    },
  });
}

/* =================== help =================== */
function openHelp() {
  modal({
    title: t('nav.help'), big: true,
    build(body) {
      const keys = [['Ctrl+Z', 'act.undo'], ['Ctrl+Y / Ctrl+Shift+Z', 'act.redo'], ['Ctrl+S', 'act.saveProject'], ['Ctrl+O', 'act.openProject'], ['Ctrl+E', 'exp.title'], ['Ctrl+P', 'act.print'], ['N', 'act.scanCamera'], ['I', 'act.importFiles'], ['← / →', 'view.prevNext'], ['+ / −', 'view.zoom'], ['0', 'view.fit'], ['1', 'view.actual'], ['C', 'view.compare'], ['K', 'crop.edit'], ['D', 'detect.auto'], ['R', 'geo.right'], ['Shift+R', 'geo.left'], ['Delete', 'pages.delete'], ['Ctrl+A', 'pages.selectAll'], ['F', 'view.fullscreen'], ['?', 'nav.help']];
      body.append(h('div', { class: 'help-body', html: t('help.html') }),
        h('div', { class: 'help-body' }, h('h4', {}, t('help.shortcuts')), h('table', {}, keys.map(([k, l]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, t(l)))))));
    },
  });
}

/* =================== keyboard =================== */
function initShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (isScanning() || !$('#cropper').classList.contains('hidden') || $('#dlg').open || $('#dlg-big').open) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { if (!typing) { e.preventDefault(); doUndo(); } return; }
    if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { if (!typing) { e.preventDefault(); doRedo(); } return; }
    if (mod && k === 's') { e.preventDefault(); saveProjectFile(); return; }
    if (mod && k === 'o') { e.preventDefault(); $('#file-project').click(); return; }
    if (mod && k === 'p') { if (state.doc) { e.preventDefault(); openPrintDialog(); } return; }
    if (mod && k === 'e') { e.preventDefault(); openExportDialog(); return; }
    if (mod && k === 'a' && !typing && state.doc) { e.preventDefault(); state.pages.forEach((p) => state.selected.add(p.id)); renderThumbs(); return; }
    if (typing || mod || e.altKey) return;
    const ws = $('#app').dataset.view === 'workspace';
    const rtl = document.dir === 'rtl';
    switch (e.key) {
      case 'n': case 'N': startCamera(); break;
      case 'i': case 'I': $('#file-any').click(); break;
      case '?': openHelp(); break;
      default:
        if (!ws) return;
        if (e.key === 'ArrowRight') setCurrent(state.cur + (rtl ? -1 : 1));
        else if (e.key === 'ArrowLeft') setCurrent(state.cur + (rtl ? 1 : -1));
        else if (e.key === 'PageDown') setCurrent(state.cur + 1);
        else if (e.key === 'PageUp') setCurrent(state.cur - 1);
        else if (e.key === '+' || e.key === '=') viewer.zoomBy(1.25);
        else if (e.key === '-') viewer.zoomBy(0.8);
        else if (e.key === '0') viewer.fitView();
        else if (e.key === '1') viewer.actualSize();
        else if (k === 'c') toggleCompare();
        else if (k === 'k') editCorners();
        else if (k === 'd') autoDetect(currentPage());
        else if (k === 'r') rotatePages(selectedPages(), e.shiftKey ? -90 : 90);
        else if (k === 'f') $('#z-full').click();
        else if (e.key === 'Delete' || e.key === 'Backspace') removePages(selectedPages().map((p) => p.id));
        else if (e.key === 'Escape') { state.selected.clear(); renderThumbs(); closeSheets(); }
        else return;
        e.preventDefault();
    }
  });
}

window.addEventListener('beforeunload', () => { if (state.doc) persistSession(); });
window.addEventListener('error', (e) => { if (settings.debug) toast('Error: ' + e.message, 'bad'); });
window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); if (settings.debug) toast('Error: ' + (e.reason?.message || e.reason), 'bad'); });

// test hook (used by the automated browser tests in tests/)
window.__ssp = { state, settings, handleFiles, openDocument, goLibrary, setCurrent, autoDetect, batchOcr, ensureProcessed, buildPdf, defaultExportOptions, deskewPage, applyPreset, combineIdCard, editCorners, updatePage, currentPage };

boot().catch((e) => { console.error(e); errorToast(e, 'Startup'); });
