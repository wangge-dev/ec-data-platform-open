#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: bash instance-restore.sh --backup-path DIR --confirm-instance-id ID --acknowledge-data-overwrite [--acknowledge-release-mismatch]" >&2
}

backup_path=""
confirm_instance_id=""
acknowledge_data_overwrite=0
acknowledge_release_mismatch=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --backup-path)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      backup_path="$2"
      shift 2
      ;;
    --confirm-instance-id)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      confirm_instance_id="$2"
      shift 2
      ;;
    --acknowledge-data-overwrite) acknowledge_data_overwrite=1; shift ;;
    --acknowledge-release-mismatch) acknowledge_release_mismatch=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done
[ -n "$backup_path" ] && [ -n "$confirm_instance_id" ] && [ "$acknowledge_data_overwrite" -eq 1 ] || {
  usage
  exit 2
}

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
[ -f "$environment_path" ] || fail "deploy/.env is required before an instance restore can run."

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
  [[ "$instance_id" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]] || fail "INSTANCE_ID must be a unique 3-63 character lowercase identifier."
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
    command -v git >/dev/null 2>&1 || { printf 'unknown\n'; return; }
    worktree_status="$(git -C "$runtime_root" status --porcelain --untracked-files=normal 2>/dev/null)" || {
      printf 'unknown\n'
      return
    }
    [ -z "$worktree_status" ] || {
      printf 'unknown\n'
      return
    }
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

