#!/usr/bin/env bash
set -euo pipefail

api_url="${API_URL:-http://127.0.0.1:4000}"
web_url="${WEB_URL:-http://127.0.0.1:5173}"

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "[codespaces-smoke] ADMIN_PASSWORD is required" >&2
  exit 1
fi

echo "[codespaces-smoke] waiting for API and PostgreSQL"
api_ready=0
for _ in {1..60}; do
  if API_URL="$api_url" node --input-type=module <<'NODE' >/dev/null 2>&1
const response = await fetch(`${process.env.API_URL}/api/health`);
const body = await response.json();
if (!response.ok || body?.ok !== true || body?.db !== "connected") process.exit(1);
NODE
  then
    api_ready=1
    break
  fi
  sleep 2
done
if [[ "$api_ready" -ne 1 ]]; then
  echo "[codespaces-smoke] API health timed out" >&2
  exit 1
fi

echo "[codespaces-smoke] waiting for Web"
web_ready=0
for _ in {1..60}; do
  if WEB_URL="$web_url" node --input-type=module <<'NODE' >/dev/null 2>&1
const response = await fetch(process.env.WEB_URL);
if (!response.ok) process.exit(1);
NODE
  then
    web_ready=1
    break
  fi
  sleep 2
done
if [[ "$web_ready" -ne 1 ]]; then
  echo "[codespaces-smoke] Web health timed out" >&2
  exit 1
fi

echo "[codespaces-smoke] verifying admin login"
API_URL="$api_url" node --input-type=module <<'NODE'
const response = await fetch(`${process.env.API_URL}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: process.env.ADMIN_PASSWORD }),
});
const body = await response.json();
if (!response.ok || body?.ok !== true || !body?.data?.token || body?.data?.user?.username !== "admin") {
  throw new Error(`admin login failed with HTTP ${response.status}`);
}
NODE

echo "[codespaces-smoke] API/PostgreSQL, Web, and admin login passed"
