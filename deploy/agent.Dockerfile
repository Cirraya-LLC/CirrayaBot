# One container per Agent.
#
# Only what's needed out of the box: network, read/write, lookup. Compilers and language
# runtimes the Agent apt-installs itself — it is root, and what it installs stays in its own
# container, like handing a new hire a clean machine to set up.
FROM debian:trixie-slim

RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources || true
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less file procps python3 \
 && rm -rf /var/lib/apt/lists/*

# Browser: the distro's chromium, with Playwright's Python package as the driver.
# Not the one `playwright install` fetches: that downloads from Playwright's CDN, while the
# distro package comes through the apt mirror above. Without CJK fonts, Chinese text in
# screenshots renders as boxes.
# The browserd.py daemon is not in the image — the server pushes it in the first time the
# browser is used, so changing it needs no image rebuild (see ensureBrowser in server.mjs).
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium fonts-noto-cjk python3-pip \
 && pip3 install --no-cache-dir --break-system-packages playwright==1.55.0 \
 && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM=/usr/bin/chromium

ENV LANG=C.UTF-8 TZ=Asia/Shanghai
WORKDIR /work
CMD ["sleep", "infinity"]
