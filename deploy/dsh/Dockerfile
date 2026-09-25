# DeepSeek Harness (dsh) for agents whose model is deepseek-* — see web/dsh.mjs and run.mjs.
#
# pnpm, not npm: every dsh package is a prerelease range, and npm's resolver hung for 20 minutes
# on them (CLAUDE.md 2.9.3). The lockfile pins all ~560 packages; they ship prebuilt binaries, so
# no compiler is needed.
FROM node:24-slim
WORKDIR /opt/dsh
COPY package.json pnpm-lock.yaml ./
# pnpm is only the installer: it comes and goes in one layer (~35 MB less in the image).
RUN npm install -g --no-audit --no-fund pnpm@9.15.9 \
 && pnpm install --frozen-lockfile --prod --store-dir /tmp/pnpm-store \
 && npm uninstall -g pnpm && npm cache clean --force && rm -rf /tmp/pnpm-store /root/.cache /root/.local
COPY run.mjs ./
# Runtimes run as an ordinary user, each in its own /tmp/dsh/<id> (deleted when the turn ends).
USER node
# PID 1 only waits; exits at once on stop instead of making compose wait ten seconds.
CMD ["node", "-e", "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => process.exit(0)); setInterval(() => {}, 1 << 30)"]
