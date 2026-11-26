# Testing

This file lists what was actually tested, how, and what was not. Nothing here is marked as passing unless the test was run and passed.

All automated tests ran on 26 November 2026 in **headless Chromium** (the Playwright build) on Linux, against the app served by a local static server (`python3 -m http.server 8080`). No real phone, real camera, real scanner, Safari or Firefox was available in the build environment.

## How to run

```bash
python3 -m http.server 8080 &              # from the repository root
npm i -g playwright && npx playwright install chromium   # once, if you don't have it
node tests/make-fixtures.mjs               # regenerates the test images (already committed)
node tests/worker-smoke.mjs                # image engine
node tests/e2e.mjs                         # main app flows (needs pdftotext/pdfinfo from poppler-utils)
ffmpeg -loop 1 -i tests/fixtures/doc-photo.jpg -vf "scale=768:960,pad=1280:960:256:0:0x2a2018,format=yuv420p" -t 6 -r 15 tests/output/cam.y4m
node tests/camera-test.mjs                 # camera scan with Chromium's simulated camera
node tests/diagnostics-test.mjs            # in-app diagnostic checks + language switch
node tests/bridge-escl-test.mjs            # scanner bridge against a mock eSCL scanner
```

Test images are generated, not real photos: `doc-photo.jpg` is a bilingual (Arabic/English) "medical report" drawn with the Cairo font, then placed in perspective on a dark background with uneven lighting and a shadow. Its true corner positions are stored in `doc-photo.corners.json`. `doc-skew.png` is a flat page rotated by exactly 4°.

## Results

### Image engine (`tests/worker-smoke.mjs`), passed
- OpenCV.js 4.10 starts in the worker in about 0.4 s; jscanify loads.
- Document detection on the perspective photo: corners within about 5 px of the truth, confidence 1.0; dark background and uneven lighting detected.
- Clean white, black & white and text presets produce correct output (shadow removed, checked visually in `tests/output/worker-*.png`).
- Deskew measured 4.00° on the 4° page. Orientation check detected a sideways page. Multi-document detection found 1 document.

### Main app (`tests/e2e.mjs`), 24 of 24 passed
| Area | Check |
| --- | --- |
| Language | Starts in Arabic, right-to-left |
| Import + auto-crop | Importing the photo finds the page corners (max error 7.1 px of 1600×2000) and renders a flattened page |
| Presets | 20 preset buttons; Black & white output downloads as lossless PNG; Undo restores the previous preset |
| OCR | Arabic + English in one pass: English words and the number 482913 read correctly, Arabic words read; 45 word boxes stored |
| Searchable PDF | `pdftotext` extracts both the English and the Arabic text from the exported PDF |
| PDF export | Exported PDF is one A4 page (595×842 pt) |
| Deskew | Measured 4.00° on the 4° page |
| Page order | Drag-and-drop of thumbnails moves page 3 to the front |
| Print | Print layout (Chromium print emulation to PDF) gives 3 A4 pages for 3 scanned pages |
| Autosave | After a reload, the session reopens the same document with 3 pages and its OCR text |
| Backup | Project saved as `.sspz` (944 KB), then restored as a copy with all 3 pages |
| Offline | With the network switched off, the app reloads from the service-worker cache, the library shows both documents, and the Arabic OCR model is served from cache |
| Phone layout | At 390×844 the bottom navigation shows and the page never scrolls or overflows horizontally |
| Errors | No uncaught JavaScript errors or failed requests during the run |

### Camera (`tests/camera-test.mjs`), passed
Chromium's simulated camera played a video of the test photo. The camera started (1280×960), live detection outlined the page, auto-capture fired by itself once the page was steady, and the captured page was added with its corners and flattened. Screenshots: `tests/output/camera-live.png`, `camera-result.png`.

### Diagnostics (`tests/diagnostics-test.mjs`), passed
All checks run: service worker active, all 66 files cached, OpenCV, PDF.js, pdf-lib, JSZip, Tesseract and all three language models available, IndexedDB read/write works. Expected warnings in a headless browser: no camera, no scanner bridge, storage not persistent, no Web Share. Switching to English flips the page to left-to-right with English labels.

### Scanner bridge (`tests/bridge-escl-test.mjs`), 9 of 9 passed, mock device only
Against a mock eSCL scanner: CORS allows the GitHub Pages site and refuses other sites, the Private Network Access header is sent, the scanner is listed by name, a flatbed scan returns the page unchanged, the scan settings sent to the scanner are correct (source, colour mode, 300 DPI, A4 size), and a duplex feeder scan returns all pages.

## Bugs found by these tests and fixed

- On phones, the closed bottom sheets could scroll the whole page up, hiding the top bar. Fixed by clipping the workspace.
- OCR language check went to the network even when offline, logging failed requests. It now checks the offline cache first.
- Page thumbnails could briefly show broken images when re-rendered. Fixed by releasing old images later.
- Library filters on phones were squeezed to empty boxes, and the favourite/text filter chips showed a pill inside a pill. Fixed in CSS.

## Not tested (needs real hardware or other browsers)

- **Real phones and real cameras**: focus, torch, zoom, 4K capture, hand shake, real lighting. Only Chromium's simulated camera was used.
- **Safari / iOS and Firefox**: not available here. The code avoids Chromium-only APIs or checks for them, but nothing was run in those browsers.
- **Installing the PWA** to a home screen or desktop.
- **Real scanners**: the NAPS2 path has not been run at all; the eSCL path only against a mock.
- **Web Share** (not available in headless Chromium) and **real printing** (only print layout to PDF was checked).
- **Very large batches** (hundreds of pages) and low-memory phones.
- **Handwriting OCR** and low-quality real photos. OCR was tested only on clean, generated text.
- The paper-size guess from a photo is approximate (the test photo was guessed as Letter rather than A4 because of perspective).

Please try the app on your own phone and report anything that misbehaves; the Diagnostics screen has a "Copy debug info" button for that.
