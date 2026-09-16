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

ENV LANG=C.UTF-8 TZ=Asia/Shanghai
WORKDIR /work
CMD ["sleep", "infinity"]
