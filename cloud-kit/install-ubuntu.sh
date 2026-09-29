#!/usr/bin/env bash
# Run only on the recipient's fresh Ubuntu server, never on the development host.
set -euo pipefail
if [ "${1:-}" = "--help" ]; then
  echo 'Usage: sudo bash install-ubuntu.sh (Ubuntu 24.04 x86_64, installs Docker/Compose, Python, restic)'
  exit 0
fi
[ "$#" -eq 0 ] || { echo 'Unknown option' >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo on the target server.' >&2; exit 1; }
# /etc/os-release is guaranteed by the supported Ubuntu target.
# shellcheck disable=SC1091
. /etc/os-release
[ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ] && [ "$(uname -m)" = x86_64 ] || {
  echo 'This installer supports Ubuntu 24.04 LTS x86_64 only.' >&2; exit 1;
}
if command -v docker >/dev/null 2>&1; then
  docker version >/dev/null
  docker compose version >/dev/null
  echo 'Existing working Docker/Compose retained.'
else
  for package in docker.io docker-compose docker-compose-v2 podman-docker containerd runc; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      echo "Existing $package conflicts with Docker CE. See the official migration instructions; no package was removed." >&2
      exit 1
    fi
  done
  [ ! -e /etc/apt/sources.list.d/docker.sources ] && [ ! -e /etc/apt/sources.list.d/docker.list ] || {
    echo 'Existing Docker apt source needs review; not overwriting it.' >&2; exit 1;
  }
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  printf '%s\n' 'Types: deb' 'URIs: https://download.docker.com/linux/ubuntu' \
    'Suites: noble' 'Components: stable' 'Architectures: amd64' \
    'Signed-By: /etc/apt/keyrings/docker.asc' | tee /etc/apt/sources.list.d/docker.sources >/dev/null
  # Set bounded container logs before the first engine startup; preserve existing daemon config.
  if [ ! -e /etc/docker/daemon.json ]; then
    install -m 0755 -d /etc/docker
    printf '%s\n' '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' \
      | tee /etc/docker/daemon.json >/dev/null
  fi
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
apt-get update
apt-get install -y python3 restic unzip
docker version >/dev/null
docker compose version
echo 'Host dependencies ready. No application, DNS, firewall or public endpoint was configured.'
