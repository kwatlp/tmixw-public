// Fixture runner for extractor regression cases (roadmap v4, v0.4.0 item 1).
// `diff-apply` and `migrate` fixtures run here; `extraction-eval` fixtures are
// data-only inputs for the v0.5.0 eval harness and are skipped with a count.
//
// Usage: npm run fixtures:test
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyExtractorDiff, migrateWorldState } from "../core/world_state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures", "extractor");

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

/**
 * Assert every key/element in `expected` exists and matches in `actual`.
 * Objects match as subsets; arrays must match length and per-index.
 * Collects human-readable mismatch messages into `errors`.
 */
function subsetMatch(actual, expected, at, errors) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      errors.push(`${at}: expected array, got ${typeof actual}`);
      return;
    }
    if (actual.length !== expected.length) {
      errors.push(`${at}: expected ${expected.length} items, got ${actual.length}`);
      return;
    }
    expected.forEach((e, i) => subsetMatch(actual[i], e, `${at}[${i}]`, errors));
    return;
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      errors.push(`${at}: expected object, got ${JSON.stringify(actual)}`);
      return;
    }
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) {
        errors.push(`${at}.${key}: missing`);
        continue;
      }
      subsetMatch(actual[key], expected[key], `${at}.${key}`, errors);
    }
    return;
  }
  if (actual !== expected) {
    errors.push(`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Dot-path (numeric segments index arrays) that must NOT resolve to an existing key. */
function assertAbsent(root, dotPath, errors) {
  const parts = dotPath.split(".");
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null || typeof cur !== "object") return; // path broken earlier — absent
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (cur != null && typeof cur === "object" && last in cur) {
    errors.push(`absent check failed: ${dotPath} exists (${JSON.stringify(cur[last])})`);
  }
}

function checkExpectations(world, expect, errors) {
  if (expect?.world_after) subsetMatch(world, expect.world_after, "world", errors);
  for (const p of expect?.absent ?? []) assertAbsent(world, p, errors);
}

function runFixture(fx) {
  const errors = [];
  if (fx.kind === "diff-apply") {
    const world = deepClone(fx.world_before);
    applyExtractorDiff(world, fx.diff);
    checkExpectations(world, fx.expect, errors);
  } else if (fx.kind === "migrate") {
    const world = deepClone(fx.world_before);
    migrateWorldState(world);
    checkExpectations(world, fx.expect, errors);
    // Idempotency: a second run must change nothing.
    const snapshot = JSON.stringify(world);
    const changedAgain = migrateWorldState(world);
    if (changedAgain) errors.push("idempotency: second migrateWorldState run reported changes");
    if (JSON.stringify(world) !== snapshot) errors.push("idempotency: second run mutated state");
  } else {
    return { status: "skip" };
  }
  return errors.length ? { status: "fail", errors } : { status: "pass" };
}

const files = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

let pass = 0;
let fail = 0;
let skip = 0;

for (const file of files) {
  let fx;
  try {
    fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
  } catch (e) {
    fail++;
    console.error(`FAIL ${file}: invalid JSON (${e.message})`);
    continue;
  }
  const res = runFixture(fx);
  if (res.status === "pass") {
    pass++;
    console.log(`PASS ${fx.name ?? file}`);
  } else if (res.status === "skip") {
    skip++;
    console.log(`SKIP ${fx.name ?? file} (kind: ${fx.kind})`);
  } else {
    fail++;
    console.error(`FAIL ${fx.name ?? file}`);
    for (const msg of res.errors) console.error(`  - ${msg}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped (eval-only)`);
process.exit(fail > 0 ? 1 : 0);
