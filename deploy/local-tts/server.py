"""Offline Mandarin TTS; an internal OpenAI-shaped endpoint for the Studio assembler."""
import hmac
import io
import json
import os
from pathlib import Path
import subprocess
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MODEL = "kokoro-local"
VOICES = {"zf_001": 3, "zf_002": 4, "zm_009": 58, "zm_010": 59}
ALIASES = {"alloy": "zf_001", "zh_female": "zf_001", "zh_male": "zm_009"}
TOKEN = os.environ.get("LOCAL_TTS_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("LOCAL_TTS_TOKEN must have at least 32 characters")
root = Path("/models")
onnx = next(root.glob("*.onnx"))
config = sherpa_onnx.OfflineTtsConfig(
    model=sherpa_onnx.OfflineTtsModelConfig(
        kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
            model=str(onnx), voices=str(root / "voices.bin"), tokens=str(root / "tokens.txt"),
            data_dir=str(root / "espeak-ng-data"),
            lexicon=",".join(str(root / p) for p in ["lexicon-us-en.txt", "lexicon-zh.txt"]),
        ), provider="cpu", num_threads=2, debug=False,
    ),
    rule_fsts=",".join(str(root / p) for p in ["date-zh.fst", "number-zh.fst", "phone-zh.fst"]),
    max_num_sentences=1,
)
if not config.validate():
    raise RuntimeError("Invalid local TTS model configuration")
tts = sherpa_onnx.OfflineTts(config)
lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass  # Do not log dialogue, API headers or access tokens.

    def respond(self, status, body, mime="application/json", extra=None):
        data = json.dumps(body, ensure_ascii=False).encode() if mime == "application/json" else body
        try:
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            for key, value in (extra or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
            self.respond(401, {"error": {"message": "Unauthorized"}})
            return False
        return True

    def do_GET(self):
        if self.path == "/healthz":
            return self.respond(200, {"ok": True, "engine": MODEL, "offline": True})
        if not self.authorized():
            return
        if self.path == "/v1/models":
            return self.respond(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "owned_by": "local"}]})
        if self.path == "/v1/audio/voices":
            return self.respond(200, {"voices": list(VOICES), "aliases": ALIASES, "instructions_supported": False})
        self.respond(404, {"error": {"message": "Not found"}})

    def do_POST(self):
        if not self.authorized():
            return
        if self.path != "/v1/audio/speech":
            return self.respond(404, {"error": {"message": "Not found"}})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 32768:
                raise ValueError("Expected a JSON body no larger than 32 KB")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Expected an object")
            text = body.get("input", "")
            if not isinstance(text, str) or not text.strip() or len(text) > 1000:
                raise ValueError("input must contain 1–1000 characters; split longer narration into lines")
            if body.get("model") != MODEL:
                raise ValueError("model must be kokoro-local")
            voice = body.get("voice", "alloy")
            if not isinstance(voice, str):
                raise ValueError("voice must be a string")
            voice = ALIASES.get(voice, voice)
            if voice not in VOICES:
                raise ValueError("voice must be zf_001, zf_002, zm_009 or zm_010")
            fmt = body.get("response_format", "mp3")
            if fmt not in ("mp3", "wav"):
                raise ValueError("response_format must be mp3 or wav")
            speed = float(body.get("speed", 1.0))
            if not 0.75 <= speed <= 1.5:
                raise ValueError("speed must be 0.75–1.5")
        except (ValueError, TypeError, OverflowError):
            return self.respond(400, {"error": {"message": "Invalid speech request: check model, input length, voice, format and speed"}})
        if not lock.acquire(blocking=False):
            return self.respond(429, {"error": {"message": "Local speech synthesis is busy"}})
        try:
            audio = tts.generate(text.strip(), sid=VOICES[voice], speed=speed)
            samples = np.asarray(audio.samples)
            if not samples.size or not np.isfinite(samples).all():
                raise RuntimeError("No valid audio generated")
            stream = io.BytesIO()
            with wave.open(stream, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(audio.sample_rate)
                wav.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
            data = stream.getvalue()
            if fmt == "mp3":
                data = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
                    "-codec:a", "libmp3lame", "-b:a", "128k", "-f", "mp3", "pipe:1"], input=data,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=30).stdout
            self.respond(200, data, "audio/mpeg" if fmt == "mp3" else "audio/wav",
                         {"X-TTS-Engine": MODEL, "X-TTS-Voice": voice, "X-TTS-Instructions": "unsupported"})
        except Exception as exc:
            print("TTS request failed:", type(exc).__name__, flush=True)
            self.respond(500, {"error": {"message": "Local synthesis failed; no cloud fallback was used"}})
        finally:
            lock.release()


print("Offline Kokoro TTS ready (CPU, Chinese voices)", flush=True)
ThreadingHTTPServer(("0.0.0.0", 8093), Handler).serve_forever()
