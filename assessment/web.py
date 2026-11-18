"""Loopback-only dashboard and same-origin local JSON API."""

import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from .engine import CRITERIA, evaluate, validate_attestation
from .storage import load_attestations, load_snapshot, save_attestation

STATIC = Path(__file__).parent / "static"
PRIMER = Path(__file__).parent.parent / "node_modules" / "@primer" / "css" / "dist" / "primer.css"
MAX_BODY = 8192


class AssessmentServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def _report(data_dir):
    return evaluate(load_snapshot(data_dir), load_attestations(data_dir))


def handler_for(data_dir):
    class Handler(BaseHTTPRequestHandler):
        server_version = "AssessmentDashboard"

        def _send(self, status, content_type, payload):
            body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; "
                "connect-src 'self'; img-src 'self' data:; object-src 'none'; "
                "base-uri 'none'; frame-ancestors 'none'",
            )
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status, data):
            self._send(status, "application/json; charset=utf-8",
                       json.dumps(data, ensure_ascii=False))

        def do_GET(self):
            route = self.path.split("?", 1)[0]
            if route == "/":
                return self._file(STATIC / "index.html", "text/html; charset=utf-8")
            if route == "/static/app.js":
                return self._file(STATIC / "app.js", "text/javascript; charset=utf-8")
            if route == "/static/app.css":
                return self._file(STATIC / "app.css", "text/css; charset=utf-8")
            if route == "/static/primer.css":
                if not PRIMER.is_file():
                    return self._send(503, "text/plain; charset=utf-8",
                                      "Primer CSS is not installed. Run npm install in the project directory.")
                return self._file(PRIMER, "text/css; charset=utf-8")
            if route == "/api/report":
                try:
                    return self._json(200, _report(data_dir))
                except FileNotFoundError as error:
                    return self._json(404, {"error": str(error)})
                except (ValueError, json.JSONDecodeError):
                    return self._json(422, {"error": "Assessment snapshot is invalid or unsupported."})
            return self._json(404, {"error": "Not found."})

        def do_POST(self):
            if self.path != "/api/attestations":
                return self._json(404, {"error": "Not found."})
            try:
                host_header = self.headers.get("Host", "")
                host = urlparse("http://" + host_header)
                expected_host = host.hostname in ("127.0.0.1", "localhost", "::1")
                expected_port = host.port == self.server.server_port
                origin = self.headers.get("Origin")
                if not expected_host or not expected_port or (origin and origin != "http://" + host_header):
                    return self._json(403, {"error": "Requests must originate from this local dashboard."})
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > MAX_BODY:
                    return self._json(413, {"error": "Request must be between 1 and 8192 bytes."})
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
                if not isinstance(payload, dict) or set(payload) != {
                        "criterion_id", "decision", "note"}:
                    return self._json(400, {"error": "Expected criterion_id, decision, and note."})
                record = validate_attestation(
                    payload["criterion_id"], payload["decision"], payload["note"]
                )
                if CRITERIA[payload["criterion_id"]]["field"] is not None:
                    return self._json(400, {"error": "This criterion uses collected API evidence."})
                save_attestation(data_dir, payload["criterion_id"], record)
                return self._json(200, _report(data_dir))
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
                return self._json(400, {"error": str(error)})
            except FileNotFoundError as error:
                return self._json(404, {"error": str(error)})

        def _file(self, path, content_type):
            try:
                return self._send(200, content_type, path.read_bytes())
            except OSError:
                return self._json(404, {"error": "Static resource not found."})

        def log_message(self, fmt, *args):
            print("assessment dashboard: " + (fmt % args))

    return Handler


def serve(host, port, data_dir):
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("The dashboard can only bind to localhost for local-first privacy.")
    if not 1 <= port <= 65535:
        raise ValueError("Port must be between 1 and 65535.")
    server = AssessmentServer((host, port), handler_for(data_dir))
    print("Dashboard listening at http://" + host + ":" + str(port) + " (local only; Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping dashboard.")
    finally:
        server.server_close()
