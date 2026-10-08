#!/usr/bin/env bash
# Build a recipient-safe offline ZIP. Set SKIP_IMAGE_EXPORT=1 only for structural tests.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEFAULT_RELEASE_ROOT="${PROJECT_ROOT}/release"
RELEASE_ROOT="${RELEASE_ROOT:-$DEFAULT_RELEASE_ROOT}"
SKIP_IMAGE_EXPORT="${SKIP_IMAGE_EXPORT:-0}"
SKIP_FRONT_PROFIT_LOCAL_PRECHECK="${SKIP_FRONT_PROFIT_LOCAL_PRECHECK:-0}"
PREBUILT_IMAGE_ARCHIVE="${PREBUILT_IMAGE_ARCHIVE:-}"
PREBUILT_IMAGE_PROVENANCE="${PREBUILT_IMAGE_PROVENANCE:-}"
case "$SKIP_IMAGE_EXPORT" in
  1|true|TRUE) SKIP_IMAGE_EXPORT=1 ;;
  0|false|FALSE|'') SKIP_IMAGE_EXPORT=0 ;;
  *) echo "SKIP_IMAGE_EXPORT must be 0, 1, false, or true." >&2; exit 1 ;;
esac
case "$SKIP_FRONT_PROFIT_LOCAL_PRECHECK" in
  1|true|TRUE) SKIP_FRONT_PROFIT_LOCAL_PRECHECK=1 ;;
  0|false|FALSE|'') SKIP_FRONT_PROFIT_LOCAL_PRECHECK=0 ;;
  *) echo "SKIP_FRONT_PROFIT_LOCAL_PRECHECK must be 0, 1, false, or true." >&2; exit 1 ;;
esac
if { [ -n "$PREBUILT_IMAGE_ARCHIVE" ] && [ -z "$PREBUILT_IMAGE_PROVENANCE" ]; } ||
   { [ -z "$PREBUILT_IMAGE_ARCHIVE" ] && [ -n "$PREBUILT_IMAGE_PROVENANCE" ]; }; then
  echo "PREBUILT_IMAGE_ARCHIVE and PREBUILT_IMAGE_PROVENANCE must be supplied together." >&2
  exit 1
fi
if [ "$SKIP_IMAGE_EXPORT" -eq 1 ] && { [ -n "$PREBUILT_IMAGE_ARCHIVE" ] || [ -n "$PREBUILT_IMAGE_PROVENANCE" ]; }; then
  echo "SKIP_IMAGE_EXPORT cannot be combined with prebuilt image inputs." >&2
  exit 1
fi

RELEASE_DOCS=(
  "GETTING_STARTED.md"
  "DEPENDENCY_SECURITY_2026-10-08.md"
  "HOW_TO_ADD_MODULE.md"
  "HOW_TO_ADD_PLATFORM.md"
  "SELF_SERVICE_MODULES.md"
  "DIY_SEMANTIC_EXTENSIONS.md"
  "USER_GUIDE.md"
  "AI_DIY_GUIDE.md"
  "AI_PROMPTS.md"
  "加模块_给人看.md"
  "部署指南.md"
  "离线包使用说明.md"
)
REQUIRED_IMAGES=(
  "postgres:16"
  "redis:7-alpine"
  "deploy-api:latest"
  "deploy-web:latest"
)

mkdir -p "$RELEASE_ROOT"
RELEASE_DIR="$(cd "$RELEASE_ROOT" && pwd)"
cd "$PROJECT_ROOT"

run_front_profit_local_release_precheck() {
  if [ "$SKIP_FRONT_PROFIT_LOCAL_PRECHECK" -eq 1 ]; then
    echo "Warning: skipping front-profit local release precheck; use this only for structural package tests." >&2
    return 0
  fi
  pnpm --filter @ec/api run front-profit:local-release-precheck
}

