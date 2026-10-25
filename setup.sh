#!/usr/bin/env bash
# HiperMove setup for macOS / Linux
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Install Node.js LTS from https://nodejs.org first."; exit 1; }
node -v
npm install
npm test
if [ ! -f .env ]; then
  read -rp "Paste your Gemini API key (https://aistudio.google.com/apikey): " KEY
  printf "GEMINI_API_KEY=%s\nGEMMA_MODEL=gemma-4-26b-a4b-it\nPORT=3000\n" "$KEY" > .env
fi
npm start & SERVER=$!
sleep 4
node scripts/check-gemma.js || true
(command -v open >/dev/null && open http://localhost:3000) || (command -v xdg-open >/dev/null && xdg-open http://localhost:3000) || true
echo "Server running at http://localhost:3000 (Ctrl+C to stop)"
wait $SERVER
