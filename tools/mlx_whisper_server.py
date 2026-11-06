#!/usr/bin/env python3
"""Tiny localhost bridge between the Sub3 extension and MLX Whisper."""

import json
import os
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import mlx_whisper

HOST = "127.0.0.1"
PORT = int(os.environ.get("SUB3_MLX_PORT", "5051"))
DEFAULT_MODEL = "mlx-community/whisper-small-mlx"
MAX_AUDIO_BYTES = 32 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _headers(self, status=200, content_type="application/json; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _json(self, value, status=200):
        self._headers(status)
        self.wfile.write(json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self._headers(204)

    def do_GET(self):
        if urlparse(self.path).path == "/health":
            self._json({"ok": True, "engine": "mlx-whisper", "model": DEFAULT_MODEL})
        else:
            self._json({"error": "Not found"}, 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/transcribe":
            self._json({"error": "Not found"}, 404)
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_AUDIO_BYTES:
            self._json({"error": "Invalid audio size"}, 413)
            return
        query = parse_qs(parsed.query)
        model = query.get("model", [DEFAULT_MODEL])[0]
        language = query.get("language", [""])[0].strip() or None
        suffix = ".webm" if "webm" in self.headers.get("Content-Type", "") else ".audio"
        path = ""
        try:
            with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as audio:
                path = audio.name
                audio.write(self.rfile.read(length))
            options = {
                "path_or_hf_repo": model,
                "verbose": None,
                "temperature": 0.0,
                "condition_on_previous_text": False,
            }
            if language and language != "auto":
                options["language"] = language
            result = mlx_whisper.transcribe(path, **options)
            self._json({"text": str(result.get("text", "")).strip(), "language": result.get("language")})
        except Exception as error:
            self._json({"error": str(error)}, 500)
        finally:
            if path:
                try:
                    os.unlink(path)
                except OSError:
                    pass

    def log_message(self, message, *args):
        print(f"[Sub3 MLX] {message % args}")


if __name__ == "__main__":
    print(f"Sub3 MLX Whisper: http://{HOST}:{PORT}")
    print(f"Model: {DEFAULT_MODEL} (downloaded automatically on first request)")
    HTTPServer((HOST, PORT), Handler).serve_forever()
