// Batch processing engine: sequential page queue with progress, pause, cancel, retry and error report.
// Pixel work runs in the OpenCV worker pool and Tesseract's worker, so the UI never blocks.
import { t } from './i18n.js';
import { Progress } from './ui.js';

export async function runBatch(title, pages, fn, { pausable = true } = {}) {
  const prog = new Progress(title, { pausable });
  const failed = []; let done = 0;
  const n = pages.length;
  for (let i = 0; i < n; i++) {
    await prog.waitIfPaused();
    if (prog.cancelled) break;
    const label = t('batch.page', { i: i + 1, n });
    prog.set(i / n, label);
    try {
      await fn(pages[i], (f, sub) => prog.set((i + Math.max(0, Math.min(1, f))) / n, sub ? `${label} · ${sub}` : label));
      done++;
    } catch (e) {
      console.error(e);
      failed.push(pages[i]);
      prog.error(`${label}: ${e && e.message ? e.message : e}`);
    }
  }
  if (!prog.cancelled) prog.set(1, t('batch.finished', { n: done }));
  const cancelled = prog.cancelled;
  prog.finish({ retry: failed.length ? () => runBatch(title, failed, fn, { pausable }) : null });
  return { done, failed, cancelled };
}
