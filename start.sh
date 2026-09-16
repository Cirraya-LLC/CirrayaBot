#!/usr/bin/env bash
# One-command deploy. The first run generates .env (with a random access token); after that
# it is a plain compose up.
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

"${COMPOSE[@]}" up -d --build

set -a; . ./.env; set +a
ADDR="${BIND_ADDR:-127.0.0.1}"
echo
echo "Up: http://${ADDR}:${WEB_PORT:-8080}/?k=${ACCESS_TOKEN}"
echo "Data lives in the pgdata volume; Agent workspaces in ./data/workspace"
echo "The first visit opens \"Model upstreams\" right away; add one and you are ready."
if [ "${AGENT_TOOLS:-off}" = on ]; then
  echo "⚠️  AGENT_TOOLS=on — whoever has the link above has a container shell."
fi
exit 0
