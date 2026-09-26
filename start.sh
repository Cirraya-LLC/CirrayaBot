#!/usr/bin/env bash
# One-command deploy. The first run generates .env (with a random access token); after that
# it is a plain compose up.
#
# It only does what compose can't:
#   1. generate POSTGRES_PASSWORD / ACCESS_TOKEN and the studio's secrets
#   2. write WORKSPACE_HOST_PATH as an ABSOLUTE path — Agent containers are siblings, so the
#      left side of -v must be a real host path; a relative path means nothing there
#   3. detect podman and point at the right socket
#   4. size the deployment to the machine (memory ceilings, and on a first run which optional
#      modules to start) and turn MODULES into compose profiles
#
# Optional modules (MODULES in .env, comma-separated): studio (the film studio), cli (Claude Code,
# Codex and Grok Build as agent runtimes, signed in once with your own accounts). Change it and
# rerun ./start.sh.
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

FIRST=0
if [ ! -f .env ]; then echo "First run, generating .env…"; cp .env.example .env; FIRST=1; fi

# Write one key: delete the old line, then append — not a sed substitution: any of / - & # in
# the value breaks the delimiter, and paths and random passwords can contain them (bitten once:
# the repo is called Multi-Agent, with a hyphen, and sed -i "s-...-...-" failed on the spot).
setkv() {
  grep -v "^$1=" .env > .env.tmp 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> .env.tmp
  mv .env.tmp .env
}
delkv() { grep -v "^$1=" .env > .env.tmp 2>/dev/null || true; mv .env.tmp .env; }
# Write only when the key has no value yet — an upgraded old deployment already has .env but
# lacks new keys like POSTGRES_PASSWORD, and compose errors out on missing values.
ensure() {
  if grep -q "^$1=..*" .env; then return 0; fi
  setkv "$1" "$2"
}
ensure POSTGRES_PASSWORD "$(rand)"
ensure ACCESS_TOKEN "$(rand)"
# The studio: the app talks to it with STUDIO_TOKEN; it logs into postgres as its own role.
ensure STUDIO_TOKEN "$(rand)"
ensure STUDIO_DB_PASSWORD "$(rand)"
ensure STUDIO_EVENT_TOKEN "$(rand)"
# ── Sizing ── Memory in MB (MEM_MB overrides the detection, e.g. to size for a smaller target).
mem_mb() {
  if [ -n "${MEM_MB:-}" ]; then echo "$MEM_MB"; return; fi
  if [ -r /proc/meminfo ]; then awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo; return; fi
  if command -v sysctl >/dev/null; then echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 4294967296) / 1048576 )); return; fi
  echo 4096
}
MEM=$(mem_mb)
# Under 6 GB, the ceilings for a 2-core / 4 GB box (they add up to ~2.5 GB); above, room to breathe.
# `ensure` only fills keys that are still empty: a value you set yourself is kept.
if [ "$MEM" -lt 6000 ]; then
  ensure DB_MEMORY 768m; ensure APP_MEMORY 768m; ensure STUDIO_MEMORY 1g; ensure CLI_MEMORY 1g
  ensure PG_SHARED_BUFFERS 128MB; ensure APP_HEAP_MB 384; ensure STUDIO_HEAP_MB 512; ensure CLI_HEAP_MB 512
else
  ensure DB_MEMORY 2g; ensure APP_MEMORY 1g; ensure STUDIO_MEMORY 2g; ensure CLI_MEMORY 2g
  ensure PG_SHARED_BUFFERS 256MB; ensure APP_HEAP_MB 512; ensure STUDIO_HEAP_MB 1024; ensure CLI_HEAP_MB 768
fi
if [ "$FIRST" = 1 ]; then
  # An Agent's own container (AGENT_TOOLS=on): 2 GB each would overcommit a 4 GB box at once.
  if [ "$MEM" -lt 6000 ]; then setkv AGENT_MEMORY 1g; setkv AGENT_CPUS 1; fi
  # Below 2 GB: the chat alone. (The studio peaks at ~150 MB making a sheet of eight 1080p HEVC
  # takes, ~250 MB assembling an episode — but a box that small has little to spare.)
  if [ "$MEM" -lt 2000 ]; then
    setkv MODULES ""
    echo "Only ${MEM} MB of memory: starting the chat alone. Add studio to MODULES later if the machine grows."
  fi
