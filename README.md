# الاسكنر الذكي الاحترافي — Smart Scanner Pro

A document scanner that runs entirely in the browser: scan with the camera, crop and flatten pages, clean them up, read Arabic and English text with OCR, and export searchable PDFs. It is a static Progressive Web App hosted on GitHub Pages. It installs on phones and computers and works offline after the first visit.

**Your documents never leave your device.** There is no server, no account, no upload, no analytics and no third-party CDN. All libraries, fonts and OCR models are bundled with the app.

Live app (after deployment): **https://kbs7s.github.io/scannerpro/**

Arabic (right-to-left) is the default interface language. English is one tap away (the `EN` / `ع` button).

---

## Features

**Camera scanning**
- Live document edge detection on the camera preview (OpenCV.js in a Web Worker, so the preview stays smooth).
- Auto-capture when the page is held steady, manual shutter, self-timer, continuous multi-page mode.
- Modes: document, book (splits two facing pages, right page first for Arabic), ID card (front + back combined on one A4 page), passport, receipt, business card, several documents at once.
- Camera switching, resolution (up to 4K where the camera supports it), torch, focus/exposure/zoom where the browser exposes them.
- Clear messages for blocked permission, no camera, camera in use, or a non-HTTPS page.

**Cropping and geometry**
- Automatic crop with four detection strategies (adaptive Canny edges, Otsu threshold, colour gradients, jscanify) scored against each other, plus a confidence value.
- Manual four-corner editor with magnifier, edge handles and numeric coordinates.
- Perspective correction, 90° rotation, fine rotation, flip, automatic deskew (Hough lines + projection profile), automatic orientation, border removal, book gutter split.

**Enhancement**
- 20 presets: Original, Auto, Colour document, Clean white, Black & white, Grayscale, High contrast, Text clarity, Old document, Receipt, Book page, ID card, Medical report, Handwriting, Low light, Shadow removal, Faded text, Photocopy, Legal document, Newspaper.
- Shadow and uneven-light removal, background whitening, paper colour, denoise, sharpen, CLAHE, levels, gamma, temperature, black & white with adaptive / Otsu / fixed threshold, speckle removal, morphology.
- Every edit is non-destructive: the original photo is kept, and edits can be undone, redone, compared side by side, saved as custom presets and applied to many pages at once.

**Pages and documents**
- Thumbnails with drag-and-drop reordering (mouse and touch), multi-select, duplicate, delete, insert blank page, replace a page from a file or camera, split and extract.
- Local archive: titles, categories, tags, notes, favourites, trash with restore, date filters and search that also searches OCR text (with Arabic letter normalisation).
- Everything autosaves to IndexedDB. After a crash or a closed tab, the last session reopens.
- Backup and restore: one project as a `.sspz` file, or the whole archive as a `.zip`.

**OCR**
- Tesseract.js with Arabic, English and French models stored in the app (French is optional).
- Edit and copy the recognised text, export it as `.txt`, search inside a page with highlighted word boxes.
- Searchable PDF: an invisible text layer is placed exactly over each page image, so the PDF can be searched and text selected in any PDF reader.

**PDF**
- Import PDFs (choose pages and DPI), merge, split, extract, reorder, rotate and delete pages without re-encoding (pdf-lib).
- Export with page size (A3, A4, A5, Letter, Legal, original), orientation, margins, fit mode, quality, DPI, colour mode, metadata, page numbers, header, footer and watermark (Arabic text supported), with a live preview.
- Export images as JPEG/PNG/ZIP, share via the system share sheet, print with correct page sizes.

**Physical scanners (optional)**
- USB and network scanners through a small helper program you run on your computer (`bridge/`). See [bridge/README.md](bridge/README.md).

**Other**
- Diagnostic centre that actually tests each part (service worker, cache, OpenCV, PDF libraries, OCR models, IndexedDB, storage quota, camera, scanner bridge).
- Settings for language, theme, export defaults, camera, detection sensitivity, enhancement defaults, OCR and storage.
- Keyboard shortcuts (press `?` in the app).
- Responsive layouts for phones (bottom navigation and sheets), tablets and desktops, light and dark themes.

---

## Deploying to GitHub Pages

The repository contains a ready workflow (`.github/workflows/deploy.yml`).

1. Create a public repository on GitHub (for example `scannerpro`) and push these files to its `main` branch.
2. Open the repository's **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Open the **Actions** tab. The "Deploy to GitHub Pages" workflow runs on every push to `main` (you can also start it by hand). It generates the service-worker file list, then publishes the site.
4. When it finishes, the app is at `https://<your-user>.github.io/<repo>/`.
5. On a phone, open that address. Android Chrome shows **Install app**; on iPhone and iPad use **Share → Add to Home Screen**. Open the app once while online so it can store the OCR models for offline use. **Diagnostics → Download everything for offline use** forces this.

No build step, bundler or `npm install` is needed. All paths are relative, so the app works in any sub-folder.

### Saving and offline use

- Every document, page, edit and OCR result is saved automatically inside your browser on your device (IndexedDB). Nothing is uploaded. After the first save the app asks the browser to keep this data permanently so it isn't cleared when space runs low.
- After the first visit, the whole app, including the OCR models, is stored for offline use. You can turn off Wi-Fi and mobile data and keep scanning, running OCR and exporting PDFs.
- To keep a copy outside the browser, use **Save** (one project as a `.sspz` file) or **Settings → Storage → Backup** (everything as a `.zip`). Open either file later to restore.

### Run it on your own computer (no website, no internet)

1. On GitHub, press **Code → Download ZIP** and unzip it (or `git clone` the repository).
2. Open the `run-local` folder and double-click the starter for your system:
   - Windows: `start-windows.bat`
   - macOS: `start-mac.command` (the first time, right-click it and choose **Open**)
   - Linux: `start-linux.sh`
