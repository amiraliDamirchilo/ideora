"""
Ideora server (Python standard library only, no pip install needed).

- Serves the static site (index.html, app.js, styles.css, prompt.js).
- Proxies POST /api/chat -> Google Gemini API (OpenAI-compatible endpoint), streaming SSE through,
  so the Gemini API key stays on the server and never reaches the browser.
- Per-IP hourly rate limit and a model whitelist, so a public deployment can't drain your quota.

Settings come from ideora.env (next to this file) or environment variables:
  GEMINI_API_KEY      your key from https://aistudio.google.com/api-keys   (required)
  IDEORA_HOST         127.0.0.1 locally, 0.0.0.0 on a server
  IDEORA_PORT         default 3000
  IDEORA_RATE_LIMIT   chat requests per IP per hour (0 = unlimited)
  IDEORA_TRUST_PROXY  1 when running behind nginx / Cloudflare (reads the real client IP)

Run:  python server.py
"""
from __future__ import annotations

import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATIC_FILES = {"index.html", "styles.css", "app.js", "prompt.js"}
UPSTREAM = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
ALLOWED_MODELS = {
    "gemini-3.6-flash",
    "gemini-3-flash-preview",
    "gemini-4-hydrogen",
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
}


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


load_env(ROOT / "ideora.env")
API_KEY = os.environ.get("GEMINI_API_KEY", "")
HOST = os.environ.get("IDEORA_HOST", "127.0.0.1")
PORT = int(os.environ.get("IDEORA_PORT", "3000"))
RATE_LIMIT = int(os.environ.get("IDEORA_RATE_LIMIT", "20"))
TRUST_PROXY = os.environ.get("IDEORA_TRUST_PROXY", "0") == "1"

_hits: dict[str, list[float]] = {}
_hits_lock = threading.Lock()


def rate_limited(ip: str) -> int:
    """Returns 0 if allowed, otherwise seconds until the next request is allowed."""
    if RATE_LIMIT <= 0:
        return 0
    now = time.time()
    with _hits_lock:
        recent = [t for t in _hits.get(ip, []) if now - t < 3600]
        if len(recent) >= RATE_LIMIT:
            _hits[ip] = recent
            return int(3600 - (now - recent[0])) + 1
        recent.append(now)
        _hits[ip] = recent
        if len(_hits) > 10000:  # keep memory bounded
            for k in [k for k, v in _hits.items() if not v or now - v[-1] > 3600]:
                _hits.pop(k, None)
        return 0


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[ideora] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # ---- static: only whitelisted site files (never expose ideora.env or server.py)
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/health":
            return self._json(200, {"ok": True, "key_configured": bool(API_KEY)})
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        if name not in STATIC_FILES:
            return self._json(404, {"error": {"message": "not found"}})
        self.path = "/" + name
        return super().do_GET()

    def do_HEAD(self):
        self.send_response(405)
        self.end_headers()

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/api/chat":
            return self._json(404, {"error": {"message": "not found"}})
        if not API_KEY:
            return self._json(500, {"error": {"message": "GEMINI_API_KEY is not set in ideora.env", "type": "ideora_config"}})

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > 2_000_000:
            return self._json(413, {"error": {"message": "Request too large. Start a new chat.", "type": "ideora_limit"}})
        try:
            req = json.loads(self.rfile.read(length))
            model = req.get("model")
            messages = req.get("messages")
            assert isinstance(messages, list) and messages
        except Exception:
            return self._json(400, {"error": {"message": "Bad request"}})
        if model not in ALLOWED_MODELS:
            return self._json(400, {"error": {"message": "Model not allowed: %s" % model}})

        ip = self.client_address[0]
        if TRUST_PROXY:
            ip = (self.headers.get("CF-Connecting-IP")
                  or (self.headers.get("X-Forwarded-For") or "").split(",")[0].strip() or ip)
        wait = rate_limited(ip)
        if wait:
            mins = max(1, wait // 60)
            return self._json(429, {"error": {
                "message": "Hourly limit reached (%d requests per hour). Try again in about %d minute%s."
                           % (RATE_LIMIT, mins, "" if mins == 1 else "s"),
                "type": "ideora_limit"}})

        body = json.dumps({"model": model, "messages": messages, "stream": True}).encode()
        self._proxy(body)

    # ---- helpers
    def _json(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy(self, body):
        upstream = urllib.request.Request(
            UPSTREAM, data=body, method="POST",
            headers={"Authorization": "Bearer " + API_KEY, "Content-Type": "application/json"},
        )
        try:
            resp = urllib.request.urlopen(upstream, timeout=180)
        except urllib.error.HTTPError as e:
            raw = e.read() or b"{}"
            try:  # Google returns [{"error": {...}}] on this endpoint; normalise it
                j = json.loads(raw)
                j = j[0] if isinstance(j, list) and j else j
                msg = j.get("error", {}).get("message", "") or raw.decode()[:300]
            except Exception:
                msg = raw.decode(errors="replace")[:300]
            return self._json(e.code, {"error": {"message": "Gemini API %d: %s" % (e.code, msg)}})
        except (urllib.error.URLError, OSError) as e:
            return self._json(502, {"error": {"message": "Cannot reach the Gemini API (%s)." % e}})

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        try:
            while True:
                chunk = resp.read1(8192)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # browser pressed Stop
        except OSError as e:
            try:
                self.wfile.write(("data: " + json.dumps({"error": {"message": "Stream interrupted: %s" % e}}) + "\n\n").encode())
            except OSError:
                pass
        finally:
            resp.close()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    print("Ideora running at http://%s:%d  (Gemini key %s, limit %s/h per IP)"
          % ("localhost" if HOST == "127.0.0.1" else HOST, PORT,
             "set" if API_KEY else "MISSING", RATE_LIMIT or "off"))
    Server((HOST, PORT), Handler).serve_forever()