assert_front_profit_template_directory() {
  local root="$1"
  node - "$root" <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = process.argv[2];
const decode = (value) => Buffer.from(value, "base64").toString("utf8");
const workbookNames = [
  decode("MDEt55S15ZWG5YmN5Y+w5Yip5ram5Y2V6KGo5LiK5Lyg5qih5p2/Lnhsc3g="),
  decode("MDIt55S15ZWG5YmN5Y+w5Yip5ram5pWw5o2u5YeG5aSH5LiO5pig5bCE5qih5p2/Lnhsc3g="),
];
const expectedNames = [
  ...workbookNames,
  decode("UkVBRE1FLeWJjeWPsOWIqea2puaooeadv+S9v+eUqOivtOaYji5tZA=="),
  "template-manifest.json",
  "SHA256SUMS.txt",
].sort();

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  throw new Error(`Front-profit template directory is missing: ${root}`);
}
const entries = fs.readdirSync(root, { withFileTypes: true });
const actualNames = entries.map((entry) => entry.name).sort();
if (!entries.every((entry) => entry.isFile()) || JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
  throw new Error(`Front-profit templates do not match the exact allowlist: ${actualNames.join(", ")}`);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "template-manifest.json"), "utf8"));
if (manifest.containsRealBusinessData !== false) {
  throw new Error("Front-profit template manifest must declare containsRealBusinessData=false.");
}
if (!Array.isArray(manifest.files)) {
  throw new Error("Front-profit template manifest files must be an array.");
}
const manifestNames = manifest.files.map((entry) => entry.name).sort();
if (JSON.stringify(manifestNames) !== JSON.stringify([...workbookNames].sort())) {
  throw new Error(`Front-profit template manifest does not list the exact workbook allowlist: ${manifestNames.join(", ")}`);
}

const manifestHashes = new Map();
for (const entry of manifest.files) {
  const declaredHash = String(entry.sha256 ?? "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(declaredHash)) {
    throw new Error(`Invalid front-profit template SHA-256 in manifest: ${entry.name}`);
  }
  if (entry.businessDataRows !== 0) {
    throw new Error(`Front-profit template manifest must declare businessDataRows=0: ${entry.name}`);
  }
  const actualHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, entry.name))).digest("hex").toUpperCase();
  if (actualHash !== declaredHash) {
    throw new Error(`Front-profit template SHA-256 mismatch: ${entry.name}`);
  }
  manifestHashes.set(entry.name, declaredHash);
}

const sumLines = fs.readFileSync(path.join(root, "SHA256SUMS.txt"), "utf8").split(/\r?\n/).filter(Boolean);
if (sumLines.length !== workbookNames.length) {
  throw new Error("Front-profit SHA256SUMS.txt must contain exactly the two allowed workbooks.");
}
const sumNames = [];
for (const line of sumLines) {
  const match = line.match(/^([0-9A-Fa-f]{64})  (.+)$/);
  if (!match) throw new Error("Invalid front-profit SHA256SUMS.txt line.");
  const [, hash, name] = match;
  if (!manifestHashes.has(name) || manifestHashes.get(name) !== hash.toUpperCase()) {
    throw new Error(`Front-profit SHA256SUMS.txt does not match the manifest: ${name}`);
  }
  sumNames.push(name);
}
if (JSON.stringify(sumNames.sort()) !== JSON.stringify([...workbookNames].sort())) {
  throw new Error("Front-profit SHA256SUMS.txt does not list the exact workbook allowlist.");
}
EOF
}

