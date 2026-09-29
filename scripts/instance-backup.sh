#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: bash instance-backup.sh --output-root /secure/existing/directory" >&2
}

output_root=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output-root)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      output_root="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[ -n "$output_root" ] || { usage; exit 2; }

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [ -f "$script_dir/deploy/docker-compose.yml" ]; then
  runtime_root="$script_dir"
else
  runtime_root="$(cd "$script_dir/.." && pwd -P)"
fi
deploy_root="$runtime_root/deploy"
environment_path="$deploy_root/.env"
compose_path="$deploy_root/docker-compose.yml"

fail() { echo "$*" >&2; exit 1; }

while IFS= read -r variable_name; do
  case "$variable_name" in
    COMPOSE_*|DOCKER_*) fail "Refusing process-level Docker/Compose target override: $variable_name" ;;
  esac
done < <(compgen -e)

[ -f "$compose_path" ] || fail "Compose file is missing: $compose_path"
[ -f "$environment_path" ] || fail "deploy/.env is required before an instance backup can run."

read_instance_id() {
  local path="$1" line raw_name name value instance_id="" count=0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    [ -n "${line//[[:space:]]/}" ] || continue
    case "${line#"${line%%[![:space:]]*}"}" in \#*) continue ;; esac
    [[ "$line" == *=* ]] || continue
    raw_name="${line%%=*}"
    name="${raw_name#"${raw_name%%[![:space:]]*}"}"
    name="${name%"${name##*[![:space:]]}"}"
    case "$name" in
      DOCKER_*|COMPOSE_*)
        if [ "$name" != "COMPOSE_PROJECT_NAME" ]; then
          fail "deploy/.env contains a forbidden Docker Compose control variable: $name"
        fi
        value="${line#*=}"
        [ "$raw_name" = "$name" ] && [[ "$value" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
          fail "COMPOSE_PROJECT_NAME must use the exact unquoted NAME=VALUE form and a safe lowercase value."
        ;;
    esac
    [ "$name" = "INSTANCE_ID" ] || continue
    [ "$raw_name" = "INSTANCE_ID" ] || fail "INSTANCE_ID must use the exact unquoted INSTANCE_ID=value form in deploy/.env."
    instance_id="${line#*=}"
    count=$((count + 1))
  done < "$path"
  [ "$count" -eq 1 ] || fail "INSTANCE_ID must appear exactly once in deploy/.env."
  [[ "$instance_id" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]] ||
    fail "INSTANCE_ID must be a unique 3-63 character lowercase identifier."
  [[ "$instance_id" != change_me* ]] || fail "INSTANCE_ID must not be a change_me placeholder."
  printf '%s\n' "$instance_id"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required."
  fi
}

release_revision() {
  local revision="" worktree_status=""
  if [ -e "$runtime_root/.git" ]; then
    command -v git >/dev/null 2>&1 || fail "Cannot verify source revision because git is unavailable."
    worktree_status="$(git -C "$runtime_root" status --porcelain --untracked-files=normal 2>/dev/null)" ||
      fail "Cannot verify whether the source worktree is clean."
    [ -z "$worktree_status" ] ||
      fail "Refusing to create a revision-labelled backup from a dirty source worktree."
  fi
  if [ -f "$runtime_root/release-manifest.json" ]; then
    revision="$(sed -n 's/^[[:space:]]*"sourceRevision"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{40\}\)"[[:space:]]*,[[:space:]]*$/\1/p' "$runtime_root/release-manifest.json")"
    if [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then printf '%s\n' "$revision"; return; fi
  fi
  if [ -e "$runtime_root/.git" ] && command -v git >/dev/null 2>&1; then
    revision="$(git -C "$runtime_root" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$revision" =~ ^[0-9a-f]{40}$ ]]; then printf '%s\n' "$revision"; return; fi
  fi
  printf 'unknown\n'
}

[ -d "$output_root" ] || fail "Output root must be an existing backup directory outside this runtime package."
[ ! -L "$output_root" ] || fail "Output root must not be a symbolic link."
safe_output_root="$(cd "$output_root" && pwd -P)"
[ "$safe_output_root" != "/" ] || fail "Output root cannot be a filesystem root."
case "$safe_output_root/" in
  "$runtime_root/"*) fail "Output root must be outside the source tree or extracted offline runtime." ;;
