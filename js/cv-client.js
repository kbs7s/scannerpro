// Client for the OpenCV image worker(s). Keeps heavy pixel work off the UI thread.
class CVWorker {
  constructor() {
    this.w = new Worker(new URL('./workers/image-worker.js', import.meta.url));
    this.pending = new Map();
    this.seq = 0;
    this.busy = 0;
    this.w.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      this.busy--;
      e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error));
    };
    this.w.onerror = (e) => {
      const err = new Error('Image worker crashed: ' + (e.message || 'unknown'));
      for (const p of this.pending.values()) p.rej(err);
      this.pending.clear(); this.busy = 0; this.dead = true;
    };
    this.ready = this.call('init');
  }
  call(op, payload, transfer = []) {
    return new Promise((res, rej) => {
      const id = ++this.seq;
      this.pending.set(id, { res, rej });
      this.busy++;
      this.w.postMessage({ id, op, payload }, transfer);
    });
  }
  terminate() { this.w.terminate(); this.dead = true; }
}

const pool = [];
let size = 1;
let initInfo = null;

function poolSize() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 4;
  return cores >= 6 && mem >= 6 ? 2 : 1;
}

function getWorker(i) {
  if (!pool[i] || pool[i].dead) pool[i] = new CVWorker();
  return pool[i];
}

export async function cvInit() {
  size = poolSize();
  const w = getWorker(0);
  initInfo = await w.ready;
  return initInfo;
}
export const cvInfo = () => initInfo;
export const cvPoolSize = () => size;

/** Run an op on the least busy worker. ImageData buffers are transferred. */
export async function cvRun(op, payload, { worker } = {}) {
  let w;
  if (worker != null) w = getWorker(worker);
  else {
    for (let i = 0; i < size; i++) getWorker(i);
    w = pool.slice(0, size).reduce((a, b) => (b.busy < a.busy ? b : a));
  }
  await w.ready;
  const transfer = [];
  if (payload && payload.image && payload.image.data) transfer.push(payload.image.data.buffer);
  return w.call(op, payload, transfer);
}

/** Non-blocking op for live camera frames: skips if worker 0 is still busy */
export function cvTryLive(op, payload) {
  const w = getWorker(0);
  if (w.busy > 0) return null;
  return w.ready.then(() => w.call(op, payload, [payload.image.data.buffer]));
}

export function cvReset() { pool.forEach((w) => w && w.terminate()); pool.length = 0; }
