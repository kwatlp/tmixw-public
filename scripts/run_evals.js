// Extractor eval harness (roadmap v4, v0.5.0 item 4): runs the
// `kind: "extraction-eval"` fixtures against a LIVE KoboldCPP backend using
// the exact extractor prompt + retry path the pipeline uses, then asserts
// declaratively over the model's diff (small-model output varies, so
// assertions check routing/shape, never exact-diff equality).
//
// This harness gates every future Extractor change (risk register: memory
// quality is downstream of extraction accuracy).
//
// Usage:
//   npm run evals:run            # run + rewrite fixtures/extractor/RESULTS.md
//   npm run evals:run -- --dry   # run, don't touch RESULTS.md
//
// Exit codes: 0 all pass · 1 assertion failures · 2 backend unreachable
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrateWorldState } from "../core/world_state.js";
import {
  resolvePipelineConfig,
  buildExtractorPrompt,
  runExtractorWithRetry
} from "../core/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const FIXTURES_DIR = path.join(ROOT, "fixtures", "extractor");
const RESULTS_PATH = path.join(FIXTURES_DIR, "RESULTS.md");

function loadText(p, fallback = "") {
  try {
    return fs.readFileSync(p, "utf8").trim() || fallback;
  } catch {
    return fallback;
  }
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "core", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve a fixture assertion path against { diff }. Segments:
 *   plain key            → object property
 *   [3]                  → array index
 *   [field=Value]        → first array element where String(el[field]) matches
 *                          Value case-insensitively
 * Returns { found, value }.
 */
function resolvePath(root, dotPath) {
  const segs = [];
  for (const part of String(dotPath).split(".")) {
    const m = part.match(/^([^[\]]*)((\[[^\]]+\])*)$/);
    if (!m) return { found: false, value: undefined };
    if (m[1]) segs.push({ key: m[1] });
    const brackets = m[2] ? m[2].match(/\[[^\]]+\]/g) ?? [] : [];
    for (const br of brackets) {
      const inner = br.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq >= 0) {
        segs.push({ field: inner.slice(0, eq), value: inner.slice(eq + 1) });
      } else {
        segs.push({ index: Number(inner) });
      }
    }
  }

  let cur = root;
  for (const seg of segs) {
    if (cur == null) return { found: false, value: undefined };
    if (seg.key !== undefined) {
      if (typeof cur !== "object" || !(seg.key in cur)) return { found: false, value: undefined };
      cur = cur[seg.key];
    } else if (seg.index !== undefined) {
      if (!Array.isArray(cur) || seg.index >= cur.length) return { found: false, value: undefined };
      cur = cur[seg.index];
    } else {
      if (!Array.isArray(cur)) return { found: false, value: undefined };
      const want = seg.value.toLowerCase();
      const hit = cur.find(
        (el) => String(el?.[seg.field] ?? "").trim().toLowerCase() === want
      );
      if (hit === undefined) return { found: false, value: undefined };
      cur = hit;
    }
  }
  return { found: true, value: cur };
}

/**
 * Assertion: { path, present? , absent?, equals?, matches? }.
 *   present: true → path must resolve
 *   absent: true  → path must NOT resolve
 *   equals        → strict-ish equality on String(value)
 *   matches       → case-insensitive regex on String(value)
 */
function runAssertion(diff, a, errors) {
  const { found, value } = resolvePath({ diff }, a.path);
  if (a.absent === true) {
    if (found) errors.push(`${a.path}: expected absent, found ${JSON.stringify(value)}`);
    return;
  }
  if (!found) {
    errors.push(`${a.path}: expected present, not found`);
    return;
  }
  if ("equals" in a) {
    if (String(value) !== String(a.equals)) {
      errors.push(`${a.path}: expected ${JSON.stringify(a.equals)}, got ${JSON.stringify(value)}`);
    }
  }
  if ("matches" in a) {
    const re = new RegExp(a.matches, "i");
    if (!re.test(String(value))) {
      errors.push(`${a.path}: ${JSON.stringify(value)} does not match /${a.matches}/i`);
    }
  }
}

// Backend access goes through the inference adapter (v0.8.0) so eval results
// reflect whatever backend the config selects, not KoboldCPP specifically.

function writeResults(rows, modelName, counts) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    "# Extractor eval results",
    "",
    "Latest local run of `npm run evals:run` (live model in the loop). This file is",
    "rewritten on every run — history lives in git.",
    "",
    `**Date:** ${date} · **Model:** \`${modelName}\` · **${counts.pass} pass / ${counts.fail} fail**`,
    "",
    "| fixture | status | detail |",
    "|---|---|---|"
  ];
  for (const r of rows) {
    const detail = r.errors.length
      ? r.errors.join("<br>").replace(/\|/g, "\\|")
      : "";
    lines.push(`| ${r.name} | ${r.status} | ${detail} |`);
  }
  fs.writeFileSync(RESULTS_PATH, lines.join("\n") + "\n", "utf8");
}