assert_release_tree() {
  local root="$1"
  local path name lower_name relative

  while IFS= read -r -d '' path; do
    name="${path##*/}"
    lower_name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    relative="${path#"$root"/}"
    case "$lower_name" in
      .env.example) ;;
      .env|.env.*|*.env)
        echo "Forbidden release content: $path" >&2
        return 1
        ;;
    esac
    case "$name" in
      .git|node_modules|spec|对话收集)
        echo "Forbidden release content: $path" >&2
        return 1
        ;;
    esac
    case "$lower_name" in
      *.xlsx)
        case "$relative" in
          templates/front-profit/*.xlsx) ;;
          *)
            echo "Forbidden release content: $path" >&2
            return 1
            ;;
        esac
        ;;
      *.xls|*.csv|*.sqlite|*.dump|*.bak|*.backup|*.log)
        echo "Forbidden release content: $path" >&2
        return 1
        ;;
    esac
  done < <(find "$root" -mindepth 1 -print0)

  local actual_docs expected_docs
  actual_docs="$(cd "$root/docs" && find . -type f -print | sed 's#^./##' | LC_ALL=C sort)"
  expected_docs="$(printf '%s\n' "${RELEASE_DOCS[@]}" | LC_ALL=C sort)"
  if [ "$actual_docs" != "$expected_docs" ]; then
    echo "Release docs do not match the recipient allowlist:" >&2
    printf '%s\n' "$actual_docs" >&2
    return 1
  fi

  assert_front_profit_template_directory "$root/templates/front-profit"
}

assert_release_manifest() {
  local root="$1"
  node - "$root" <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[2];
const manifestPath = path.join(root, "release-manifest.json");
if (!fs.existsSync(manifestPath)) throw new Error(`Release manifest is missing: ${manifestPath}`);
const requiredImages = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
const manifestText = fs.readFileSync(manifestPath, "utf8");
const archiveExists = fs.existsSync(path.join(root, "ec-data-images.tar"));
for (const propertyName of ["imageSource", "images", "imageIds", "files", ...(archiveExists ? requiredImages : [])]) {
  const escaped = propertyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = manifestText.match(new RegExp(`"${escaped}"\\s*:`, "g")) ?? [];
  if (matches.length !== 1) throw new Error(`Release manifest must contain exactly one property named ${propertyName}.`);
}
const manifest = JSON.parse(manifestText);
if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
  throw new Error("Release manifest root must be an object.");
}
const expectedRootKeys = ["name", "createdAt", "sourceRevision", "imageSource", "images", "imageIds", "files"];
if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(expectedRootKeys)) {
  throw new Error("Release manifest must contain exactly the canonical ordered root properties.");
}
const expectedImageSource = archiveExists
  ? (fs.existsSync(path.join(root, "image-provenance.json")) ? "prebuilt-archive" : "local-build")
  : "structural-no-images";
if (manifest.imageSource !== expectedImageSource) throw new Error("Release manifest imageSource does not match its payload.");
if (!Array.isArray(manifest.images) || JSON.stringify(manifest.images) !== JSON.stringify(requiredImages)) {
  throw new Error("Release manifest images must exactly match the required image list.");
}
if (!manifest.imageIds || Array.isArray(manifest.imageIds) || typeof manifest.imageIds !== "object") {
  throw new Error("Release manifest imageIds must be an object.");
}
const contractPath = path.join(root, "release-image-ids.txt");
const imageIdKeys = Object.keys(manifest.imageIds);
if (archiveExists) {
  if (imageIdKeys.length !== requiredImages.length || !requiredImages.every((image) => imageIdKeys.includes(image))) {
    throw new Error("Release manifest imageIds must contain exactly the required images.");
  }
  const expectedContract = requiredImages.map((image) => {
    const imageId = manifest.imageIds[image];
    if (typeof imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
      throw new Error(`Release manifest has an invalid image ID for ${image}.`);
    }
    return `${image}=${imageId}`;
  }).join("\n") + "\n";
  if (!fs.existsSync(contractPath) || fs.readFileSync(contractPath, "utf8") !== expectedContract) {
    throw new Error("Release image-ID contract does not exactly match the manifest.");
  }
} else if (imageIdKeys.length !== 0 || fs.existsSync(contractPath)) {
  throw new Error("A structural package without an image archive must not contain image IDs.");
}
if (!Array.isArray(manifest.files)) throw new Error("Release manifest files must be an array.");
const files = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release payload must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) visit(absolute);
    if (entry.isFile() && absolute !== manifestPath) {
      const bytes = fs.readFileSync(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        size: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
};
visit(root);
const listed = [...manifest.files];
files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
if (JSON.stringify(listed) !== JSON.stringify(files)) {
  throw new Error("Release manifest file records do not match the staged payload.");
}
EOF
}

normalize_staged_shell_scripts() {
  local root="$1"
  local path validator

  if ! command -v node >/dev/null 2>&1; then
    echo "node is required to normalize staged shell scripts." >&2
    return 1
  fi
  if command -v iconv >/dev/null 2>&1; then validator="iconv"; else validator="node"; fi

  while IFS= read -r -d '' path; do
    if [ "$validator" = "iconv" ]; then
      if ! iconv -f UTF-8 -t UTF-8 "$path" >/dev/null; then
        echo "Shell script is not valid UTF-8: $path" >&2
        return 1
      fi
    elif ! node - "$path" <<'EOF'
const fs = require("node:fs");
new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(process.argv[2]));
EOF
    then
      echo "Shell script is not valid UTF-8: $path" >&2
      return 1
    fi
  done < <(find "$root" -type f -name '*.sh' -print0)

  node - "$root" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(absolute);
    if (entry.isFile() && entry.name.endsWith(".sh")) {
      const input = fs.readFileSync(absolute);
      let offset = input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf ? 3 : 0;
      const output = [];
      for (; offset < input.length; offset += 1) {
        if (input[offset] === 0x0d) {
          if (input[offset + 1] === 0x0a) offset += 1;
          output.push(0x0a);
        } else output.push(input[offset]);
      }
      fs.writeFileSync(absolute, Buffer.from(output));
    }
  }
};
visit(process.argv[2]);
EOF
}

create_zip() {
  local source="$1" destination="$2"
  if command -v zip >/dev/null 2>&1; then
    (cd "$(dirname "$source")" && zip -qr "$destination" "$(basename "$source")")
  elif command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    PACKAGE_SOURCE_WIN="$(cygpath -w "$source")" PACKAGE_ZIP_WIN="$(cygpath -w "$destination")" \
      powershell.exe -NoProfile -Command \
      '$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $source = [IO.Path]::GetFullPath($env:PACKAGE_SOURCE_WIN); $parent = [IO.Directory]::GetParent($source).FullName; $archive = [IO.Compression.ZipFile]::Open($env:PACKAGE_ZIP_WIN, [IO.Compression.ZipArchiveMode]::Create); try { Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object { $entry = $_.FullName.Substring($parent.Length + 1).Replace("\", "/"); [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $_.FullName, $entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { if ($archive) { $archive.Dispose() } }'
  elif command -v bsdtar >/dev/null 2>&1; then
    bsdtar -a -cf "$destination" -C "$(dirname "$source")" "$(basename "$source")"
  else
    echo "zip is required to create the release archive." >&2
    return 1
  fi
}

extract_zip() {
  local archive="$1" destination="$2"
  if command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    PACKAGE_ZIP_WIN="$(cygpath -w "$archive")" PACKAGE_EXPANDED_WIN="$(cygpath -w "$destination")" \
      powershell.exe -NoProfile -Command \
      'Expand-Archive -LiteralPath $env:PACKAGE_ZIP_WIN -DestinationPath $env:PACKAGE_EXPANDED_WIN -Force'
  elif command -v unzip >/dev/null 2>&1; then
    unzip -q "$archive" -d "$destination"
  else
    echo "unzip is required for the post-extraction release audit." >&2
    return 1
  fi
}

DIST_NAME="ec-data-platform-$(date +%Y%m%d)"
ZIP_FINAL="${RELEASE_DIR}/${DIST_NAME}.zip"
STAGING_ROOT="$(mktemp -d "${RELEASE_DIR}/.package-${DIST_NAME}.XXXXXX")"
DIST_PATH="${STAGING_ROOT}/${DIST_NAME}"
ZIP_TEMP="${STAGING_ROOT}/${DIST_NAME}.zip"
EXPANDED_ROOT="${STAGING_ROOT}/expanded"

cleanup() {
  case "$STAGING_ROOT" in
    "$RELEASE_DIR"/.package-*) rm -rf -- "$STAGING_ROOT" ;;
    *) echo "Refusing to clean unsafe staging path: $STAGING_ROOT" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

echo "========================================"
echo "  ec-data-platform package tool"
echo "========================================"

SOURCE_REVISION="not-exported"
IMAGE_IDS_JSON='{}'
PROVENANCE_IMAGE_IDS_JSON='{}'
IMAGE_SOURCE="structural-no-images"
if [ "$SKIP_IMAGE_EXPORT" -eq 0 ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required; start Docker Desktop first." >&2
    exit 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "git is required to record release provenance." >&2
    exit 1
  fi
  if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
    echo "Refusing to package a dirty source worktree." >&2
    exit 1
  fi
  SOURCE_REVISION="$(git rev-parse HEAD)"
  if [ -n "$PREBUILT_IMAGE_ARCHIVE" ]; then
    [ -f "$PREBUILT_IMAGE_ARCHIVE" ] || { echo "Prebuilt image archive was not found: $PREBUILT_IMAGE_ARCHIVE" >&2; exit 1; }
    [ -f "$PREBUILT_IMAGE_PROVENANCE" ] || { echo "Prebuilt image provenance was not found: $PREBUILT_IMAGE_PROVENANCE" >&2; exit 1; }
    PROVENANCE_IMAGE_IDS_JSON="$(node - "$PREBUILT_IMAGE_PROVENANCE" "$PREBUILT_IMAGE_ARCHIVE" "$SOURCE_REVISION" "${REQUIRED_IMAGES[@]}" <<'EOF'
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const [provenancePath, archivePath, sourceRevision, ...images] = process.argv.slice(2);
const provenance = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
if (!provenance || Array.isArray(provenance) || typeof provenance !== "object" ||
    JSON.stringify(Object.keys(provenance)) !== JSON.stringify(["schemaVersion", "sourceRevision", "archiveSha256", "images"]) ||
    provenance.schemaVersion !== 1 || provenance.sourceRevision !== sourceRevision ||
    !/^[0-9a-f]{64}$/.test(provenance.archiveSha256)) {
  throw new Error("Prebuilt image provenance has invalid canonical root metadata.");
}
const actualArchiveHash = execFileSync("sha256sum", [archivePath], { encoding: "utf8" }).trim().split(/\s+/)[0];
if (provenance.archiveSha256 !== actualArchiveHash) throw new Error("Prebuilt image provenance archiveSha256 does not match the supplied archive.");
if (!provenance.images || Array.isArray(provenance.images) || typeof provenance.images !== "object" ||
    JSON.stringify(Object.keys(provenance.images)) !== JSON.stringify(images)) throw new Error("Prebuilt image provenance must contain exactly the ordered required images.");
const ids = {};
for (const image of images) {
  const entry = provenance.images[image];
  const keys = ["imageId", "registryRepository", "digest", "reference"];
  if (!entry || Array.isArray(entry) || typeof entry !== "object" ||
      JSON.stringify(Object.keys(entry)) !== JSON.stringify(keys) ||
      typeof entry.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.imageId)) {
    throw new Error(`Prebuilt image provenance has invalid canonical metadata for ${image}.`);
  }
  if (typeof entry.registryRepository !== "string" || !/^[a-z0-9.-]+(?::[0-9]+)?\/[a-z0-9._/-]+$/.test(entry.registryRepository) ||
      typeof entry.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(entry.digest) || entry.reference !== `${entry.registryRepository}@${entry.digest}`) {
    throw new Error(`Prebuilt image provenance has invalid registry evidence for ${image}.`);
  }
  ids[image] = entry.imageId;
}
process.stdout.write(JSON.stringify(ids));
EOF
)"
    run_front_profit_local_release_precheck
    docker load -i "$PREBUILT_IMAGE_ARCHIVE"
    IMAGE_SOURCE="prebuilt-archive"
  else
    while IFS= read -r environment_name; do
      case "$environment_name" in
        COMPOSE_*)
          echo "Local image build refuses Docker Compose control variable: $environment_name" >&2
          exit 1
        ;;
      esac
    done < <(compgen -e)
    run_front_profit_local_release_precheck
    (
      cd deploy
      docker compose --env-file .env.example -f docker-compose.yml build --pull api web
    )
    IMAGE_SOURCE="local-build"
  fi
  for image in "${REQUIRED_IMAGES[@]}"; do docker image inspect "$image" >/dev/null; done
  LOADED_IMAGE_IDS=()
  for image in "${REQUIRED_IMAGES[@]}"; do
    image_id="$(docker image inspect --format '{{.Id}}' "$image")"
    [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Docker returned an invalid image ID for $image." >&2; exit 1; }
    LOADED_IMAGE_IDS+=("$image_id")
  done
  IMAGE_IDS_JSON="$(node - "${REQUIRED_IMAGES[@]}" "${LOADED_IMAGE_IDS[@]}" <<'EOF'
const args = process.argv.slice(2);
const images = args.slice(0, 4);
const values = args.slice(4);
const ids = {};
for (let index = 0; index < images.length; index += 1) ids[images[index]] = values[index];
process.stdout.write(JSON.stringify(ids));
EOF
)"
  if [ -n "$PREBUILT_IMAGE_ARCHIVE" ]; then
    node - "$IMAGE_IDS_JSON" "$PROVENANCE_IMAGE_IDS_JSON" "${REQUIRED_IMAGES[@]}" <<'EOF'
const [actualJson, expectedJson, ...images] = process.argv.slice(2);
const actual = JSON.parse(actualJson);
const expected = JSON.parse(expectedJson);
if (!images.every((image) => actual[image] === expected[image])) throw new Error("Loaded image IDs do not match prebuilt provenance.");
EOF
  fi
fi

mkdir -p "$DIST_PATH/docs" "$DIST_PATH/apps/api/src" "$DIST_PATH/templates"

if [ "$SKIP_IMAGE_EXPORT" -eq 0 ]; then
  echo "[1/4] Exporting four Docker images..."
  if [ -n "$PREBUILT_IMAGE_ARCHIVE" ]; then
    cp "$PREBUILT_IMAGE_ARCHIVE" "${DIST_PATH}/ec-data-images.tar"
    cp "$PREBUILT_IMAGE_PROVENANCE" "${DIST_PATH}/image-provenance.json"
  else
    docker save "${REQUIRED_IMAGES[@]}" -o "${DIST_PATH}/ec-data-images.tar"
  fi
else
  echo "[1/4] Skipping Docker image export."
fi

echo "[2/4] Copying recipient-safe deployment content..."
cp -r deploy "${DIST_PATH}/"
cp -r apps/api/src/modules "${DIST_PATH}/apps/api/src/"
cp -r apps/api/extensions "${DIST_PATH}/apps/api/"
for doc in "${RELEASE_DOCS[@]}"; do
  [ -f "docs/$doc" ] || { echo "Required release doc is missing: docs/$doc" >&2; exit 1; }
  cp "docs/$doc" "${DIST_PATH}/docs/$doc"
done
cp LICENSE THIRD_PARTY_NOTICES.md "${DIST_PATH}/"
assert_front_profit_template_directory "templates/front-profit"
cp -r templates/front-profit "${DIST_PATH}/templates/"
rm -f "${DIST_PATH}/deploy/.env"

echo "[3/4] Writing launchers and manifest..."
cat > "${DIST_PATH}/README.md" <<'EOF'
# ec-data-platform 离线运行包

## 先看这里：按读者分开

- 第一次下载：[从 GitHub 下载与首次启动](docs/GETTING_STARTED.md)。
- 本版依赖修复与限制：[依赖安全说明](docs/DEPENDENCY_SECURITY_2026-10-08.md)。
- 给人看：[安装与使用手册](docs/USER_GUIDE.md)。新手先读这一份。
- 给开发 AI 看：[接手与 DIY 说明](docs/AI_DIY_GUIDE.md)。不是平台内业务 AI 的系统提示词。
- 复制给 AI：[任务提示词](docs/AI_PROMPTS.md)。按需填写，不附秘密或真实数据库。

电脑已有中台时，不要直接启动第二份包；先按手册完成备份和升级确认。

1. 安装并启动 Docker Desktop。
2. 复制 `deploy/.env.example` 为 `deploy/.env`，替换全部 `change_me` 示例值。
3. Windows 运行 `start.bat`；macOS/Linux 运行 `bash start.sh`。
4. 服务健康后打开 http://localhost:3997。
5. 使用 `backup.ps1` / `backup.sh` 生成带完整性清单的实例备份；恢复必须使用对应的 `restore` 脚本并显式确认目标实例。

每次启动都会导入 `ec-data-images.tar`、按打包阶段与 `release-manifest.json` 交叉审计过的 `release-image-ids.txt` 核对镜像 ID，并使用已核验镜像重建容器。
脱敏前台利润模板位于 `templates/front-profit/`。
完整说明见 `docs/离线包使用说明.md`。模块、连接器和垂直方案配置包位于 `apps/api/extensions/`；本包不含完整源码、密钥或真实业务数据。
项目自有代码按 MIT 分发，见根目录 `LICENSE`；第三方许可见 `THIRD_PARTY_NOTICES.md`。与清单 `sourceRevision` 对应的完整源码位于 `https://github.com/wangge-dev/ec-data-platform-open`。本包不授权传播任何用户的真实经营数据、密钥或备份。
EOF

cp scripts/release-start.ps1 "${DIST_PATH}/start.ps1"
cp scripts/release-start.sh "${DIST_PATH}/start.sh"
cp scripts/release-start.bat "${DIST_PATH}/start.bat"
cp scripts/sha256.ps1 "${DIST_PATH}/sha256.ps1"
cp scripts/instance-backup.ps1 "${DIST_PATH}/backup.ps1"
cp scripts/instance-restore.ps1 "${DIST_PATH}/restore.ps1"
cp scripts/instance-backup.sh "${DIST_PATH}/backup.sh"
cp scripts/instance-restore.sh "${DIST_PATH}/restore.sh"
chmod +x "${DIST_PATH}/start.sh" "${DIST_PATH}/backup.sh" "${DIST_PATH}/restore.sh"
normalize_staged_shell_scripts "$DIST_PATH"

node - "$DIST_PATH" "$DIST_NAME" "$SOURCE_REVISION" "$IMAGE_SOURCE" "$IMAGE_IDS_JSON" <<'EOF'
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const [root, name, sourceRevision, imageSource, imageIdsJson] = process.argv.slice(2);
const images = ["postgres:16", "redis:7-alpine", "deploy-api:latest", "deploy-web:latest"];
const imageIds = JSON.parse(imageIdsJson);
if (Object.keys(imageIds).length > 0) {
  const contract = images.map((image) => `${image}=${imageIds[image]}`).join("\n") + "\n";
  fs.writeFileSync(path.join(root, "release-image-ids.txt"), contract, "utf8");
}
const files = [];
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Release payload must not contain symlinks: ${absolute}`);
    if (entry.isDirectory()) visit(absolute);
    if (entry.isFile()) {
      const bytes = fs.readFileSync(absolute);
      files.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        size: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
};
visit(root);
const manifest = {
  name,
  createdAt: new Date().toISOString(),
  sourceRevision,
  imageSource,
  images,
  imageIds,
  files: files.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
};
fs.writeFileSync(path.join(root, "release-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
EOF

assert_release_tree "$DIST_PATH"
assert_release_manifest "$DIST_PATH"

echo "[4/4] Creating and post-extraction auditing ZIP..."
create_zip "$DIST_PATH" "$ZIP_TEMP"
mkdir -p "$EXPANDED_ROOT"
extract_zip "$ZIP_TEMP" "$EXPANDED_ROOT"
assert_release_tree "$EXPANDED_ROOT/$DIST_NAME"
assert_release_manifest "$EXPANDED_ROOT/$DIST_NAME"

# ZIP_TEMP and ZIP_FINAL share a filesystem. This is the only operation that
# replaces a prior archive, and it happens after both audits complete.
mv -f -- "$ZIP_TEMP" "$ZIP_FINAL"

echo "Release ZIP: $ZIP_FINAL"
if command -v sha256sum >/dev/null 2>&1; then
  echo "SHA-256: $(sha256sum "$ZIP_FINAL" | awk '{print toupper($1)}')"
fi
