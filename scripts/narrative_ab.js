// Narrator prompt A/B harness (roadmap v4, v0.6.0 item 1; plan D6).
// Runs the fixed scenario set in fixtures/narrative/scenarios.json against a
// LIVE KoboldCPP backend twice per scenario — once with the OLD narrator
// system prompt, once with the NEW — through the exact assembler + template
// path live turns use, and dumps a side-by-side markdown for human judgment.
//
// Blind by default: responses are labeled A/B with a per-scenario shuffle;
// the answer key is at the bottom of the file. Judge first, then scroll.
//
// Usage:
//   npm run narrative:ab                  # old = HEAD prompts/narrative_system.txt,
//                                         # new = working-tree prompts/narrative_system.txt
//   npm run narrative:ab -- --old <file> --new <file>
//   npm run narrative:ab -- --rev v0.5.0  # old = that rev's prompt file
//   npm run narrative:ab -- --samples 2   # N seeded samples per scenario/variant
//                                         # (one sample is noisy at temp 0.8)
//   npm run narrative:ab -- --only consequence_recall   # single-scenario spot check
//
// Output: fixtures/narrative/AB_RESULTS.md (rewritten each run; history in git)
// Exit codes: 0 ran · 2 backend unreachable or prompts identical
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolvePipelineConfig } from "../core/pipeline.js";
import { assembleNarrativeContext } from "../core/context.js";
import { detectTemplateFromModelName } from "../core/templates.js";
import { defaultWorldState } from "../core/world_state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const SCENARIOS_PATH = path.join(ROOT, "fixtures", "narrative", "scenarios.json");
const RESULTS_PATH = path.join(ROOT, "fixtures", "narrative", "AB_RESULTS.md");
const PROMPT_REL = "prompts/narrative_system.txt";

function arg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function gitShow(rev, relPath) {
  const r = spawnSync("git", ["show", `${rev}:${relPath.replace(/\\/g, "/")}`], {
    cwd: ROOT,
    encoding: "utf8"
  });
  if (r.status !== 0) {
    throw new Error(`git show ${rev}:${relPath} failed: ${(r.stderr || "").trim()}`);
  }
  return r.stdout;
}

function loadPrompts() {
  const oldArg = arg("old");
  const newArg = arg("new");
  const rev = arg("rev", "HEAD");
  const oldText = oldArg
    ? fs.readFileSync(path.resolve(ROOT, oldArg), "utf8").trim()
    : gitShow(rev, PROMPT_REL).trim();
  const newText = newArg
    ? fs.readFileSync(path.resolve(ROOT, newArg), "utf8").trim()
    : fs.readFileSync(path.join(ROOT, PROMPT_REL), "utf8").trim();
  return { oldText, newText, oldLabel: oldArg || `${rev}:${PROMPT_REL}`, newLabel: newArg || PROMPT_REL };
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "core", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

/** Deterministic per-scenario seed so OLD/NEW face the same sampling noise. */
function seedFor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 1_000_000;
}

function scenarioWorld(sc) {
  const ws = defaultWorldState();
  Object.assign(ws.character, sc.world.character ?? {});
  ws.npcs = sc.world.npcs ?? [];
  ws.quests = sc.world.quests ?? [];
  ws.locations = sc.world.locations ?? [];
  if (sc.chapterSummary) {
    ws.chapters = [
      { id: "ab-ch1", title: "Chapter 1", summary: sc.chapterSummary, pinned: false, stale: false }
    ];
  }
  return ws;
}

// Generation goes through the inference adapter (v0.8.0); seeded sampling
// rides the gen params (the KoboldCPP adapter maps sampler_seed).
import { createInferenceAdapter } from "../core/inference/index.js";

function generate(adapter, prompt, gen, seed) {
  return adapter.generate(prompt, { ...gen, sampler_seed: seed });
}

const { oldText, newText, oldLabel, newLabel } = loadPrompts();
if (oldText === newText) {
  console.error(
    "OLD and NEW prompts are identical — edit prompts/narrative_system.txt (or pass --old/--new) first."
  );
  process.exit(2);
}