read_manifest() {
  local path="$1" line key value index=0
  local expected=(schemaVersion createdAt sourceInstanceId sourceReleaseRevision database format containsBusinessData containsSecrets environmentIncluded redisIncluded fileName fileBytes fileSha256)
  manifest_schema_version=""
  manifest_created_at=""
  manifest_source_instance_id=""
  manifest_source_release_revision=""
  manifest_database=""
  manifest_format=""
  manifest_contains_business_data=""
  manifest_contains_secrets=""
  manifest_environment_included=""
  manifest_redis_included=""
  manifest_file_name=""
  manifest_file_bytes=""
  manifest_file_sha256=""
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" != *$'\r'* ]] || fail "Backup manifest must use canonical UTF-8/LF text."
    [ "$index" -lt "${#expected[@]}" ] || fail "Backup manifest has unexpected lines."
    [[ "$line" == *=* ]] || fail "Backup manifest syntax is invalid."
    key="${line%%=*}"
    value="${line#*=}"
    [ "$key" = "${expected[$index]}" ] || fail "Backup manifest key order or syntax is invalid at ${expected[$index]}."
    case "$key" in
      schemaVersion) manifest_schema_version="$value" ;;
      createdAt) manifest_created_at="$value" ;;
      sourceInstanceId) manifest_source_instance_id="$value" ;;
      sourceReleaseRevision) manifest_source_release_revision="$value" ;;
      database) manifest_database="$value" ;;
      format) manifest_format="$value" ;;
      containsBusinessData) manifest_contains_business_data="$value" ;;
      containsSecrets) manifest_contains_secrets="$value" ;;
      environmentIncluded) manifest_environment_included="$value" ;;
      redisIncluded) manifest_redis_included="$value" ;;
      fileName) manifest_file_name="$value" ;;
      fileBytes) manifest_file_bytes="$value" ;;
      fileSha256) manifest_file_sha256="$value" ;;
    esac
    index=$((index + 1))
  done < "$path"
  [ "$index" -eq "${#expected[@]}" ] || fail "Backup manifest does not match instance-backup/v1."

  [ "$manifest_schema_version" = "instance-backup/v1" ] &&
  [ "$manifest_database" = "ec_data" ] &&
  [ "$manifest_format" = "postgres-custom" ] &&
  [ "$manifest_contains_business_data" = "true" ] &&
  [ "$manifest_contains_secrets" = "true" ] &&
  [ "$manifest_environment_included" = "false" ] &&
  [ "$manifest_redis_included" = "false" ] &&
  [ "$manifest_file_name" = "ec_data.dump" ] ||
    fail "Backup manifest declares an unsupported or unsafe backup contract."
  [[ "$manifest_created_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$ ]] || fail "Backup manifest createdAt is invalid."
  [[ "$manifest_source_instance_id" =~ ^[a-z0-9][a-z0-9_-]{2,62}$ ]] || fail "Backup manifest sourceInstanceId is invalid."
  [[ "$manifest_source_release_revision" =~ ^(unknown|[0-9a-f]{40})$ ]] || fail "Backup manifest sourceReleaseRevision is invalid."
  [[ "$manifest_file_bytes" =~ ^[1-9][0-9]*$ ]] || fail "Backup manifest fileBytes is invalid."
  [[ "$manifest_file_sha256" =~ ^[0-9a-f]{64}$ ]] || fail "Backup manifest fileSha256 is invalid."
}

[ -d "$backup_path" ] || fail "Backup path must be an existing instance backup directory."
[ ! -L "$backup_path" ] || fail "Backup path must not be a symbolic link."
safe_backup_path="$(cd "$backup_path" && pwd -P)"
shopt -s nullglob dotglob
entries=("$safe_backup_path"/*)
shopt -u nullglob dotglob
[ "${#entries[@]}" -eq 2 ] || fail "Backup path must contain exactly backup-manifest.txt and ec_data.dump."
seen_dump=0
seen_manifest=0
for entry in "${entries[@]}"; do
  [ -f "$entry" ] && [ ! -L "$entry" ] || fail "Backup entries must be regular files."
  case "$(basename "$entry")" in
    ec_data.dump) seen_dump=1 ;;
    backup-manifest.txt) seen_manifest=1 ;;
    *) fail "Backup path contains an unexpected file: $(basename "$entry")" ;;
  esac
done
[ "$seen_dump" -eq 1 ] && [ "$seen_manifest" -eq 1 ] || fail "Backup path is incomplete."

target_instance_id="$(read_instance_id "$environment_path")"
[ "$confirm_instance_id" = "$target_instance_id" ] || fail "Confirmed instance ID does not match target INSTANCE_ID '$target_instance_id'."
read_manifest "$safe_backup_path/backup-manifest.txt"
dump_path="$safe_backup_path/ec_data.dump"
actual_bytes="$(wc -c < "$dump_path" | tr -d '[:space:]')"
[ "$actual_bytes" = "$manifest_file_bytes" ] || fail "Backup dump byte count does not match its manifest."
actual_hash="$(sha256_file "$dump_path")"
[ "$actual_hash" = "$manifest_file_sha256" ] || fail "Backup dump SHA-256 does not match its manifest."
target_revision="$(release_revision)"
if [ "$manifest_source_release_revision" = "unknown" ] || [ "$target_revision" = "unknown" ] ||
   [ "$manifest_source_release_revision" != "$target_revision" ]; then
  [ "$acknowledge_release_mismatch" -eq 1 ] ||
    fail "Backup and target revisions are not proven identical. Review compatibility and pass --acknowledge-release-mismatch."
fi

command -v docker >/dev/null 2>&1 || fail "docker is required."
container_dump_path="/tmp/ec-data-instance-restore-$$-$RANDOM.dump"
mutation_started=0
restore_healthy=0

compose_cmd() { (cd "$deploy_root" && docker compose --env-file .env -f docker-compose.yml "$@"); }

cleanup() {
  local status=$?
  trap - EXIT
  compose_cmd exec -T postgres rm -f -- "$container_dump_path" >/dev/null 2>&1 || true
  if [ "$mutation_started" -eq 1 ] && [ "$restore_healthy" -eq 0 ]; then
    compose_cmd stop api migrate >/dev/null 2>&1 || true
    echo "WARNING: Restore did not complete; API and migrate were stopped to fail closed. Inspect PostgreSQL and restore a verified backup before restarting." >&2
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

service_state() {
  local service="$1" container_id state
  container_id="$(compose_cmd ps --all -q "$service")"
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || fail "Compose service $service did not return one canonical container ID."
  state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}' "$container_id")"
  [[ "$state" =~ ^[^\|]+\|[^\|]*\|[0-9]+$ ]] || fail "Compose service $service returned an invalid state."
  printf '%s\n' "$state"
}

wait_restored_instance() {
  local deadline=$((SECONDS + 180)) ready state migrate_state
  while [ "$SECONDS" -lt "$deadline" ]; do
    ready=1
    for service in postgres redis api web; do
      state="$(service_state "$service")"
      case "$state" in
        exited*|dead*|*'|unhealthy|'*) fail "Restored service $service failed: $state" ;;
      esac
      case "$state" in running'|healthy|0') ;; *) ready=0 ;; esac
    done
    migrate_state="$(service_state migrate)"
    case "$migrate_state" in
      exited'|'*'|0') ;;
      exited'|'*) fail "Post-restore migration failed: $migrate_state" ;;
      *) ready=0 ;;
    esac
    [ "$ready" -eq 0 ] || return 0
    sleep 2
  done
  fail "Timed out waiting for post-restore migration and service health."
}

compose_cmd config --quiet
postgres_id="$(compose_cmd ps --all -q postgres)"
[[ "$postgres_id" =~ ^[0-9a-f]{12,64}$ ]] || fail "PostgreSQL container ID did not return one canonical value."
running="$(docker inspect --format '{{.State.Running}}' "$postgres_id")"
[ "$running" = "true" ] || fail "PostgreSQL must be running before restore."
docker cp "$dump_path" "$postgres_id:$container_dump_path"
compose_cmd exec -T postgres pg_restore --list "$container_dump_path" >/dev/null

compose_cmd stop api migrate
mutation_started=1
compose_cmd exec -T postgres dropdb -U ec --if-exists --force ec_data
compose_cmd exec -T postgres createdb -U ec -O ec ec_data
compose_cmd exec -T postgres pg_restore -U ec -d ec_data --no-owner --no-acl --exit-on-error "$container_dump_path"
compose_cmd exec -T redis redis-cli FLUSHDB >/dev/null
compose_cmd up -d --no-build --force-recreate migrate api web
wait_restored_instance
restore_healthy=1

echo "Restored source instance '$manifest_source_instance_id' into target '$target_instance_id'."
echo "Verified SHA-256: $actual_hash"
echo "WARNING: deploy/.env was not restored. Keep target secrets, and retain the original ENCRYPTION_KEY if restored connector credentials must remain decryptable." >&2
