import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

// Resolve the actual Tailwind dependency chain, not a separately installed test copy.
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const tailwindRequire = createRequire(webRequire.resolve("tailwindcss"));
const micromatchRequire = createRequire(tailwindRequire.resolve("micromatch"));
const braces = micromatchRequire("braces");
const nested = (depth, open = "{", close = "}") => open.repeat(depth) + "a,b" + close.repeat(depth);
const depthError = (error) => error instanceof SyntaxError && /supported depth/.test(error.message);

test("normal Tailwind patterns and nested expansion keep their behavior", () => {
  assert.deepEqual(braces.expand("./src/**/*.{ts,tsx}"), ["./src/**/*.ts", "./src/**/*.tsx"]);
  assert.deepEqual(braces.expand("a/{b,{c,d}}/e"), ["a/b/e", "a/c/e", "a/d/e"]);
  assert.deepEqual(braces.expand("{1..3}"), ["1", "2", "3"]);
  assert.doesNotThrow(() => braces.compile(nested(100)));
});

test("deep brace, parenthesis, mixed and unclosed patterns fail before stack exhaustion", () => {
  for (const pattern of [nested(4500), nested(4500, "(", ")"),
    "{(".repeat(2000) + "a,b" + ")}".repeat(2000), "{".repeat(4500), nested(101)]) {
    // All malicious cases stay below the original 10,000-character input cap.
    assert.ok(pattern.length < 10000);
    for (const operation of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(pattern), depthError);
    }
  }
});

test("quoted and escaped delimiters are not mistaken for AST nesting", () => {
  assert.doesNotThrow(() => braces.compile('"' + "{".repeat(2000) + '"'));
  assert.doesNotThrow(() => braces.compile("\\{".repeat(2000)));
});

test("callers supplying an AST directly cannot bypass recursive walker limits", () => {
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    let ast = { type: "text", value: "x", nodes: [] };
    for (let i = 0; i < 500; i++) ast = { type: "root", nodes: [ast] };
    assert.throws(() => operation(ast), depthError);
  }
});

test("all Tailwind paths resolve to the protected braces implementation", () => {
  const chokidarRequire = createRequire(tailwindRequire.resolve("chokidar"));
  const globRequire = createRequire(tailwindRequire.resolve("fast-glob"));
  const globMicromatchRequire = createRequire(globRequire.resolve("micromatch"));
  for (const requireFrom of [micromatchRequire, chokidarRequire, globMicromatchRequire]) {
    assert.equal(requireFrom.resolve("braces"), micromatchRequire.resolve("braces"));
    assert.throws(() => requireFrom("braces")(nested(4500)), depthError);
  }
});
