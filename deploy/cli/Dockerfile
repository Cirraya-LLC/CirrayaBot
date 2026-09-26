# The `cli` module: Claude Code, Codex and Grok Build, for agents whose runtime is one of them
# (web/cli.mjs). The app runs one process per turn in here with `docker exec`.
#
# The home directory is a named volume, and it is where each CLI keeps its login — signed in
# once (from the web UI, or `docker compose exec cli <claude|codex|grok> login`), every agent on
# that CLI uses it. That is the point of this container: the login lives here and nowhere else.
# Agents never get a shell in it — every built-in tool of the three CLIs is switched off per turn,
# and what the model can do goes through the app's tools, run in the agent's own container.
#
# Nothing here is published and nothing here is mounted from the host.
FROM node:24-slim

ARG CLAUDE_CODE_VERSION=2.1.283
ARG CODEX_VERSION=0.157.1
ARG GROK_VERSION=1.0.41

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git procps \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force
# Grok's installer puts the binary under the installing user's ~/.grok; move it onto the PATH so
# the unprivileged user below can run it, and leave nothing in root's home.
RUN curl -fsSL https://x.ai/cli/install.sh -o /tmp/grok-install.sh \
 && GROK_BIN_DIR=/tmp/grokbin bash /tmp/grok-install.sh ${GROK_VERSION} \
 && install -m 0755 "$(readlink -f /tmp/grokbin/grok)" /usr/local/bin/grok \
 && rm -rf /tmp/grok-install.sh /tmp/grokbin /root/.grok

# node (uid 1000) owns the home; the volume is initialised from it on first start.
RUN mkdir -p /home/node/work && chown -R node:node /home/node
USER node
ENV HOME=/home/node DISABLE_AUTOUPDATER=1 GROK_DISABLE_AUTOUPDATER=1
WORKDIR /home/node/work
CMD ["sleep", "infinity"]
