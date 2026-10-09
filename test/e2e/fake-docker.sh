#!/usr/bin/env bash
# Stands in for the docker CLI in the end-to-end tests: nothing runs. Every call is logged
# (FAKE_DOCKER_LOG), an exec answers with what it was asked to run, and the container always
# looks absent to inspect, so the server takes its "create" path.
[ -n "$FAKE_DOCKER_LOG" ] && printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) exit 1 ;;
  exec)
    # The last argument is the command (bash -c / -lc <cmd> ...); show it back like a shell would.
    cat >/dev/null 2>&1    # the server always closes stdin; reading it avoids a broken pipe on big inputs
    echo "ran: ${@: -1}"
    exit 0 ;;
  *) exit 0 ;;
esac
