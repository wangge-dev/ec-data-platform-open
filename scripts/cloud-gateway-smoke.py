"""Real Nginx HTTP exercise against disposable synthetic backends, loopback ports only."""
import http.client
import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent


def docker(*args):
    result = subprocess.run(["docker", *args], check=True, capture_output=True, text=True)
    return result.stdout.strip()


def main():
    name = "ec-cloud-smoke-" + uuid.uuid4().hex[:10]
    owned = []
    with tempfile.TemporaryDirectory(prefix="ec-cloud-gateway-") as folder:
        config = Path(folder) / "nginx.conf"
        # Production is loopback on a Linux host; publish test-only listener within isolated namespace.
        text = (ROOT / "cloud-kit/nginx.conf.template").read_text(encoding="utf-8")
        config.write_text(text.replace("@@DOMAIN@@", "data.example.com").replace(
            "listen 127.0.0.1:4080;", "listen 0.0.0.0:4080;"), encoding="utf-8")
        try:
            docker("run", "-d", "--rm", "--name", name, "-p", "127.0.0.1::4080",
                   "-v", f"{ROOT / 'scripts/cloud-http-fixture.py'}:/fixture.py:ro",
                   "python:3.12-alpine", "python", "/fixture.py")
            owned.append(name)
            docker("run", "-d", "--rm", "--name", name + "-gateway", "--network", "container:" + name,
                   "-v", f"{config}:/etc/nginx/nginx.conf:ro", "nginx:1.30.4-alpine")
            owned.append(name + "-gateway")
            port = int(docker("port", name, "4080/tcp").rsplit(":", 1)[1])

            def request(method, path, body=None):
                conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
                try:
                    conn.request(method, path, body=body)
                    response = conn.getresponse()
                    return response.status, response.read()
                finally:
                    conn.close()

            for attempt in range(30):
                try:
                    status, body = request("GET", "/api/health")
                    if status == 200:
                        break
                except OSError:
                    pass
                time.sleep(.3)
            else:
                raise RuntimeError("Synthetic gateway did not become ready")
            assert json.loads(body)["proto"] == "https"
            status, body = request("GET", "/api/health?sample=synthetic")
            assert status == 200 and json.loads(body)["path"].endswith("?sample=synthetic")
            statuses = [request("POST", "/api/auth/login", "{}")[0] for _ in range(9)]
            assert 401 in statuses and 429 in statuses, statuses
            length = 101 * 1024 * 1024
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=60)
            try:
                conn.putrequest("POST", "/api/files/synthetic-raw")
                conn.putheader("Content-Length", str(length))
                conn.putheader("Content-Type", "text/csv")
                conn.endheaders()
                chunk = b"x" * 65536
                for _ in range(length // len(chunk)):
                    conn.send(chunk)
                response = conn.getresponse()
                body = response.read()
                assert response.status == 200, response.status
                assert json.loads(body)["bytes"] == length
            finally:
                conn.close()
            # Oversized requests must fail at the gateway before allocating an upload body.
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
            try:
                conn.putrequest("POST", "/api/files/synthetic-oversized")
                conn.putheader("Content-Length", str(514 * 1024 * 1024))
                conn.endheaders()
                response = conn.getresponse()
                assert response.status == 413, response.status
                response.read()
            finally:
                conn.close()
            print(json.dumps({"health": "passed", "queryAndHttpsHeader": "passed", "loginStatuses": statuses,
                              "streamedBytes": length, "overLimit": 413, "realBusinessData": False}))
        finally:
            for container in reversed(owned):
                docker("rm", "-f", container)
            if docker("ps", "-aq", "--filter", "name=" + name):
                raise RuntimeError("Smoke containers remain; inspect the exact test names")
            print("Owned synthetic test containers removed; existing instances untouched.")


if __name__ == "__main__":
    main()