esac

instance_id="$(read_instance_id "$environment_path")"
revision="$(release_revision)"
created_at="$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
name_timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
backup_name="ec-data-instance-backup-$instance_id-$name_timestamp"
final_path="$safe_output_root/$backup_name"
staging_path="$safe_output_root/.$backup_name-$(printf '%06x%06x' "$RANDOM" "$RANDOM").staging"
[ ! -e "$final_path" ] || fail "Backup already exists: $final_path"
[ ! -e "$staging_path" ] || fail "Backup staging path already exists: $staging_path"

command -v docker >/dev/null 2>&1 || fail "docker is required."
mkdir "$staging_path"
dump_path="$staging_path/ec_data.dump"
manifest_path="$staging_path/backup-manifest.txt"
container_dump_path="/tmp/ec-data-instance-backup-$$-$RANDOM.dump"
backup_complete=0

compose_cmd() { (cd "$deploy_root" && docker compose --env-file .env -f docker-compose.yml "$@"); }

cleanup() {
  local status=$?
  trap - EXIT
  compose_cmd exec -T postgres rm -f -- "$container_dump_path" >/dev/null 2>&1 || true
  if [ "$backup_complete" -eq 0 ] && [ -d "$staging_path" ]; then
    case "$staging_path" in
      "$safe_output_root"/.ec-data-instance-backup-*.staging) rm -rf -- "$staging_path" ;;
      *) echo "Refusing unsafe staging cleanup: $staging_path" >&2 ;;
    esac
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

compose_cmd config --quiet
postgres_id="$(compose_cmd ps --all -q postgres)"
[[ "$postgres_id" =~ ^[0-9a-f]{12,64}$ ]] || fail "PostgreSQL container ID did not return one canonical value."
running="$(docker inspect --format '{{.State.Running}}' "$postgres_id")"
[ "$running" = "true" ] || fail "PostgreSQL must be running before backup."

compose_cmd exec -T postgres pg_dump -U ec -d ec_data --format=custom --compress=6 \
  --no-owner --no-acl --file "$container_dump_path"
compose_cmd exec -T postgres pg_restore --list "$container_dump_path" >/dev/null
docker cp "$postgres_id:$container_dump_path" "$dump_path"
[ -f "$dump_path" ] && [ -s "$dump_path" ] || fail "PostgreSQL produced an empty or invalid dump."

dump_bytes="$(wc -c < "$dump_path" | tr -d '[:space:]')"
[[ "$dump_bytes" =~ ^[1-9][0-9]*$ ]] || fail "Could not determine backup byte count."
dump_hash="$(sha256_file "$dump_path")"
[[ "$dump_hash" =~ ^[0-9a-f]{64}$ ]] || fail "Could not determine backup SHA-256."
printf '%s\n' \
  'schemaVersion=instance-backup/v1' \
  "createdAt=$created_at" \
  "sourceInstanceId=$instance_id" \
  "sourceReleaseRevision=$revision" \
  'database=ec_data' \
  'format=postgres-custom' \
  'containsBusinessData=true' \
  'containsSecrets=true' \
  'environmentIncluded=false' \
  'redisIncluded=false' \
  'fileName=ec_data.dump' \
  "fileBytes=$dump_bytes" \
  "fileSha256=$dump_hash" > "$manifest_path"

compose_cmd exec -T postgres rm -f -- "$container_dump_path"
mv "$staging_path" "$final_path"
backup_complete=1
echo "Backup directory: $final_path"
echo "Bytes: $dump_bytes"
echo "SHA-256: $dump_hash"
echo "WARNING: This backup contains business data and sensitive database material. Store it encrypted and separately from the runtime package." >&2
