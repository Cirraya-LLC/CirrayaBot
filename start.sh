#!/usr/bin/env bash
# One-command deploy. The first run generates .env (with a random access token); after that
# it is a plain compose up.
#
#   ./start.sh                     deploy, or redeploy after changing .env
#   ./start.sh backup [dir]        database + workspace + .env into ./backups/<time> (or dir)
#   ./start.sh restore <dir> --yes put a backup back (the current workspace is kept aside)
#   ./start.sh upgrade             backup, git pull, redeploy
#
# It only does three things compose can't:
#   1. generate POSTGRES_PASSWORD / ACCESS_TOKEN
#   2. write WORKSPACE_HOST_PATH as an ABSOLUTE path — Agent containers are siblings, so the
#      left side of -v must be a real host path; a relative path means nothing there
#   3. detect podman and point at the right socket
set -euo pipefail
cd "$(dirname "$0")"

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose); RUNTIME=docker
elif command -v podman >/dev/null && podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose); RUNTIME=podman
elif command -v podman-compose >/dev/null; then
  COMPOSE=(podman-compose); RUNTIME=podman
else
  echo "Neither docker compose nor podman compose found; install one first" >&2; exit 1
fi

rand() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }

# ── backup / restore / upgrade ──────────────────────────────
# A backup is three files, and all three are needed: db.dump (pg_dump, custom format), workspace.tgz
# (every agent's desk, group drives, sent files — and .secret-key, without which the agents' stored
# secrets can't be opened) and env (this .env: the database password, the token, SECRET_KEY if set).
# It holds secrets: the directory is made private, and it belongs somewhere off this machine too.
backup() {
  [ -f .env ] || { echo "No .env here — nothing deployed to back up" >&2; exit 1; }
  local dir="${1:-backups/$(date +%Y%m%d-%H%M%S)}"
  mkdir -p "$dir"; chmod 700 "$dir"
  set -a; . ./.env; set +a
  echo "Backing up into $dir …"
  "${COMPOSE[@]}" exec -T db pg_dump -U multiagent -d multiagent -Fc > "$dir/db.dump"
  local ws="${WORKSPACE_HOST_PATH:-$(pwd)/data/workspace}"
  tar -czf "$dir/workspace.tgz" -C "$(dirname "$ws")" "$(basename "$ws")"
  cp .env "$dir/env"
  chmod 600 "$dir"/*
  echo "Done: $(du -sh "$dir" | cut -f1) in $dir  (db.dump, workspace.tgz, env — it holds secrets; keep a copy off this machine)"
}

restore() {
  local dir="${1:-}"
  [ -n "$dir" ] && [ -f "$dir/db.dump" ] && [ -f "$dir/workspace.tgz" ] || {
    echo "Usage: ./start.sh restore <backup dir> --yes   (a directory made by ./start.sh backup)" >&2; exit 1; }
  if [ "${2:-}" != --yes ]; then
    echo "This replaces the database and the workspace with the backup in $dir." >&2
    echo "The current workspace is moved aside, not deleted. Run again with --yes to go ahead." >&2; exit 1
  fi
  [ -f .env ] || { cp "$dir/env" .env; echo "No .env here: took the backup's"; }
  set -a; . ./.env; set +a
  local ws="${WORKSPACE_HOST_PATH:-$(pwd)/data/workspace}" stamp; stamp=$(date +%Y%m%d-%H%M%S)
  "${COMPOSE[@]}" up -d db
  "${COMPOSE[@]}" stop app
  echo "Restoring the database…"
  "${COMPOSE[@]}" exec -T db pg_restore -U multiagent -d multiagent --clean --if-exists --no-owner < "$dir/db.dump"
  echo "Restoring the workspace (the current one goes to ${ws}.before-restore-$stamp)…"
  if [ -d "$ws" ]; then mv "$ws" "${ws}.before-restore-$stamp"; fi
  mkdir -p "$(dirname "$ws")"
  tar -xzf "$dir/workspace.tgz" -C "$(dirname "$ws")"
  if [ "$(basename "$ws")" != workspace ] && [ -d "$(dirname "$ws")/workspace" ]; then mv "$(dirname "$ws")/workspace" "$ws"; fi
  # Agent containers mount the old directory (now moved aside): they go, and come back on their next turn.
  "$RUNTIME" rm -f $("$RUNTIME" ps -aq --filter "name=^${AGENT_PREFIX:-ma}-agent-") >/dev/null 2>&1 || true
  "${COMPOSE[@]}" up -d
  if ! cmp -s "$dir/env" .env; then
    echo "Note: this .env differs from the backup's ($dir/env). If this is a new machine, or SECRET_KEY changed, use the backup's."
  fi
  echo "Restored from $dir"
}

case "${1:-up}" in
  backup)  backup "${2:-}"; exit 0 ;;
  restore) restore "${2:-}" "${3:-}"; exit 0 ;;
  upgrade)
    [ -d .git ] || { echo "Not a git checkout: put the new version's files here, then run ./start.sh" >&2; exit 1; }
    backup
    before=$(git rev-parse HEAD)
    git pull --ff-only
    git --no-pager log --oneline "$before..HEAD" | head -30
    exec "$0" ;;
  up) ;;
  *) echo "Usage: ./start.sh [backup [dir] | restore <dir> --yes | upgrade]" >&2; exit 1 ;;
esac

[ -f .env ] || { echo "First run, generating .env…"; cp .env.example .env; }

# Write one key: delete the old line, then append — not a sed substitution: any of / - & # in
# the value breaks the delimiter, and paths and random passwords can contain them (bitten once:
# the repo is called Multi-Agent, with a hyphen, and sed -i "s-...-...-" failed on the spot).
setkv() {
  grep -v "^$1=" .env > .env.tmp 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> .env.tmp
  mv .env.tmp .env
}
# Write only when the key has no value yet — an upgraded old deployment already has .env but
# lacks new keys like POSTGRES_PASSWORD, and compose errors out on missing values.
ensure() {
  if grep -q "^$1=..*" .env; then return 0; fi
  setkv "$1" "$2"
}
ensure POSTGRES_PASSWORD "$(rand)"
ensure ACCESS_TOKEN "$(rand)"
ensure BIND_ADDR 127.0.0.1
ensure WEB_PORT 8080
ensure AGENT_TOOLS off

# Absolute path, rewritten every time: if the repo moved, the old value points at a missing
# directory and Agent containers would quietly mount that empty directory.
WS="$(pwd)/data/workspace"
mkdir -p "$WS"
setkv WORKSPACE_HOST_PATH "$WS"

# Upgrading from the old layout: old data is in ./workspace, the new home is ./data/workspace.
# Without moving it, the first start imports an empty directory and the UI looks like
# "all groups and chat history are gone".
if [ -d workspace ] && [ -z "$(ls -A "$WS" 2>/dev/null)" ]; then
  echo "Moving the old ./workspace into $WS …"
  cp -a workspace/. "$WS"/
fi

# podman's socket isn't /var/run/docker.sock, and rootless differs from root
if [ "$RUNTIME" = podman ] && ! grep -q '^DOCKER_SOCK=..*' .env; then
  for sock in "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock" /run/podman/podman.sock; do
    if [ ! -S "$sock" ]; then continue; fi
    ensure DOCKER_SOCK "$sock"; echo "podman socket: $sock"; break
  done
  grep -q '^DOCKER_SOCK=..*' .env || {
    echo "⚠️  podman socket not found. Run once: systemctl --user enable --now podman.socket" >&2; exit 1; }
fi

# HTTPS: a domain in PUBLIC_HOST turns the Caddy service on (compose reads COMPOSE_PROFILES from .env).
if grep -q '^PUBLIC_HOST=..*' .env; then setkv COMPOSE_PROFILES https; else setkv COMPOSE_PROFILES ""; fi

"${COMPOSE[@]}" up -d --build

set -a; . ./.env; set +a
ADDR="${BIND_ADDR:-127.0.0.1}"
echo
echo "Up: http://${ADDR}:${WEB_PORT:-8080}/?k=${ACCESS_TOKEN}"
if [ -n "${PUBLIC_HOST:-}" ]; then
  echo "    https://${PUBLIC_HOST}/?k=${ACCESS_TOKEN}   (the certificate is fetched on the first visit; give it a few seconds)"
fi
echo "Data lives in the pgdata volume; Agent workspaces in ./data/workspace"
echo "The first visit opens \"Model upstreams\" right away; add one and you are ready."
if [ "${AGENT_TOOLS:-off}" = on ]; then
  echo "⚠️  AGENT_TOOLS=on — whoever has the link above has a container shell."
fi
exit 0
