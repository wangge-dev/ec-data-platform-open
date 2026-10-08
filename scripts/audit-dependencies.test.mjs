import assert from "node:assert/strict";
import { test } from "node:test";
import { assessAudit } from "./audit-dependencies.mjs";

function response(changes = {}) {
  return { metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    advisories: { 1: { github_advisory_id: "GHSA-vfj7-8cjw-p6xm", module_name: "braces", severity: "high",
      findings: [{ version: "3.0.3", paths: ["apps/web > tailwindcss@3.4.19 > micromatch@4.0.8 > braces@3.0.3"] }],
      ...changes } } };
}

test("one declared build advisory is recognized only after live patch proof", () => {
  assert.equal(assessAudit(response(), { patchVerified: true }).mitigated.length, 1);
  assert.equal(assessAudit(response()).blocked.length, 1);
  assert.equal(assessAudit(response(), { production: true, patchVerified: true }).blocked.length, 1);
});

test("new advisories, versions, modules or dependency paths cannot inherit the exception", () => {
  for (const changes of [{ github_advisory_id: "GHSA-new-finding" }, { module_name: "axios" },
    { findings: [{ version: "3.0.2", paths: ["apps/web > tailwindcss@3.4.19 > braces@3.0.2"] }] },
    { findings: [{ version: "3.0.3", paths: ["apps/api > braces@3.0.3"] }] },
    { findings: [] }]) {
    assert.equal(assessAudit(response(changes), { patchVerified: true }).blocked.length, 1);
  }
});

test("scanner errors, incomplete responses and unknown severities fail closed", () => {
  for (const audit of [{}, { error: "registry unavailable" },
    { ...response(), advisories: {} }, response({ severity: "unknown" }),
    { advisories: {}, metadata: { vulnerabilities: {} } },
    { advisories: {}, metadata: { vulnerabilities: { high: "unavailable" } } }]) {
    assert.throws(() => assessAudit(audit, { patchVerified: true }));
  }
});

test("a clean scan passes without inventing mitigated findings", () => {
  assert.deepEqual(assessAudit({ advisories: {}, metadata: { vulnerabilities: { high: 0, moderate: 0 } } }).blocked, []);
});
