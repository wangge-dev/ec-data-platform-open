#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bash .devcontainer/scripts/prepare-db.sh

api_pid=""
web_pid=""

cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
  fi
  if [[ -n "$web_pid" ]]; then
    kill "$web_pid" 2>/dev/null || true
  fi
  wait "$api_pid" "$web_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

echo "[codespaces] starting API on port 4000"
pnpm --dir apps/api dev &
api_pid=$!

echo "[codespaces] starting Web on port 5173"
pnpm --dir apps/web exec vite --host 0.0.0.0 &
web_pid=$!

echo "[codespaces] use the forwarded port 5173; press Ctrl+C to stop"
wait -n "$api_pid" "$web_pid"