const dry = process.argv.includes("--dry");

const fileCfg = loadConfig();
const extractorSystem =
  (fileCfg.extractor?._systemPrompt ?? "").trim() ||
  loadText(
    path.join(ROOT, "prompts", "extractor_system.txt"),
    "You extract world state as JSON only."
  );
const cfg = resolvePipelineConfig(fileCfg, "", extractorSystem, "");

const { createInferenceAdapter } = await import("../core/inference/index.js");
const adapter = createInferenceAdapter(cfg.inference);
const healthCheck = await adapter.health();
if (!healthCheck.ok) {
  console.error(
    `Cannot reach the ${cfg.inference.backend} backend at ${cfg.inference.url}: ${healthCheck.error}\nStart it (with a model loaded) and re-run.`
  );
  process.exit(2);
}
const modelName = healthCheck.model || "unknown";
console.log(`Backend up — ${cfg.inference.backend}, model: ${modelName}\n`);

const files = fs
  .readdirSync(FIXTURES_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

const rows = [];
let pass = 0;
let fail = 0;

for (const file of files) {
  let fx;
  try {
    fx = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
  } catch {
    continue;
  }
  if (fx.kind !== "extraction-eval") continue;

  const world = JSON.parse(JSON.stringify(fx.world_before));
  if (typeof world.schemaVersion !== "number") world.schemaVersion = 1;
  migrateWorldState(world);

  // `fx.narrative` (D2, v0.6.0): the accepted narrator reply for the turn —
  // included in the extractor input exactly as the live acceptance path does.
  const prompt = buildExtractorPrompt(world, fx.transcript, cfg, fx.narrative ?? "");

  // Sampling variance (tech-debt session item 2): a fixture may declare
  // `samples: N` (clamped odd, default 1) and the majority verdict decides —
  // eval_quest_completion flakes ~50% on a byte-identical prompt, so a single
  // sample turns pre-existing sampling noise into a harness flake. Each
  // sample is a fresh generate + assertion run; the loop short-circuits once
  // either verdict has its majority.
  const declared = Math.max(1, Math.floor(Number(fx.samples ?? 1)) || 1);
  const samples = declared % 2 === 0 ? declared + 1 : declared;
  const majority = Math.floor(samples / 2) + 1;
  let passedSamples = 0;
  let failedSamples = 0;
  let errors = [];
  let lastFailDiff = null;
  while (passedSamples < majority && failedSamples < majority) {
    const sampleErrors = [];
    let ex;
    try {
      ex = await runExtractorWithRetry(prompt, cfg.extractor, cfg);
    } catch (e) {
      sampleErrors.push(`generate failed: ${e?.message ?? e}`);
      ex = { ok: false, diff: null, raw: "" };
    }

    if (!sampleErrors.length && (!ex.ok || !ex.diff)) {
      sampleErrors.push(`model did not return parseable JSON: ${String(ex.raw).slice(0, 200)}`);
    }
    if (!sampleErrors.length) {
      for (const a of fx.expect?.assertions ?? []) runAssertion(ex.diff, a, sampleErrors);
    }

    if (sampleErrors.length) {
      failedSamples++;
      errors = sampleErrors;
      lastFailDiff = ex?.diff ?? null;
    } else {
      passedSamples++;
    }
  }

  const ran = passedSamples + failedSamples;
  const tally = samples > 1 ? ` (${passedSamples}/${ran} samples)` : "";
  if (failedSamples >= majority) {
    fail++;
    rows.push({
      name: fx.name ?? file,
      status: `FAIL${tally}`,
      errors
    });
    console.error(`FAIL${tally} ${fx.name ?? file}`);
    for (const msg of errors) console.error(`  - ${msg}`);
    if (lastFailDiff) console.error(`  diff: ${JSON.stringify(lastFailDiff)}`);
  } else {
    pass++;
    rows.push({ name: fx.name ?? file, status: `PASS${tally}`, errors: [] });
    console.log(`PASS${tally} ${fx.name ?? file}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed (model: ${modelName})`);
if (!dry && rows.length) {
  writeResults(rows, modelName, { pass, fail });
  console.log(`Results table written to ${path.relative(ROOT, RESULTS_PATH)}`);
}
process.exit(fail > 0 ? 1 : 0);