const fileCfg = loadConfig();
const probeCfg = resolvePipelineConfig(fileCfg, "", "", "");
const adapter = createInferenceAdapter(probeCfg.inference);
const healthCheck = await adapter.health();
if (!healthCheck.ok) {
  console.error(
    `Cannot reach the ${probeCfg.inference.backend} backend at ${probeCfg.inference.url}: ${healthCheck.error}`
  );
  process.exit(2);
}
const modelName = healthCheck.model || "unknown";
const template = detectTemplateFromModelName(modelName);
console.log(`Backend up — ${probeCfg.inference.backend}, model: ${modelName} (template: ${template})`);
console.log(`OLD: ${oldLabel}\nNEW: ${newLabel}\n`);

const all = JSON.parse(fs.readFileSync(SCENARIOS_PATH, "utf8")).scenarios;
const only = arg("only");
const scenarios = only ? all.filter((s) => s.name === only) : all;
if (scenarios.length === 0) {
  console.error(`No scenario named "${only}" in fixtures/narrative/scenarios.json`);
  process.exit(2);
}
const samples = Math.max(1, Math.min(5, Number(arg("samples", "1")) || 1));
const variants = [
  { id: "OLD", system: oldText },
  { id: "NEW", system: newText }
];

const out = [
  "# Narrator prompt A/B results",
  "",
  "Generated by `npm run narrative:ab`. Rewritten every run — history lives in git.",
  "Responses are shuffled per scenario; **judge before reading the answer key at the bottom.**",
  "",
  `**Model:** \`${modelName}\` · **Template:** ${template} · **Date:** ${new Date().toISOString().slice(0, 10)}`,
  `**OLD:** ${oldLabel} · **NEW:** ${newLabel}`,
  ""
];
const key = [];

for (const sc of scenarios) {
  console.log(`scenario: ${sc.name}`);
  const ws = scenarioWorld(sc);
  const session = { messages: [...sc.history, { role: "user", content: sc.transcript }] };
  const seed = seedFor(sc.name);

  // Per-scenario blind shuffle (deterministic from the seed); same A/B
  // assignment across all samples of a scenario.
  const flipped = seed % 2 === 1;
  const [firstV, secondV] = flipped ? [variants[1], variants[0]] : [variants[0], variants[1]];
  key.push(`- ${sc.name}: A = ${firstV.id}, B = ${secondV.id}`);

  out.push(`## ${sc.name}`, "", `*Tests: ${sc.tests}*`, "");
  for (const m of sc.history) {
    out.push(`> **${m.role === "user" ? "Player" : "Narrator"}:** ${m.content}`);
  }
  out.push(`> **Player:** ${sc.transcript}`, "");

  for (let s = 0; s < samples; s++) {
    const sampleSeed = seed + s * 7919;
    for (const v of [firstV, secondV]) {
      const label = v === firstV ? "A" : "B";
      const cfg = resolvePipelineConfig(fileCfg, v.system, "", "");
      const { prompt, stopSequences } = await assembleNarrativeContext({
        session,
        worldState: ws,
        cfg,
        vectorStore: null,
        embedQuery: async () => null,
        template
      });
      const gen = stopSequences
        ? { ...cfg.narrative, stop_sequence: stopSequences }
        : cfg.narrative;
      const text = await generate(adapter, prompt, gen, sampleSeed);
      out.push(
        `### Response ${label}${samples > 1 ? ` (sample ${s + 1})` : ""}`,
        "",
        text || "*(empty)*",
        ""
      );
    }
  }
}

out.push("---", "", "## Answer key (judge first!)", "", ...key, "");
// --only spot checks get their own file so they never clobber the judged
// full-run record.
const resultsPath = only
  ? RESULTS_PATH.replace(/\.md$/, `.${only}.md`)
  : RESULTS_PATH;
fs.writeFileSync(resultsPath, out.join("\n") + "\n", "utf8");
console.log(`\nWrote ${path.relative(ROOT, resultsPath)}`);
