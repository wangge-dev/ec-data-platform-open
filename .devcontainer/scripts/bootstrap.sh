#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

echo "[codespaces] installing workspace dependencies"
pnpm install --frozen-lockfile

echo "[codespaces] dependencies are ready"
