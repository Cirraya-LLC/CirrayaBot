# Multi-Agent itself.
#
# It must start SIBLING containers (one per Agent), so the image carries a docker client and
# the host's socket is mounted at runtime. Podman users point DOCKER_HOST at podman's socket —
# the same client speaks the same API.
FROM docker:28-cli AS cli

FROM node:24-slim
COPY --from=cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
# This image only runs web/ and needs none of dsh's heavy dependencies (507 packages plus build scripts).
# Keep the version in sync with the root package.json; change one, change the other.
RUN npm install --no-audit --no-fund --omit=dev pg@8.23.0

COPY web ./web
COPY deploy ./deploy
COPY bots ./bots

ENV NODE_ENV=production WEB_PORT=8080 BIND_HOST=0.0.0.0
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "web/server.mjs"]
