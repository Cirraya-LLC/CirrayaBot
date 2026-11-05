#!/usr/bin/env bash
# Stands in for the docker CLI in the end-to-end tests: nothing runs. Every call is logged
# (FAKE_DOCKER_LOG), an exec answers with what it was asked to run, and the container always
# looks absent to inspect, so the server takes its "create" path. Containers it was asked to
# run are remembered (next to the log) so ps / stop / rm answer like the real thing.
[ -n "$FAKE_DOCKER_LOG" ] && printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
STATE="${FAKE_DOCKER_LOG:-/dev/null}.containers"
forget() { [ -f "$STATE" ] && grep -vxF -- "$1" "$STATE" > "$STATE.tmp"; mv -f "$STATE.tmp" "$STATE" 2>/dev/null; true; }
case "$1" in
  inspect) exit 1 ;;
  run)
    prev=''; for a in "$@"; do [ "$prev" = --name ] && echo "$a" >> "$STATE"; prev="$a"; done
    exit 0 ;;
  ps) [ -f "$STATE" ] && sort -u "$STATE"; exit 0 ;;
  stop) forget "${@: -1}"; exit 0 ;;
  rm) forget "${@: -1}"; exit 0 ;;
  stats) echo "0.00%"; exit 0 ;;
  exec)
    body=$(cat 2>/dev/null)    # the server always closes stdin; reading it avoids a broken pipe on big inputs
    # What listens inside: nothing, in here.
    case "${@: -1}" in *"/proc/net/tcp"*) exit 0 ;; esac
    # A helper's /work/out: as big as <log>.helper-out says (absent: empty, nothing to copy back).
    case "${@: -1}" in *"du -sb /work/out"*) [ -f "$STATE.helper-out" ] && cat "$STATE.helper-out"; exit 0 ;; esac
    # The browser daemon: a test that wrote <log>.browser gets that as every answer, and the requests are kept.
    if [ "${@: -1}" = "http://127.0.0.1:9230/" ] && [ -f "$STATE.browser" ]; then
      [ -n "$body" ] && printf '%s\n' "$body" >> "$STATE.browser-calls"
      cat "$STATE.browser"; exit 0
    fi
    # The last argument is the command (bash -c / -lc <cmd> ...); show it back like a shell would.
    echo "ran: ${@: -1}"
    exit 0 ;;
  *) exit 0 ;;
esac
