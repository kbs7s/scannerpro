// Generates synthetic test fixtures in tests/fixtures using the real browser text engine:
//  doc-flat.png   : clean Arabic+English document page
//  doc-photo.jpg  : the same page photographed: perspective, rotation, shadow gradient, dark table
//  doc-skew.png   : the flat page rotated by 4 degrees
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.env.BASE || 'http://localhost:8080/';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base + 'tests/blank.html');
const out = await page.evaluate(async () => {
  const f1 = new FontFace('Cairo', 'url(../assets/fonts/cairo-arabic-600-normal.woff2)', { unicodeRange: 'U+0600-06FF, U+0750-077F, U+FB50-FDFF, U+FE70-FEFF' });
  const f2 = new FontFace('Cairo', 'url(../assets/fonts/cairo-latin-600-normal.woff2)');
  await f1.load(); await f2.load(); document.fonts.add(f1); document.fonts.add(f2);
  const W = 1240, H = 1754; // A4 @150dpi
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#fbfaf6'; x.fillRect(0, 0, W, H);
  x.fillStyle = '#111';
  x.direction = 'rtl'; x.textAlign = 'right';
  x.font = '600 64px Cairo'; x.fillText('تقرير الفحص الطبي', W - 110, 190);
  x.font = '600 40px Cairo';
  const ar = ['اسم المريض: أحمد علي حسن', 'تاريخ الفحص: الخامس من نوفمبر', 'النتيجة: سليم ولا توجد ملاحظات', 'يرجى مراجعة الطبيب بعد شهر'];
  ar.forEach((t, i) => x.fillText(t, W - 110, 330 + i * 80));
  x.direction = 'ltr'; x.textAlign = 'left';
  x.font = '600 44px Cairo'; x.fillText('Medical Examination Report', 110, 760);
  x.font = '600 38px Cairo';
  const en = ['Patient Name: Ahmed Ali Hassan', 'Hospital Number: 482913', 'Result: Normal findings', 'Signature and stamp below'];
  en.forEach((t, i) => x.fillText(t, 110, 860 + i * 76));
  x.strokeStyle = '#333'; x.lineWidth = 3; x.strokeRect(110, 1250, W - 220, 300);
  x.font = '600 34px Cairo'; x.fillText('Invoice Total: 125,000 IQD', 150, 1330);
  const flat = c.toDataURL('image/png');
  // skewed copy
  const s = document.createElement('canvas'); s.width = W + 200; s.height = H + 200;
  const sx = s.getContext('2d'); sx.fillStyle = '#fff'; sx.fillRect(0, 0, s.width, s.height);
  sx.translate(s.width / 2, s.height / 2); sx.rotate(4 * Math.PI / 180); sx.drawImage(c, -W / 2, -H / 2);
  const skew = s.toDataURL('image/png');
  // photo: dark wooden table, perspective-ish quad via triangle mapping, shadow
  const P = document.createElement('canvas'); P.width = 1600; P.height = 2000;
  const p = P.getContext('2d');
  const g = p.createLinearGradient(0, 0, 1600, 2000); g.addColorStop(0, '#3b2a1e'); g.addColorStop(1, '#1f150e');
  p.fillStyle = g; p.fillRect(0, 0, 1600, 2000);
  for (let i = 0; i < 4000; i++) { p.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`; p.fillRect(Math.random() * 1600, Math.random() * 2000, 2, 2); }
  const dst = [[230, 180], [1380, 260], [1440, 1830], [150, 1760]];
  // draw via two affine triangles (approximate perspective)
  function tri(s0, s1, s2, d0, d1, d2) {
    p.save(); p.beginPath(); p.moveTo(...d0); p.lineTo(...d1); p.lineTo(...d2); p.closePath(); p.clip();
    const [x0, y0] = s0, [x1, y1] = s1, [x2, y2] = s2, [u0, v0] = d0, [u1, v1] = d1, [u2, v2] = d2;
    const den = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const a = ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / den, b = ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / den;
    const cc = ((v1 - v0) * (y2 - y0) - (v2 - v0) * (y1 - y0)) / den, d = ((v2 - v0) * (x1 - x0) - (v1 - v0) * (x2 - x0)) / den;
    p.setTransform(a, cc, b, d, u0 - a * x0 - b * y0, v0 - cc * x0 - d * y0);
    p.drawImage(c, 0, 0); p.restore();
  }
  tri([0, 0], [W, 0], [W, H], dst[0], dst[1], dst[2]);
  tri([0, 0], [W, H], [0, H], dst[0], dst[2], dst[3]);
  // shadow gradient across the page (hand / phone shadow)
  p.save(); p.beginPath(); dst.forEach((q, i) => i ? p.lineTo(...q) : p.moveTo(...q)); p.closePath(); p.clip();
  const sg = p.createRadialGradient(300, 1700, 50, 300, 1700, 1300); sg.addColorStop(0, 'rgba(0,0,0,0.55)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
  p.fillStyle = sg; p.fillRect(0, 0, 1600, 2000);
  const lg = p.createLinearGradient(0, 0, 1600, 0); lg.addColorStop(0, 'rgba(255,240,200,0.10)'); lg.addColorStop(1, 'rgba(0,0,30,0.25)');
  p.fillStyle = lg; p.fillRect(0, 0, 1600, 2000); p.restore();
  return { flat, skew, photo: P.toDataURL('image/jpeg', 0.9), dst };
});
const save = (n, d) => fs.writeFileSync('tests/fixtures/' + n, Buffer.from(d.split(',')[1], 'base64'));
save('doc-flat.png', out.flat); save('doc-skew.png', out.skew); save('doc-photo.jpg', out.photo);
fs.writeFileSync('tests/fixtures/doc-photo.corners.json', JSON.stringify(out.dst));
await browser.close();
console.log('fixtures written');
