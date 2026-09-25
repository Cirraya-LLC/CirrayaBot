# The studio service. Built from ./studio only — it shares no code with the app.
#
# ffmpeg is for contact sheets and frame extraction. Debian's build decodes 10-bit HEVC,
# which is what Seedance 2.5 1080p and 2.0 4k return.
FROM node:24-slim

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources || true
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /studio
# Same pg version as the app's image (Dockerfile at the repo root); change one, change both.
RUN npm install --no-audit --no-fund --omit=dev pg@8.23.0
COPY *.mjs ./

ENV NODE_ENV=production STUDIO_PORT=8090 STUDIO_DATA=/data
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STUDIO_PORT||8090)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
