FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir sherpa-onnx==1.13.8 numpy==2.2.6
# Download at build time. The running service has only an internal, non-internet Docker network.
RUN curl -fL --retry 3 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2 -o /tmp/model.tar.bz2 \
    && echo 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6  /tmp/model.tar.bz2' | sha256sum -c - \
    && mkdir /models && tar -xjf /tmp/model.tar.bz2 -C /models --strip-components=1 \
    && rm /tmp/model.tar.bz2
WORKDIR /app
COPY server.py ./server.py
USER 1000:1000
ENV PYTHONUNBUFFERED=1 OMP_NUM_THREADS=2
EXPOSE 8093
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8093/healthz', timeout=3)"
CMD ["python", "server.py"]
