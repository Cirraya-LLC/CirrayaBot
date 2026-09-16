#!/usr/bin/env bash
# ⚠️ This is NOT the product's start script — the product uses ./start.sh.
# This starts the earlier experiment running DeepSeek Harness's built-in web UI; kept for the record.
# Listens on 127.0.0.1 by default — dsh web has no authentication at all and the Operator bot
# has bash, so exposing it to the internet hands out a root shell.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Missing .env: cp .env.example .env and fill it in first" >&2; exit 1; }
set -a; . ./.env; set +a
# ⚠️ Put bots/ into dsh's shipped preset root.
#
# roots can't be set with --patch: dsh's launcher (profile-boot) appends an overlay after all
# patches that unconditionally hard-codes agent-presets.roots to ONLY the shipped root. Other
# config fields survive via spread, roots alone is dropped — and --dump-config doesn't show it,
# since it prints the patch composition without the launcher step. (CLAUDE.md 2.9.4)
SHIPPED=$(find node_modules/.pnpm -type d -path '*/@deepseek-ai/dsh/config/agent-presets' 2>/dev/null | head -1)
[ -n "$SHIPPED" ] || { echo "dsh shipped preset root not found; run pnpm install first" >&2; exit 1; }
# Must be a COPY, not a symlink: discovery uses readdir(withFileTypes) + dirent.isDirectory(),
# and a symlink's dirent is isSymbolicLink() with isDirectory() false, so it is silently skipped.
for d in bots/*/; do
  name=$(basename "$d")
  rm -rf "${SHIPPED:?}/$name"
  cp -r "$d" "$SHIPPED/$name"
done

# Before starting, stop the previous run holding the port.
# Don't use `pkill -f "<pattern>"` — the pattern appears in the caller's own command line, so
# pkill kills its own shell too (exit 144). Bitten twice.
PORT="${PORT:-3080}"
old=$(ss -ltnp 2>/dev/null | grep -oP ":$PORT\\b.*pid=\\K[0-9]+" | head -1 || true)
if [ -n "${old:-}" ]; then   # if, not `[ ] && {}`: under set -e a false condition exits the whole script
  echo "Stopping the previous run (pid $old)"
  kill "$old" 2>/dev/null || true
  sleep 2
fi
# --trusted-host: dsh's /api has a browser-trust fence that only accepts its own authority.
# Behind a reverse proxy the Host is the public address, and without this API calls are
# blocked — symptom: the page opens, zero console errors, but the preset picker and
# workspace list never appear. Both host and host:port are given — browsers omit the port
# on default ports but other entries (not 80/443) include it; declaring both avoids guessing.
TRUSTED=""
if [ -n "${PUBLIC_HOST:-}" ]; then
  TRUSTED="--trusted-host $PUBLIC_HOST --trusted-host $PUBLIC_HOST:$PORT --trusted-host $PUBLIC_HOST:80"
fi

# ⚠️ BIND_HOST=0.0.0.0 puts the service straight on the internet WITH NO AUTHENTICATION.
# The Operator bot has bash, so that hangs this machine's root shell on the internet for
# anyone who scans the port. Leave empty to listen on 127.0.0.1 only (default, safe).
BIND=""
if [ -n "${BIND_HOST:-}" ]; then
  BIND="--host $BIND_HOST"
  [ "$BIND_HOST" = "0.0.0.0" ] && echo "⚠️  Exposing unauthenticated Multi-Agent to the internet on :$PORT" >&2
fi

exec ./node_modules/.bin/dsh --profile web --patch ./bots.patch.yml --no-open $BIND $TRUSTED "$@"
