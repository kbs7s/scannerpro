# Scanner bridge (optional)

Browsers cannot talk to USB, WIA, TWAIN, SANE or Apple ICA scanners. This is a browser security rule, not something the app can work around. To use a physical flatbed or document-feeder scanner, run this small helper on the computer the scanner is connected to. The web app then talks to it over `http://127.0.0.1:7800`.

The helper is one file, `scanner-bridge.js`, with no dependencies. It listens only on `127.0.0.1` (it is not reachable from the network) and only answers web pages from `https://kbs7s.github.io` and `localhost`.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer.
- One of these:
  - **NAPS2** (free, https://www.naps2.com) for USB scanners. NAPS2 uses WIA or TWAIN on Windows, SANE on Linux and Apple's scanner framework on macOS, so any scanner NAPS2 can see works.
  - A **network scanner that supports eSCL / AirScan / Mopria** (most Wi-Fi printers and MFPs made since about 2015). No extra software needed.

## Start it

```bash
# USB scanner through NAPS2 (auto-detected in its default install folder)
node scanner-bridge.js

# NAPS2 installed somewhere else
node scanner-bridge.js --naps2 "D:\Apps\NAPS2\NAPS2.Console.exe"

# Network (eSCL) scanner: use the scanner's IP address
node scanner-bridge.js --escl http://192.168.1.50/eSCL

# Hosting the app yourself on a different domain
node scanner-bridge.js --origin https://scanner.example.com

# Different port (then change the bridge address in the app's scanner panel)
node scanner-bridge.js --port 7801
```

Leave the window open while scanning. In the app, open **Scanner (USB/network)**, press **Connect**, pick a scanner, choose source (flatbed, feeder, duplex), colour, DPI and paper size, then **Preview** or **Scan**. Scanned pages are added to the current document and can be enhanced, OCR'd and exported like camera pages.

## Browser notes

- Chrome, Edge and Firefox allow an HTTPS page to call `http://127.0.0.1`. Chrome may ask permission to access devices on your local network: allow it. The bridge sends the `Access-Control-Allow-Private-Network` header Chrome requires.
- **Safari (macOS and iOS) blocks** HTTPS pages from calling `http://127.0.0.1`. On a Mac, use Chrome, Edge or Firefox for scanner work.
- Phones and tablets cannot run the bridge. Use the camera scanner there.

## API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/api/status` | `{ version, naps2: { found, path }, escl: [...] }` |
| GET | `/api/scanners` | `{ scanners: [{ id, name, backend, driver }] }` |
| POST | `/api/scan` | body `{ scannerId, source, color, dpi, paperSize, preview }`. NAPS2 returns `application/pdf`; eSCL returns `{ pages: [{ mime, data }] }` with base64 JPEGs. |

## Troubleshooting

- **"Bridge offline"**: the helper is not running, or another program uses port 7800.
- **No scanners listed with NAPS2**: open the NAPS2 app once and check it can see the scanner. Listing tries each driver (`wia`, `twain`, `escl` on Windows) and can take up to a minute.
- **"Origin not allowed"**: start the bridge with `--origin <your site>`.
- **eSCL scanner not found**: check the URL in a browser: `http://<ip>/eSCL/ScannerCapabilities` should return XML. Some models use `https://<ip>/eSCL` or a different port.

## What was tested

The eSCL code path, CORS rules and the HTTP API were tested against a mock eSCL device (`tests/bridge-escl-test.mjs`). The NAPS2 path was written to the NAPS2 console documentation but has **not** been run against a real scanner, since none was available while building this.
