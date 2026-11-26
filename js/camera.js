// Camera device control (getUserMedia). Exposes only capabilities the device really reports.
import { makeCanvas, canvasToBlob } from './image-io.js';

const RES = { '4k': [3840, 2160], 1080: [1920, 1080], 720: [1280, 720] };

export class CameraError extends Error {
  constructor(code, cause) { super(code); this.code = code; this.cause = cause; }
}

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export class Camera {
  constructor(video) { this.video = video; this.stream = null; this.track = null; this.torch = false; this.facing = 'environment'; }

  async start({ deviceId = '', facing = 'environment', res = '4k' } = {}) {
    if (!window.isSecureContext) throw new CameraError('insecure');
    if (!cameraSupported()) throw new CameraError('unsupported');
    this.stop();
    const [w, hh] = RES[res] || RES['4k'];
    const base = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: { ideal: facing } };
    const attempts = [
      { ...base, width: { ideal: w }, height: { ideal: hh } },
      { ...base, width: { ideal: 1920 }, height: { ideal: 1080 } },
      base,
      true,
    ];
    let lastErr;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (e) {
        lastErr = e;
        if (e.name === 'NotAllowedError' || e.name === 'SecurityError') throw new CameraError('denied', e);
        if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') { if (video === true) throw new CameraError('notfound', e); continue; }
        if (e.name === 'NotReadableError' || e.name === 'TrackStartError') throw new CameraError('busy', e);
        // OverconstrainedError / TypeError: try a looser constraint set
      }
    }
    if (!this.stream) throw new CameraError('failed', lastErr);
    this.track = this.stream.getVideoTracks()[0];
    this.facing = facing;
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    await new Promise((r) => { if (this.video.videoWidth) r(); else this.video.onloadedmetadata = () => r(); setTimeout(r, 3000); });
    this.track.addEventListener('ended', () => this.onended && this.onended());
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (_) { /* not supported */ }
    return this.settings();
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null; this.track = null; this.torch = false;
    if (this.video) this.video.srcObject = null;
  }

  get active() { return !!(this.track && this.track.readyState === 'live'); }

  settings() { return this.track && this.track.getSettings ? this.track.getSettings() : {}; }

  capabilities() {
    if (!this.track || !this.track.getCapabilities) return {};
    try { return this.track.getCapabilities() || {}; } catch (_) { return {}; }
  }

  async listDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'videoinput');
  }

  async setTorch(on) {
    if (!this.capabilities().torch) throw new CameraError('notorch');
    await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
    this.torch = !!on;
    return this.torch;
  }

  async apply(constraint) { await this.track.applyConstraints({ advanced: [constraint] }); }

  /** Capture a full-resolution still. Prefers ImageCapture.takePhoto (higher resolution on Android). */
  async capture() {
    if (!this.active) throw new CameraError('inactive');
    if ('ImageCapture' in window && !/iPhone|iPad|Macintosh/.test(navigator.userAgent)) {
      try {
        const ic = new window.ImageCapture(this.track);
        const opts = {};
        try {
          const pc = await ic.getPhotoCapabilities();
          if (pc && pc.imageWidth && pc.imageWidth.max) { opts.imageWidth = pc.imageWidth.max; opts.imageHeight = pc.imageHeight.max; }
          if (this.torch && pc.fillLightMode && pc.fillLightMode.includes('flash')) opts.fillLightMode = 'flash';
        } catch (_) { /* */ }
        const blob = await ic.takePhoto(opts);
        if (blob && blob.size > 1000) return blob;
      } catch (_) { /* fall back to frame grab */ }
    }
    const v = this.video;
    const c = makeCanvas(v.videoWidth, v.videoHeight);
    c.getContext('2d').drawImage(v, 0, 0);
    return canvasToBlob(c, 'image/jpeg', 0.95);
  }

  /** Small frame for live detection */
  frame(maxSide = 480) {
    const v = this.video;
    if (!v.videoWidth) return null;
    const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * k), hh = Math.round(v.videoHeight * k);
    if (!this._fc || this._fc.width !== w || this._fc.height !== hh) { this._fc = makeCanvas(w, hh); this._fx = this._fc.getContext('2d', { willReadFrequently: true }); }
    this._fx.drawImage(v, 0, 0, w, hh);
    return this._fx.getImageData(0, 0, w, hh);
  }
}
