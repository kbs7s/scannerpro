// Storage management: quota, persistence request, ZIP backup / restore, project files, data deletion.
import * as db from './database.js';
import { libJSZip, uid, downloadBlob, safeName, normalizeText, bus } from './util.js';
import { t } from './i18n.js';
import { allSettings, replaceSettings } from './settings.js';

export const BACKUP_FORMAT = 1;

export async function storageInfo() {
  const out = { usage: null, quota: null, persisted: null, supported: !!(navigator.storage && navigator.storage.estimate) };
  try { if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (_) { /* */ }
  try { if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted(); } catch (_) { /* */ }
  return out;
}

export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch (_) { /* */ }
  return false;
}

const extFor = (type) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[type] || 'bin');

async function collect(docIds) {
  const docs = docIds ? (await Promise.all(docIds.map((id) => db.get('docs', id)))).filter(Boolean) : await db.getAll('docs');
  const pages = [];
  for (const d of docs) pages.push(...(await db.byIndex('pages', 'docId', d.id)));
  return { docs, pages };
}

/** Builds a ZIP backup. docIds = null for a full backup. */
export async function buildBackup(docIds = null, { includeSettings = !docIds, onProgress } = {}) {
  const JSZip = await libJSZip();
  const zip = new JSZip();
  const { docs, pages } = await collect(docIds);
  const blobsMeta = {};
  let i = 0;
  for (const p of pages) {
    for (const id of [p.origId, p.procId, p.thumbId, p.ocr?.pdfId]) {
      if (!id || blobsMeta[id]) continue;
      const rec = await db.get('blobs', id);
      if (!rec) continue;
      blobsMeta[id] = rec.type || rec.blob.type;
      zip.file(`blobs/${id}.${extFor(blobsMeta[id])}`, rec.blob, { compression: 'STORE' });
    }
    onProgress && onProgress(++i / Math.max(1, pages.length));
  }
  const manifest = {
    app: 'ultimate-smart-scanner-pro', format: BACKUP_FORMAT, type: docIds ? 'project' : 'full', exportedAt: new Date().toISOString(),
    docs, pages, blobs: blobsMeta,
    presets: docIds ? [] : await db.getAll('presets'),
    settings: includeSettings ? allSettings() : null,
  };
  zip.file('manifest.json', JSON.stringify(manifest));
  zip.file('README.txt', 'Ultimate Smart Scanner Pro backup. Restore it from Settings > Storage > Restore backup, or open it with "Open project".\n');
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } }, (m) => onProgress && onProgress(0.5 + m.percent / 200));
}

export async function downloadBackup(docIds = null, name, opts) {
  const blob = await buildBackup(docIds, opts);
  const stamp = new Date().toISOString().slice(0, 10);
  downloadBlob(blob, docIds ? `${safeName(name || 'project')}.sspz` : `smart-scanner-backup-${stamp}.zip`);
  try { await db.kvSet('lastBackupAt', Date.now()); } catch (_) { /* */ }
  return blob.size;
}

/**
 * Restores a backup / project ZIP. asCopy=true assigns new ids (used for "Open project").
 * Returns { docs: [newDocIds], pages: n }
 */
export async function restoreBackup(file, { asCopy = false, onProgress } = {}) {
  const JSZip = await libJSZip();
  let zip;
  try { zip = await JSZip.loadAsync(file); } catch (e) { throw new Error(t('backup.notZip')); }
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error(t('backup.noManifest'));
  const manifest = JSON.parse(await mf.async('string'));
  if (manifest.app !== 'ultimate-smart-scanner-pro') throw new Error(t('backup.wrongApp'));
  if (manifest.format > BACKUP_FORMAT) throw new Error(t('backup.newer'));
  const docMap = new Map(); const pageMap = new Map();
  for (const d of manifest.docs) docMap.set(d.id, asCopy ? uid('d_') : d.id);
  for (const p of manifest.pages) pageMap.set(p.id, asCopy ? uid('p_') : p.id);
  const blobId = (oldId, oldPage) => {
    if (!oldId) return null;
    if (!asCopy) return oldId;
    return oldId.slice(0, 2) + pageMap.get(oldPage);
  };
  let i = 0;
  for (const p of manifest.pages) {
    const np = { ...p, id: pageMap.get(p.id), docId: docMap.get(p.docId) };
    for (const k of ['origId', 'procId', 'thumbId']) {
      const old = p[k]; if (!old) continue;
      const type = manifest.blobs[old];
      const f = zip.file(`blobs/${old}.${extFor(type)}`);
      if (!f) { if (k === 'origId') throw new Error(t('backup.missingBlob')); np[k] = null; continue; }
      const blob = new Blob([await f.async('arraybuffer')], { type });
      np[k] = blobId(old, p.id);
      await db.putBlob(np[k], blob);
    }
    if (p.ocr && p.ocr.pdfId) {
      const old = p.ocr.pdfId; const f = zip.file(`blobs/${old}.pdf`);
      np.ocr = { ...p.ocr, pdfId: f ? blobId(old, p.id) : null };
      if (f) await db.putBlob(np.ocr.pdfId, new Blob([await f.async('arraybuffer')], { type: 'application/pdf' }));
    }
    if (!np.procId) { np.procRev = 0; }
    await db.put('pages', np);
    onProgress && onProgress(++i / manifest.pages.length);
  }
  const newDocs = [];
  for (const d of manifest.docs) {
    const nd = { ...d, id: docMap.get(d.id), pageIds: d.pageIds.map((x) => pageMap.get(x)).filter(Boolean), thumbId: d.thumbId ? blobId(d.thumbId, d.pageIds.find((pid) => 't_' + pid === d.thumbId) || d.pageIds[0]) : null };
    if (asCopy) { nd.deleted = false; nd.updatedAt = Date.now(); }
    nd.searchIndex = normalizeText([nd.title, nd.notes, (nd.tags || []).join(' '), nd.ocrText || ''].join(' '));
    await db.put('docs', nd);
    newDocs.push(nd.id);
  }
  if (!asCopy && manifest.presets) for (const pr of manifest.presets) await db.put('presets', pr);
  if (!asCopy && manifest.settings) await replaceSettings(manifest.settings);
  bus.emit('docs-changed');
  return { docs: newDocs, pages: manifest.pages.length, type: manifest.type };
}

export async function clearCaches() {
  if (!('caches' in self)) return 0;
  const keys = await caches.keys();
  for (const k of keys) await caches.delete(k);
  return keys.length;
}

export async function deleteAllData() {
  await db.deleteEverything();
  try { localStorage.clear(); } catch (_) { /* */ }
  bus.emit('docs-changed');
}

export async function blobsUsage() {
  const all = await db.getAll('blobs');
  return all.reduce((s, b) => s + (b.size || b.blob?.size || 0), 0);
}
