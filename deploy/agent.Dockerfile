# One container per Agent.
#
# Only what's needed out of the box: network, read/write, lookup. The Agent works as an ordinary
# user (`agent`, uid 1000, no capabilities); system packages it needs are installed for it by the
# platform (the install_packages tool runs apt as root), and pip / npm install into its home, /work.
# What it installs stays in its own container, like handing a new hire a clean machine to set up.
# iptables is here for the platform, not the Agent: the image also runs, briefly and on the host's
# network, the rules that keep agents off the host and the LAN (sandbox.mjs EGRESS_SCRIPT).
FROM debian:trixie-slim

# Where apt downloads from: Debian's own CDN, unless AGENT_APT_MIRROR names a mirror (the server
# passes it as this build argument).
ARG APT_MIRROR=deb.debian.org
RUN if [ "$APT_MIRROR" != deb.debian.org ]; then sed -i "s|deb.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources; fi
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq less file procps python3 iptables \
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

# A desktop of its own: a screen for GUI programs and a terminal, which the person can watch and use
# (desktopd.py, pushed in and started on demand like browserd.py — nothing runs until it is opened).
RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb openbox xterm x11-xserver-utils fonts-dejavu-core python3-xlib python3-pil \
 && rm -rf /var/lib/apt/lists/*

# The Agent's account. Its home is its desk, so what it installs for itself (pip --user, npm -g)
# lands in /work and survives the container being recreated.
RUN useradd --uid 1000 --home-dir /work --no-create-home --shell /bin/bash agent \
 && install -d -o agent -g agent /work
# Commands run in a login shell (bash -lc), and Debian's /etc/profile resets PATH there — this puts
# what the agent installs for itself back on it.
RUN printf 'export PATH=/work/.local/bin:/work/.npm-global/bin:$PATH\n' > /etc/profile.d/agent-path.sh
ENV LANG=C.UTF-8 TZ=Asia/Shanghai HOME=/work \
    PATH=/work/.local/bin:/work/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_PREFIX=/work/.npm-global PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /work
USER agent
CMD ["sleep", "infinity"]
