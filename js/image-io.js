// Image decoding/encoding helpers (main thread)
export const canOffscreen = typeof OffscreenCanvas !== 'undefined' && (() => { try { return !!new OffscreenCanvas(1, 1).getContext('2d'); } catch (_) { return false; } })();

export function makeCanvas(w, hgt) {
  if (canOffscreen) return new OffscreenCanvas(w, hgt);
  const c = document.createElement('canvas'); c.width = w; c.height = hgt; return c;
}

/** Decode a Blob into an ImageBitmap (EXIF orientation applied), optionally limited to maxSide. */
export async function decode(blob, maxSide = 0) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch (_) {
    // Safari < 15 / unusual formats: go through <img>
    bmp = await new Promise((res, rej) => {
      const img = new Image(); const url = URL.createObjectURL(blob);
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Unsupported or corrupt image')); };
      img.src = url;
    });
  }
  const w = bmp.width || bmp.naturalWidth, hh = bmp.height || bmp.naturalHeight;
  if (maxSide && Math.max(w, hh) > maxSide) {
    const k = maxSide / Math.max(w, hh);
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(hh * k));
    const c = makeCanvas(nw, nh); const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(bmp, 0, 0, nw, nh);
    if (bmp.close) bmp.close();
    return createImageBitmap(c);
  }
  if (!(bmp instanceof ImageBitmap)) return createImageBitmap(bmp);
  return bmp;
}

export function bitmapToImageData(bmp) {
  const c = makeCanvas(bmp.width, bmp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(bmp, 0, 0);
  return x.getImageData(0, 0, bmp.width, bmp.height);
}

export async function blobToImageData(blob, maxSide = 0) {
  const bmp = await decode(blob, maxSide);
  const d = bitmapToImageData(bmp);
  bmp.close && bmp.close();
  return d;
}

export async function imageDataToBlob(img, type = 'image/jpeg', quality = 0.92) {
  const c = makeCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  return canvasToBlob(c, type, quality);
}

export function canvasToBlob(c, type = 'image/jpeg', quality = 0.92) {
  if (c.convertToBlob) return c.convertToBlob({ type, quality });
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Encoding failed'))), type, quality));
}

/** Returns true if every pixel is gray (r=g=b); samples for speed. */
export function isGrayscale(img) {
  const d = img.data; const step = Math.max(4, Math.floor(d.length / 4 / 50000) * 4);
  for (let i = 0; i < d.length; i += step) if (d[i] !== d[i + 1] || d[i + 1] !== d[i + 2]) return false;
  return true;
}
export function isBinary(img) {
  const d = img.data; const step = Math.max(4, Math.floor(d.length / 4 / 50000) * 4);
  for (let i = 0; i < d.length; i += step) { const v = d[i]; if ((v !== 0 && v !== 255) || d[i + 1] !== v) return false; }
  return true;
}

export async function makeThumb(source, maxSide = 320) {
  const bmp = source instanceof Blob ? await decode(source, maxSide) : source;
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), hh = Math.max(1, Math.round(bmp.height * k));
  const c = makeCanvas(w, hh); const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, hh);
  x.drawImage(bmp, 0, 0, w, hh);
  if (source instanceof Blob && bmp.close) bmp.close();
  return canvasToBlob(c, 'image/jpeg', 0.8);
}

export async function imageSize(blob) {
  const b = await decode(blob);
  const r = { width: b.width, height: b.height };
  b.close && b.close();
  return r;
}

export function blankImageBlob(wPx, hPx, color = '#ffffff') {
  const c = makeCanvas(wPx, hPx); const x = c.getContext('2d');
  x.fillStyle = color; x.fillRect(0, 0, wPx, hPx);
  return canvasToBlob(c, 'image/png');
}
