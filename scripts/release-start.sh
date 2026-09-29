#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SCRIPT_DIR/release-manifest.json" ] && [ -d "$SCRIPT_DIR/deploy" ]; then
  RELEASE_ROOT="$SCRIPT_DIR"
elif [ -f "$SCRIPT_DIR/../release-manifest.json" ] && [ -d "$SCRIPT_DIR/../deploy" ]; then
  RELEASE_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  echo "Could not locate the extracted release root." >&2
  exit 1
fi
cd "$RELEASE_ROOT"

required_images=("postgres:16" "redis:7-alpine" "deploy-api:latest" "deploy-web:latest")
[ -f release-manifest.json ] || { echo "release-manifest.json was not found." >&2; exit 1; }
[ -f release-image-ids.txt ] || { echo "release-image-ids.txt was not found." >&2; exit 1; }
[ -f ec-data-images.tar ] || { echo "ec-data-images.tar was not found." >&2; exit 1; }

expected_image_ids=()
contract_index=0
while IFS= read -r contract_line || [ -n "$contract_line" ]; do
  if [ "$contract_index" -ge "${#required_images[@]}" ]; then
    echo "release-image-ids.txt must contain exactly four ordered entries." >&2
    exit 1
  fi
  expected_prefix="${required_images[$contract_index]}="
  case "$contract_line" in
    "$expected_prefix"*) expected_id="${contract_line#"$expected_prefix"}" ;;
    *) echo "release-image-ids.txt entry $((contract_index + 1)) has the wrong image or format." >&2; exit 1 ;;
  esac
  if [[ ! "$expected_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "release-image-ids.txt has an invalid image ID for ${required_images[$contract_index]}." >&2
    exit 1
  fi
  expected_image_ids+=("$expected_id")
  contract_index=$((contract_index + 1))
done < release-image-ids.txt
if [ "$contract_index" -ne "${#required_images[@]}" ]; then
  echo "release-image-ids.txt must contain exactly four ordered entries." >&2
  exit 1
fi

read_release_manifest_image_ids() {
  local manifest_path="$1"
  local manifest_line manifest_trimmed manifest_state="root_open"
  local manifest_line_number=0 images_index=0 image_ids_index=0
  local expected_comma manifest_image manifest_id manifest_file manifest_comma manifest_size manifest_hash image_source
  local expected_name actual_file_text manifest_file_text relative path index actual_size actual_hash
  local -a actual_files=()

  manifest_image_ids=()
  manifest_files=()
  manifest_file_sizes=()
  manifest_file_hashes=()
  manifest_file_commas=()
  expected_name="$(basename "$RELEASE_ROOT")"
  while IFS= read -r manifest_line || [ -n "$manifest_line" ]; do
    manifest_line_number=$((manifest_line_number + 1))
    if [ "$manifest_line_number" -eq 1 ] && [[ "$manifest_line" == $'\xEF\xBB\xBF'* ]]; then
      echo "release-manifest.json must be UTF-8 without a BOM." >&2
      return 1
    fi
    if [[ "$manifest_line" == *$'\r'* ]]; then
      if [[ "$manifest_line" != *$'\r' ]] || [[ "${manifest_line%$'\r'}" == *$'\r'* ]]; then
        echo "release-manifest.json contains an invalid carriage return." >&2
        return 1
      fi
      manifest_line="${manifest_line%$'\r'}"
    fi

    manifest_trimmed="$manifest_line"
    manifest_trimmed="${manifest_trimmed#"${manifest_trimmed%%[![:space:]]*}"}"
    manifest_trimmed="${manifest_trimmed%"${manifest_trimmed##*[![:space:]]}"}"

    case "$manifest_state" in
      root_open)
        [ "$manifest_trimmed" = "{" ] || { echo "release-manifest.json root must be one canonical object." >&2; return 1; }
        manifest_state="name"
        ;;
      name)
        [ "$manifest_trimmed" = "\"name\": \"$expected_name\"," ] || {
          echo "release-manifest.json name does not match the extracted release directory." >&2
          return 1
        }
        manifest_state="created_at"
        ;;
      created_at)
        if [[ ! "$manifest_trimmed" =~ ^\"createdAt\"[[:space:]]*:[[:space:]]*\"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\",$ ]]; then
          echo "release-manifest.json createdAt must be a canonical UTC timestamp." >&2
          return 1
        fi
        manifest_state="source_revision"
        ;;
      source_revision)
        if [[ ! "$manifest_trimmed" =~ ^\"sourceRevision\"[[:space:]]*:[[:space:]]*\"[0-9a-f]{40}\",$ ]]; then
          echo "release-manifest.json sourceRevision must be a lowercase Git commit ID." >&2
          return 1
        fi
        manifest_state="image_source"
        ;;
      image_source)
        if [[ ! "$manifest_trimmed" =~ ^\"imageSource\"[[:space:]]*:[[:space:]]*\"(local-build|prebuilt-archive)\",$ ]]; then
          echo "release-manifest.json imageSource is invalid." >&2
          return 1
        fi
        image_source="${BASH_REMATCH[1]}"
        manifest_state="images_open"
        ;;
      images_open)
        [ "$manifest_trimmed" = '"images": [' ] || {
          echo "release-manifest.json images must use the canonical array format." >&2
          return 1
        }
        manifest_state="images"
        ;;
      images)
        if [ "$images_index" -lt "${#required_images[@]}" ]; then
          expected_comma=","; [ "$images_index" -eq $((${#required_images[@]} - 1)) ] && expected_comma=""
          [ "$manifest_trimmed" = "\"${required_images[$images_index]}\"${expected_comma}" ] || {
            echo "release-manifest.json images entry $((images_index + 1)) has the wrong image or format." >&2
            return 1
          }
          images_index=$((images_index + 1))
        elif [ "$manifest_trimmed" = "]," ]; then
          manifest_state="image_ids_open"
        else
          echo "release-manifest.json images must contain exactly four ordered entries." >&2
          return 1
        fi
        ;;
      image_ids_open)
        [ "$manifest_trimmed" = '"imageIds": {' ] || {
          echo "release-manifest.json imageIds must use the canonical object format." >&2
          return 1
        }
        manifest_state="image_ids"
        ;;
      image_ids)
        if [ "$image_ids_index" -lt "${#required_images[@]}" ]; then
          if [[ ! "$manifest_trimmed" =~ ^\"([^\"]+)\"[[:space:]]*:[[:space:]]*\"(sha256:[0-9a-f]{64})\"(,?)$ ]]; then
            echo "release-manifest.json has an invalid imageIds entry." >&2
            return 1
          fi
          manifest_image="${BASH_REMATCH[1]}"
          manifest_id="${BASH_REMATCH[2]}"
          expected_comma=","; [ "$image_ids_index" -eq $((${#required_images[@]} - 1)) ] && expected_comma=""
          if [ "$manifest_image" != "${required_images[$image_ids_index]}" ] \
            || [ "${BASH_REMATCH[3]}" != "$expected_comma" ]; then
            echo "release-manifest.json imageIds entry $((image_ids_index + 1)) has the wrong image or format." >&2
            return 1
          fi
          manifest_image_ids+=("$manifest_id")
          image_ids_index=$((image_ids_index + 1))
        elif [ "$manifest_trimmed" = "}," ]; then
          manifest_state="files_open"
        else
          echo "release-manifest.json imageIds must contain exactly four ordered entries." >&2
          return 1
        fi
        ;;
      files_open)
        [ "$manifest_trimmed" = '"files": [' ] || {
          echo "release-manifest.json files must use the canonical array format." >&2
          return 1
        }
        manifest_state="files"
        ;;
      files)
        if [ "$manifest_trimmed" = "]" ]; then
          [ "${#manifest_files[@]}" -gt 0 ] || {
            echo "release-manifest.json files must not be empty." >&2
            return 1
          }
          manifest_state="root_close"
        elif [ "$manifest_trimmed" = "{" ]; then
          manifest_state="file_path"
        else
          echo "release-manifest.json files contains an invalid entry." >&2
          return 1
        fi
        ;;
      file_path)
        if [[ "$manifest_trimmed" =~ ^\"path\"[[:space:]]*:[[:space:]]*\"([^\"\\]+)\",$ ]]; then
          manifest_file="${BASH_REMATCH[1]}"
          case "$manifest_file" in
            /*|[A-Za-z]:*|./*|../*|*/./*|*/.|*/../*|*/..|*//*|*\\*|*$'\t'*)
              echo "release-manifest.json files contains an unsafe path." >&2
              return 1
              ;;
          esac
          manifest_state="file_size"
        else
          echo "release-manifest.json files contains an invalid path entry." >&2
          return 1
        fi
        ;;
      file_size)
        if [[ "$manifest_trimmed" =~ ^\"size\"[[:space:]]*:[[:space:]]*(0|[1-9][0-9]*),$ ]]; then
          manifest_size="${BASH_REMATCH[1]}"
          manifest_state="file_hash"
        else
          echo "release-manifest.json files contains an invalid size entry." >&2
          return 1
        fi
        ;;
      file_hash)
        if [[ "$manifest_trimmed" =~ ^\"sha256\"[[:space:]]*:[[:space:]]*\"([0-9a-f]{64})\"$ ]]; then
          manifest_hash="${BASH_REMATCH[1]}"
          manifest_state="file_close"
        else
          echo "release-manifest.json files contains an invalid SHA-256 entry." >&2
          return 1
        fi
        ;;
      file_close)
        if [ "$manifest_trimmed" != "}," ] && [ "$manifest_trimmed" != "}" ]; then
          echo "release-manifest.json files contains an invalid object terminator." >&2
          return 1
        fi
        manifest_files+=("$manifest_file")
        manifest_file_sizes+=("$manifest_size")
        manifest_file_hashes+=("$manifest_hash")
        manifest_file_commas+=("${manifest_trimmed#\}}")
        manifest_state="files"
        ;;
      root_close)
        [ "$manifest_trimmed" = "}" ] || {
          echo "release-manifest.json contains an unexpected root property or trailing content." >&2
          return 1
        }
        manifest_state="eof"
        ;;
      eof)
        echo "release-manifest.json contains trailing content." >&2
        return 1
        ;;
    esac
  done < "$manifest_path"

  if [ "$manifest_state" != "eof" ] \
    || [ "$images_index" -ne "${#required_images[@]}" ] \
    || [ "$image_ids_index" -ne "${#required_images[@]}" ]; then
    echo "release-manifest.json is incomplete or not in the canonical package format." >&2
    return 1
  fi

  for index in "${!manifest_files[@]}"; do
    expected_comma=","; [ "$index" -eq $((${#manifest_files[@]} - 1)) ] && expected_comma=""
    [ "${manifest_file_commas[$index]}" = "$expected_comma" ] || {
      echo "release-manifest.json files contains a non-canonical comma." >&2
      return 1
    }
  done

  [ ! -L "$RELEASE_ROOT" ] || { echo "Extracted release root must not be a symlink." >&2; return 1; }
  if find "$RELEASE_ROOT" -type l -print -quit | grep -q .; then
    echo "Extracted release payload must not contain symlinks." >&2
    return 1
  fi
  manifest_file_text="$(printf '%s\n' "${manifest_files[@]}" | LC_ALL=C sort)"
  while IFS= read -r -d '' path; do
    relative="${path#"$RELEASE_ROOT"/}"
    case "$relative" in
      release-manifest.json|deploy/.env) continue ;;
    esac
    case "$relative" in
      *$'\n'*|*$'\r'*|*'"'*|*\\*)
        printf 'Release payload contains a filename that cannot be represented safely: %q\n' "$relative" >&2
        return 1
        ;;
    esac
    actual_files+=("$relative")
  done < <(find "$RELEASE_ROOT" -type f -print0)
  actual_file_text="$(printf '%s\n' "${actual_files[@]}" | LC_ALL=C sort)"
  if [ "$manifest_file_text" != "$actual_file_text" ]; then
    echo "release-manifest.json files does not exactly match the extracted payload." >&2
    return 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    hash_file() { sha256sum -- "$1" | awk '{print $1}'; }
  elif command -v shasum >/dev/null 2>&1; then
    hash_file() { shasum -a 256 -- "$1" | awk '{print $1}'; }
  else
    echo "sha256sum or shasum is required to verify release files." >&2
    return 1
  fi
  for index in "${!manifest_files[@]}"; do
    path="$RELEASE_ROOT/${manifest_files[$index]}"
    [ -f "$path" ] && [ ! -L "$path" ] || { echo "Release manifest file is missing or unsafe: ${manifest_files[$index]}" >&2; return 1; }
    actual_size="$(wc -c < "$path" | tr -d '[:space:]')"
    actual_hash="$(hash_file "$path")"
    if [ "$actual_size" != "${manifest_file_sizes[$index]}" ] || [ "$actual_hash" != "${manifest_file_hashes[$index]}" ]; then
      echo "Release manifest file integrity check failed: ${manifest_files[$index]}" >&2
      return 1
    fi
  done
}

read_release_manifest_image_ids release-manifest.json
for index in "${!required_images[@]}"; do
  if [ "${manifest_image_ids[$index]}" != "${expected_image_ids[$index]}" ]; then
    echo "release-manifest.json and release-image-ids.txt disagree for ${required_images[$index]}." >&2
    exit 1
  fi
done

if [ ! -f deploy/.env ]; then
  echo "deploy/.env is required. Copy deploy/.env.example and set production secrets first." >&2
  exit 1
fi

read_env_value() {
  awk -v key="$1" '
    {
      sub(/\r$/, "")
      line = $0
      if (line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/) next
      separator = index(line, "=")
      if (separator == 0) next
      raw_name = substr(line, 1, separator - 1)
      normalized_name = raw_name
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", normalized_name)
      if (normalized_name != key) next
      count++
      if (raw_name != key) invalid = 1
      value = substr(line, separator + 1)
    }
    END {
      if (count != 1 || invalid) exit 2
      print value
    }
  ' deploy/.env
}

minimum_length() {
  case "$1" in
    JWT_SECRET) printf '32' ;;
    *) printf '12' ;;
  esac
}

secret_values=()
safe_secret_pattern='^[A-Za-z0-9._~!%*+,:?@^/=&-]+$'
database_secret_pattern='^[A-Za-z0-9._~-]+$'
for name in POSTGRES_PASSWORD APP_DB_PASSWORD ADMIN_PASSWORD JWT_SECRET; do
  if ! value="$(read_env_value "$name")"; then
    echo "$name must appear exactly once as an unquoted NAME=VALUE entry in deploy/.env." >&2
    exit 1
  fi
  required_length="$(minimum_length "$name")"
  if [[ ! "$value" =~ $safe_secret_pattern ]]; then
    echo "$name must be an unquoted ASCII token without whitespace, comments, interpolation, quotes, or backslashes." >&2
    exit 1
  fi
  if { [ "$name" = POSTGRES_PASSWORD ] || [ "$name" = APP_DB_PASSWORD ]; } \
    && [[ ! "$value" =~ $database_secret_pattern ]]; then
    echo "$name is embedded in a PostgreSQL URI and may contain only letters, digits, dot, underscore, tilde, or hyphen." >&2
    exit 1
  fi
  if [[ "$value" == change_me* ]] || [ "${#value}" -lt "$required_length" ]; then
    echo "$name must be replaced with a unique value of at least $required_length characters." >&2
    exit 1
  fi
  secret_values+=("$value")
done

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  [[ "$line" == *=* ]] || continue
  control_name="${line%%=*}"
  control_name="${control_name#"${control_name%%[![:space:]]*}"}"
  control_name="${control_name%"${control_name##*[![:space:]]}"}"
  if [[ "$control_name" == DOCKER_* ]] || { [[ "$control_name" == COMPOSE_* ]] && [ "$control_name" != "COMPOSE_PROJECT_NAME" ]; }; then
    echo "deploy/.env contains a forbidden Docker Compose control variable: $control_name" >&2
    exit 1
  fi
  if [ "$control_name" = "COMPOSE_PROJECT_NAME" ]; then
    control_value="${line#*=}"
    [[ "$control_value" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || { echo "COMPOSE_PROJECT_NAME must use a safe lowercase project name." >&2; exit 1; }
  fi
done < deploy/.env
if [ "$(printf '%s\n' "${secret_values[@]}" | LC_ALL=C sort -u | wc -l | tr -d ' ')" -ne 4 ]; then
  echo "POSTGRES_PASSWORD, APP_DB_PASSWORD, ADMIN_PASSWORD, and JWT_SECRET must be different values." >&2
  exit 1
fi

compose_cmd() { (cd deploy && docker compose --env-file .env -f docker-compose.yml "$@"); }

docker version >/dev/null
docker compose version >/dev/null
compose_cmd config --quiet
actual_services="$(compose_cmd config --services | LC_ALL=C sort)"
expected_services=$'api\nmigrate\npostgres\nredis\nweb'
[ "$actual_services" = "$expected_services" ] || { echo "Release Compose file must contain exactly postgres, redis, migrate, api, and web." >&2; exit 1; }

image_id_matches_archive() {
  local actual="$1" expected="$2" manifest config_digest
  [[ "$actual" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  command -v tar >/dev/null 2>&1 || return 1
  # The complete archive has already passed the release manifest hash check.
  manifest="$(tar -xOf ec-data-images.tar "blobs/sha256/${actual#sha256:}" 2>/dev/null)" || return 1
  manifest="$(printf '%s' "$manifest" | tr -d '\r\n')"
  printf '%s' "$manifest" | grep -Eq '"mediaType"[[:space:]]*:[[:space:]]*"application/vnd\.(oci\.image\.manifest\.v1\+json|docker\.distribution\.manifest\.v2\+json)"' || return 1
  printf '%s' "$manifest" | grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*2[[:space:]]*[,}]' || return 1
  config_digest="$(printf '%s' "$manifest" | sed -nE 's/.*"config"[[:space:]]*:[[:space:]]*\{[^}]*"digest"[[:space:]]*:[[:space:]]*"(sha256:[0-9a-f]{64})"[^}]*\}.*/\1/p')"
  [ "$config_digest" = "$expected" ]
}

docker load -i ec-data-images.tar
loaded_image_ids=()
for index in "${!required_images[@]}"; do
  image="${required_images[$index]}"
  actual_id="$(docker image inspect --format '{{.Id}}' "$image")" || {
    echo "The release archive did not provide required image $image." >&2
    exit 1
  }
  if [[ ! "$actual_id" =~ ^sha256:[0-9a-f]{64}$ ]] ||
     { [ "$actual_id" != "${expected_image_ids[$index]}" ] && ! image_id_matches_archive "$actual_id" "${expected_image_ids[$index]}"; }; then
    echo "Loaded image ID mismatch for $image: expected ${expected_image_ids[$index]}, found $actual_id" >&2
    exit 1
  fi
  loaded_image_ids+=("$actual_id")
done

compose_attempted=0
release_healthy=0
cleanup_failed_release() {
  original_status=$?
  trap - EXIT
  if [ "$compose_attempted" -eq 1 ] && [ "$release_healthy" -eq 0 ]; then
    if ! compose_cmd stop; then
      echo "Warning: failed to stop the unsuccessful release; inspect it manually." >&2
    fi
  fi
  exit "$original_status"
}
trap cleanup_failed_release EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

compose_attempted=1
compose_cmd up -d --no-build --force-recreate

assert_compose_image() {
  service="$1"
  expected_id="$2"
  container_id="$(compose_cmd ps --all -q "$service")"
  [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { echo "Required Compose service is missing or invalid: $service" >&2; exit 1; }
  actual_id="$(docker inspect --format '{{.Image}}' "$container_id")"
  if [[ ! "$actual_id" =~ ^sha256:[0-9a-f]{64}$ ]] || [ "$actual_id" != "$expected_id" ]; then
    echo "Compose service $service uses image $actual_id; expected $expected_id" >&2
    exit 1
  fi
}

assert_compose_image postgres "${loaded_image_ids[0]}"
assert_compose_image redis "${loaded_image_ids[1]}"
assert_compose_image migrate "${loaded_image_ids[2]}"
assert_compose_image api "${loaded_image_ids[2]}"
assert_compose_image web "${loaded_image_ids[3]}"

deadline=$((SECONDS + 180))
while [ "$SECONDS" -lt "$deadline" ]; do
  all_ready=1
  for service in postgres redis api web; do
    container_id="$(compose_cmd ps --all -q "$service")"
    [[ "$container_id" =~ ^[0-9a-f]{12,64}$ ]] || { echo "Required Compose service is missing or invalid: $service" >&2; exit 1; }
    state="$(docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{end}}|{{.State.ExitCode}}' "$container_id")"
    case "$state" in
      exited*|dead*|*'|unhealthy|'*) echo "Release service $service failed: $state" >&2; exit 1 ;;
    esac
    case "$state" in
      running'|healthy|'*) ;;
      *) all_ready=0 ;;
    esac
  done

  migrate_id="$(compose_cmd ps --all -q migrate)"
  [[ "$migrate_id" =~ ^[0-9a-f]{12,64}$ ]] || { echo "Required Compose service is missing or invalid: migrate" >&2; exit 1; }
  migrate_state="$(docker inspect --format '{{.State.Status}}|{{.State.ExitCode}}' "$migrate_id")"
  case "$migrate_state" in
    exited'|0') migrate_ready=1 ;;
    exited'|'*) echo "Migration container failed: $migrate_state" >&2; exit 1 ;;
    *) migrate_ready=0 ;;
  esac

  if [ "$all_ready" -eq 1 ] && [ "$migrate_ready" -eq 1 ]; then
    release_healthy=1
    echo "Release is healthy: PostgreSQL, Redis, API, and Web are ready at http://localhost:3997"
    exit 0
  fi
  sleep 2
done

echo "Timed out waiting for migration completion and service health." >&2
exit 1