3. The app opens at `http://localhost:8090/` in your browser. Keep the small window open while you work.

The starter needs [Node.js](https://nodejs.org) (or Python as a fallback). It serves only the app's own files and only to this computer. After the first run the app is cached by the browser, so `http://localhost:8090/` keeps opening, with all your saved documents, even when the starter is closed and there is no internet. You can also install it from there as an app (the install icon in Chrome or Edge's address bar).

Documents saved at `http://localhost:8090/` are separate from the ones saved on the GitHub Pages site, because browsers keep each address's data apart. Use **Save** / **Backup** and open the file on the other one to move documents across.

### Running locally for development

Any static server works. The camera requires HTTPS or `localhost`.

```bash
python3 -m http.server 8080
# open http://localhost:8080/
```

After changing files, run `node tools/gen-precache.mjs` so the service worker caches the new versions (the GitHub workflow does this automatically).

---

## Project structure

```
index.html              App shell (also contains the icon sprite)
manifest.json           PWA manifest (installable, file handlers for PDF and images)
service-worker.js       Offline cache (file list generated by tools/gen-precache.mjs)
css/                    main.css, desktop.css, tablet.css, mobile.css, print.css
js/app.js               Wiring: views, workspace, panels, settings, shortcuts
js/scanner.js           Camera scanning UI, live detection, auto-capture, scan modes
js/camera.js            getUserMedia wrapper, capabilities, torch, capture
js/detection.js         Document detection front-end
js/perspective.js       Manual 4-corner crop editor
js/enhancement.js       Presets and adjustment controls (incl. shadow/background cleaning)
js/render.js            Background rendering of edited pages and thumbnails
js/viewer.js            Zoom/pan viewer, compare view, OCR word boxes
js/workers/image-worker.js   OpenCV.js + jscanify: detection, warp, enhancement, deskew
js/cv-client.js         Worker pool for image-worker.js
js/ocr.js               Tesseract.js OCR, languages, text-layer PDFs
js/pdf-manager.js       PDF import and PDF tools (merge/split/extract/reorder/rotate)
js/pdf-export.js        PDF/image export, searchable PDF, preview, share
js/print.js             Printing
js/project.js           Documents and pages model, autosave
js/archive.js           Library, categories, search, trash
js/database.js          IndexedDB
js/storage.js           Quota, persistence, backup and restore
js/batch.js             Batch queue with progress, pause, cancel, retry
js/bridge.js            Client for the local scanner bridge
js/diagnostics.js       Diagnostic centre
js/history.js           Undo / redo
js/i18n.js              Arabic and English text
js/settings.js, ui.js, util.js, image-io.js, pwa.js, version.js
libs/                   OpenCV.js 4.10, jscanify 1.4, PDF.js 3.11, pdf-lib 1.17, JSZip 3.10, Tesseract.js 5.1 (+ cores)
models/                 ara / eng / fra .traineddata.gz (tessdata_fast)
assets/                 Icons, Cairo font (OFL), images
bridge/                 Optional scanner helper (Node.js, NAPS2 / eSCL)
run-local/              Starters to run the app from a downloaded copy (no website needed)
tools/                  Precache generator, icon builders
tests/                  Test fixtures and Playwright tests
docs/TESTING.md         What was tested and how
```

Differences from the original plan: background cleaning lives in `image-worker.js` and `enhancement.js` instead of a separate `background-cleaner.js`; OCR runs in Tesseract.js's own worker instead of a separate `ocr-worker.js`; batch processing uses the existing workers through `batch.js` instead of a `batch-worker.js`. The OCR models sit directly in `models/` because Tesseract.js loads all languages from one folder.

---

## Browser support and limits

| | Chrome / Edge (Android, Windows, macOS, Linux) | Safari (iOS, macOS) | Firefox |
| --- | --- | --- | --- |
| Camera scanning | Yes | Yes (iOS 14.3+) | Yes |
| Torch, focus, zoom controls | Where the device allows | No (Safari does not expose them) | Limited |
| Install as app | Yes | Add to Home Screen | Desktop: no install prompt |
| Offline | Yes | Yes | Yes |
| Share sheet | Yes (Android, Windows, ChromeOS) | Yes | No (download instead) |
| USB/network scanner bridge | Yes | No (Safari blocks local HTTP from HTTPS pages) | Yes |

- A web page cannot talk to USB/TWAIN/WIA scanners on its own. The optional bridge is the only way, and it runs on a computer, not a phone.
- OCR quality depends on the photo. Sharp, evenly lit, flat pages work best; handwriting is recognised poorly by Tesseract.
- iOS may delete the app's stored data if the app isn't used for several weeks unless it is installed to the Home Screen. Make backups of important documents. "Request persistent storage" in Diagnostics asks the browser to protect storage, but the browser decides.
- Very large pages are processed at up to 4000 px on the long side by default (changeable in Settings) so phones don't run out of memory.
- The paper-size guess (A4, Letter, …) from a photo is approximate.

## Privacy

All processing happens on your device. The app makes no network requests except loading its own files from the same site. The scanner bridge, if you use it, runs on your own computer and only listens on `127.0.0.1`.

## Testing

See [docs/TESTING.md](docs/TESTING.md) for what was tested automatically, what was tested by hand, and what could not be tested.

## Licences

The app code is yours to use. Bundled libraries keep their own licences, included next to each library: OpenCV (Apache 2.0), jscanify (MIT), PDF.js (Apache 2.0), pdf-lib (MIT), JSZip (MIT/GPLv3), Tesseract.js (Apache 2.0), tessdata models (Apache 2.0), Cairo font (SIL OFL 1.1), Lucide icons (ISC).