fi
# A deployment from before modules existed ran the studio: keep it that way.
if ! grep -q '^MODULES=' .env; then setkv MODULES "studio"; fi
# DeepSeek Harness was a module until 2.31; DeepSeek models now run like any other upstream.
# Drop it from MODULES and forget its settings (its container goes with --remove-orphans below).
if grep -q '^MODULES=.*dsh' .env; then
  setkv MODULES "$(grep '^MODULES=' .env | tail -n 1 | cut -d= -f2- | tr ',' '\n' | grep -vx 'dsh' | paste -sd, - || true)"
  echo "DeepSeek Harness is no longer part of this product: removed dsh from MODULES."
fi
delkv DSH_MEMORY; delkv DSH_CONTAINER

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

# ── Modules → profiles, and what the app is told exists ──
# (|| true: under pipefail a grep that finds nothing would end the script — 2.9.5's rule again.)
MODULES=$(grep '^MODULES=' .env | tail -n 1 | cut -d= -f2- | tr -d ' ' || true)
has() { case ",$MODULES," in *",$1,"*) return 0 ;; esac; return 1; }
for m in $(echo "$MODULES" | tr ',' ' '); do
  case "$m" in studio|cli) ;; *) echo "⚠️  MODULES: unknown module \"$m\" (known: studio, cli)" >&2 ;; esac
done
PROFILES=()
if has studio; then setkv STUDIO_URL http://studio:8090; PROFILES+=(--profile studio); else setkv STUDIO_URL ""; fi
# The cli container's name is fixed by compose (container_name), prefixed like agent containers so
# two deployments on one machine don't share one — and so don't share a login by accident.
PREFIX=$(grep '^AGENT_PREFIX=' .env | tail -n 1 | cut -d= -f2- || true)
if has cli; then setkv CLI_CONTAINER "${PREFIX:-ma}-cli"; PROFILES+=(--profile cli); else setkv CLI_CONTAINER ""; fi
# For a plain `docker compose up` later (podman-compose may ignore it: rerun this script there).
setkv COMPOSE_PROFILES "$MODULES"

# Free disk, measured: the images are ~1.2 GB with the studio, +1.2 GB for the agent image
# (AGENT_TOOLS=on), and building leaves a cache of the same order.
FREE_MB=$(df -Pm . | awk 'NR == 2 {print $4}')
if [ "${FREE_MB:-99999}" -lt 4000 ]; then
  echo "⚠️  Only ${FREE_MB} MB free here. After it is up, \`docker builder prune\` gives back the build cache." >&2
fi

# ${a[@]+"${a[@]}"}: an empty array under set -u is an error in bash 3.2 (macOS).
# --remove-orphans: the old DeepSeek Harness container, whose service no longer exists. Agent
# containers are started by the app, not compose, so it never touches them.
"${COMPOSE[@]}" ${PROFILES[@]+"${PROFILES[@]}"} up -d --build --remove-orphans
# A module switched off keeps running unless it is stopped: compose leaves other profiles alone.
for m in studio cli; do
  if ! has "$m"; then "${COMPOSE[@]}" --profile "$m" rm -s -f "$m" >/dev/null 2>&1 || true; fi
done

set -a; . ./.env; set +a
ADDR="${BIND_ADDR:-127.0.0.1}"
echo
echo "Up: http://${ADDR}:${WEB_PORT:-8080}/?k=${ACCESS_TOKEN}"
echo "Data lives in the pgdata volume; Agent workspaces in ./data/workspace"
echo "Modules: ${MODULES:-none (chat only)} · memory ${MEM} MB → ceilings in .env (*_MEMORY)"
echo "The first visit opens \"Model upstreams\" right away; add one and you are ready."
if [ "${AGENT_TOOLS:-off}" = on ]; then
  echo "⚠️  AGENT_TOOLS=on — whoever has the link above has a container shell."
fi
exit 0
