import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { validateRuntimeSecrets } from "../src/lib/runtime-secrets.js";

const root = resolve(import.meta.dirname, "../../..");
const release = readFileSync(
  resolve(root, ".github/workflows/release.yml"),
  "utf8",
);
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");

const postgresService =
  "image: postgres:16@sha256:95206741a5b214807675e14165369d05b93a9cf692223b616d07cca227e74b0b";
const createApplicationRoleSql =
  "SELECT format('CREATE ROLE ec_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', $1::text) AS command";
const ciRuntimeSecrets = {
  POSTGRES_PASSWORD: "CiPostgres7Rk2Vm9",
  APP_DB_PASSWORD: "CiAppDb8Qw4Nz6Ty",
  ADMIN_PASSWORD: "CiAdmin9Lp5Xs3Ku",
  JWT_SECRET: "CiJwt7Fh2Qm9Vr4Nz6Ty8Kp3Ws5Ld1Xc",
};

function releaseJob(name: string, nextName?: string) {
  const start = release.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = nextName ? release.indexOf(`  ${nextName}:`, start + 1) : release.length;
  expect(end).toBeGreaterThan(start);
  return release.slice(start, end);
}

describe("release workflow supply-chain contract", () => {
  test("pins the CI and tagged-revision PostgreSQL services to the audited digest", () => {
    expect(ci).toContain(postgresService);
    expect(release).toContain(postgresService);
    expect(ci).not.toMatch(/^\s+image: postgres:16\s*$/m);
    expect(release).not.toMatch(/^\s+image: postgres:16\s*$/m);
  });

  test("casts the role password parameter before passing it to PostgreSQL format", () => {
    expect(ci).toContain(createApplicationRoleSql);
    expect(release).toContain(createApplicationRoleSql);
    expect(ci).not.toContain(
      "CREATE ROLE ec_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', $1) AS command",
    );
    expect(release).not.toContain(
      "CREATE ROLE ec_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE', $1) AS command",
    );
  });

  test("provides every non-placeholder runtime secret to migration jobs", () => {
    expect(() => validateRuntimeSecrets(ciRuntimeSecrets)).not.toThrow();
    for (const workflow of [ci, release]) {
      for (const [name, value] of Object.entries(ciRuntimeSecrets)) {
        expect(workflow).toContain(`${name}: ${value}`);
      }
      expect(workflow).not.toContain("ci_postgres_password");
      expect(workflow).not.toContain("ci_app_password");
    }
  });

  test("checks the Web image with the Compose upstream hostname available", () => {
    expect(ci).toMatch(
      /docker run --rm --add-host api:127\.0\.0\.1 --entrypoint sh "\$\{web_image\}" -c \\\r?\n\s+'test -s \/usr\/share\/nginx\/html\/index\.html && nginx -t'/,
    );
    expect(ci).not.toContain('docker run --rm --entrypoint sh "${web_image}" -c');
  });

  test("builds each application image once and freezes exact registry digests", () => {
    const images = releaseJob("release");
    expect(images.match(/docker\/build-push-action@/g)).toHaveLength(2);
    expect(images).toContain("id: api_build");
    expect(images).toContain("id: web_build");
    expect(images.match(/type=sha,format=long,prefix=sha-/g)).toHaveLength(2);
    expect(images).not.toContain("type=ref,event=tag");
    expect(images).toContain("API_DIGEST: ${{ steps.api_build.outputs.digest }}");
    expect(images).toContain("WEB_DIGEST: ${{ steps.web_build.outputs.digest }}");
    expect(images).toContain('docker pull "${api_reference}"');
    expect(images).toContain('docker pull "${web_reference}"');
    expect(images).toContain('docker pull "${postgres_reference}"');
    expect(images).toContain('docker pull "${redis_reference}"');
    expect(images.match(/\bdocker save\b/g)).toHaveLength(1);
    expect(
      images.match(/archive="\$\{IMAGE_BUNDLE_ROOT\}\/ec-data-images\.tar"/g),
    ).toHaveLength(1);
    expect(
      images.match(
        /PROVENANCE_PATH="\$\{IMAGE_BUNDLE_ROOT\}\/image-provenance\.json"/g,
      ),
    ).toHaveLength(1);
    for (const tag of [
      "postgres:16",
      "redis:7-alpine",
      "deploy-api:latest",
      "deploy-web:latest",
    ]) {
      const entryStart = images.indexOf(`              "${tag}": {`);
      expect(entryStart).toBeGreaterThanOrEqual(0);
      const entryEnd = images.indexOf("              },", entryStart);
      expect(entryEnd).toBeGreaterThan(entryStart);
      const entry = images.slice(entryStart, entryEnd);
      expect(entry).toContain("imageId:");
      expect(entry).toContain("registryRepository:");
      expect(entry).toContain("digest:");
      expect(entry).toContain("reference:");
    }
    expect(images).not.toContain("actions/upload-artifact@");
    expect(images).not.toContain("actions/download-artifact@");
  });

  test("packages, smokes, and stages the same local archive without artifact transport", () => {
    const job = releaseJob("release");
    expect(job).toContain("needs: verify");
    expect(job).toContain('DOCKER_BUILD_RECORD_UPLOAD: "false"');
    expect(job).toContain('DOCKER_BUILD_SUMMARY: "false"');
    expect(job).toContain("PREBUILT_IMAGE_ARCHIVE:");
    expect(job).toContain("PREBUILT_IMAGE_PROVENANCE:");
    expect(job).toContain("pnpm install --frozen-lockfile");
    expect(job).toContain("scripts/package-ecommerce-workbench.ps1");
    expect(job).toContain("ecommerce-workbench-v1.zip");
    expect(job).toContain("scripts/package-cloud-kit.py");
    expect(job).toContain('if [[ "${name}" == DOCKER_* || "${name}" == COMPOSE_* ]]');
    expect(job).toContain('unset "${name}"');
    expect(job).toContain("ec-cloud-kit.zip");
    expect(job).toContain("cloud-kit-manifest.json");
    expect(job).toContain('cloud.sourceRevision !== process.env.GITHUB_SHA');
    expect(job).toContain("embedded-images.tar");
    expect(job).toContain("provenance.archiveSha256");
    expect(job).toContain("cmp image-provenance.json embedded-image-provenance.json");
    expect(job).toContain("test -f ecommerce-workbench-v1.zip");
    expect(job).toContain("test -f ec-cloud-kit.zip");
    expect(job).toContain("cmp cloud-kit-manifest.json embedded-cloud-kit-manifest.json");
    expect(job).toContain('manifest.imageSource !== "prebuilt-archive"');
    expect(job).toContain("./scripts/verify-release.ps1");
    expect(job).toContain("Stage the seven verified public Release assets");
    expect(job).not.toContain("actions/upload-artifact@");
    expect(job).not.toContain("actions/download-artifact@");
    expect(job.indexOf("scripts/package-release.sh")).toBeLessThan(
      job.indexOf("./scripts/verify-release.ps1"),
    );
    expect(job.indexOf("./scripts/verify-release.ps1")).toBeLessThan(
      job.indexOf("Stage the seven verified public Release assets"),
    );
  });

  test("publishes immutable version tags and a visible public release only after smoke", () => {
    const publish = releaseJob("release");
    expect(publish).toContain("docker buildx imagetools create");
    expect(publish).toContain("docker buildx imagetools inspect --raw");
    expect(publish).toContain("--draft");
    expect(publish).toContain("RELEASE_ASSETS_JSON");
    expect(publish).toContain("releases?per_page=100");
    expect(publish).toContain(".tag_name == env.GITHUB_REF_NAME and .draft == true");
    expect(publish).toContain('export RELEASE_ASSETS_JSON="${release_assets_json}"');
    expect(publish).not.toContain('export RELEASE_ASSETS_JSON="$(gh api');
    expect(publish).not.toContain("/releases/tags/${GITHUB_REF_NAME}");
    expect(publish).toContain("--draft=false");
    expect(publish).toContain("--prerelease");
    expect(publish).not.toContain("--clobber");
    expect(publish.indexOf("./scripts/verify-release.ps1")).toBeLessThan(
      publish.indexOf("gh release create"),
    );
    expect(publish.indexOf("gh release upload")).toBeLessThan(
      publish.indexOf("RELEASE_ASSETS_JSON"),
    );
    expect(publish.indexOf("RELEASE_ASSETS_JSON")).toBeLessThan(
      publish.indexOf("docker buildx imagetools create"),
    );
    expect(publish.indexOf("docker buildx imagetools create")).toBeLessThan(
      publish.indexOf("gh release edit"),
    );
    expect(release).not.toContain("v0.1.0-internal");
  });
});
