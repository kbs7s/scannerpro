#!/bin/bash
# Double-click to run Smart Scanner Pro on this computer (no internet needed).
cd "$(dirname "$0")/.." || exit 1
if command -v node >/dev/null 2>&1; then exec node run-local/server.js; fi
if command -v python3 >/dev/null 2>&1; then
  echo "Node.js not found, using Python. Open http://localhost:8090/ in Chrome, Edge."
  (sleep 1; xdg-open "http://localhost:8090/") &
  exec python3 -m http.server 8090 --bind 127.0.0.1
fi
echo "Please install Node.js from https://nodejs.org, then run this again."; read -r
