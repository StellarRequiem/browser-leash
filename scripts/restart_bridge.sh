#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PIDF="$ROOT/receipts/bridge.pid"
LOG="$ROOT/receipts/bridge.log"
mkdir -p "$ROOT/receipts"
if [[ -f "$PIDF" ]]; then
  old=$(cat "$PIDF" 2>/dev/null || true)
  if [[ -n "${old:-}" ]] && kill -0 "$old" 2>/dev/null; then
    kill "$old" 2>/dev/null || true
    sleep 0.4
  fi
  rm -f "$PIDF"
fi
# also clear stray listeners on 8756 if any
if command -v lsof >/dev/null 2>&1; then
  for p in $(lsof -tiTCP:8756 -sTCP:LISTEN 2>/dev/null || true); do
    kill "$p" 2>/dev/null || true
  done
  sleep 0.2
fi
nohup python3 "$ROOT/bridge/server.py" >>"$LOG" 2>&1 &
echo $! >"$PIDF"
sleep 0.5
curl -s "http://127.0.0.1:8756/v1/status" || true
echo
echo "pid=$(cat "$PIDF") — Soft Reload Browser Leash extension if host allowlist changed"
