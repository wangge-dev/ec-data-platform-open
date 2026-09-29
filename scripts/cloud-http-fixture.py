"""Synthetic backend used only by cloud-gateway-smoke.py, never shipped."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.respond(0)

    def do_POST(self):
        remaining = int(self.headers.get("Content-Length", "0"))
        length = remaining
        while remaining:
            data = self.rfile.read(min(65536, remaining))
            if not data:
                return
            remaining -= len(data)
        self.respond(length)

    def respond(self, length):
        payload = json.dumps({"ok": True, "db": "connected", "bytes": length,
                              "path": self.path, "proto": self.headers.get("X-Forwarded-Proto")}).encode()
        self.send_response(401 if self.path == "/api/auth/login" else 200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


for port in (3997, 4000):
    threading.Thread(target=ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever, daemon=True).start()
threading.Event().wait()
