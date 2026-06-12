// Live end-to-end smoke for the v0.5.0 memory path: real KoboldCPP turns →
// beats → scene boundary → background summarizer → embedding refresh →
// retrieval visible in the context report. Uses an isolated writable core dir
// (never touches your real world_state.json / session.json).
//
// Usage: node scripts/memory_smoke_live.js   (KoboldCPP must be running)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// Isolate BEFORE importing app_paths consumers.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-memsmoke-"));
process.env.LOCAL_AI_WRITABLE_CORE = tmp;
console.log(`[smoke] writable core: ${tmp}`);

const { resolvePipelineConfig, createPipeline } = await import("../core/pipeline.js");
const { loadWorldState } = await import("../core/world_state.js");

const fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "core", "config.json"), "utf8"));
const narrativeSystem = fs.readFileSync(path.join(ROOT, "prompts", "narrative_system.txt"), "utf8").trim();
const extractorSystem = fs.readFileSync(path.join(ROOT, "prompts", "extractor_system.txt"), "utf8").trim();

const cfg = resolvePipelineConfig(
  { ...fileCfg, stdinPtt: false, memory: { sceneBeatThreshold: 2 } },
  narrativeSystem,
  extractorSystem,
  ""
);

const pipeline = createPipeline(cfg);

const turns = [
  "I am Kael, a ranger. I walk into the village forge and greet Mara the blacksmith.",
  "I ask Mara about the strange lights over the cliffs, then head out the door toward the cliff path."
];

let turnResolve;
pipeline.on("narrative", ({ text }) => {
  console.log(`\n[narrative] ${text.slice(0, 140).replace(/\n/g, " ")}…`);
});
pipeline.on("extractor:ok", () => {
  console.log("[extractor] ok");
  turnResolve?.();
});
pipeline.on("extractor:skip", ({ raw }) => {
  console.log(`[extractor] SKIP (unparseable): ${String(raw).slice(0, 120)}`);
  turnResolve?.();
});
pipeline.on("memory:scene", (p) => console.log(`[memory] scene rolled up: ${p.sceneId} (${p.reason})`));
pipeline.on("memory:error", (p) => console.log(`[memory] ERROR: ${p?.error?.message ?? p?.error}`));
pipeline.on("error", (p) => console.log(`[pipeline error] (${p.phase}) ${p?.error?.message ?? p?.error}`));

pipeline.start();

for (const t of turns) {
  console.log(`\n=== TURN: ${t}`);
  const done = new Promise((res) => (turnResolve = res));
  pipeline.submitText(t);
  await done;
}

// Wait for the background memory tick (boundary + summarizer + vectors).
const waitUntil = async (label, fn, timeoutMs = 240000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`[smoke] TIMEOUT waiting for: ${label}`);
  return false;
};

let ws = () => loadWorldState();
await waitUntil("scene roll-up", () => ws().scenes.length > 0);
await waitUntil("scene summary fill", () => ws().scenes.some((s) => s.summary));
await waitUntil(
  "memory vectors file",
  () => fs.existsSync(path.join(tmp, "memory_vectors.json"))
);

const final = ws();
console.log("\n=== RESULT ===");
console.log(`beats: ${final.session_beats.length}`);
for (const b of final.session_beats) {
  console.log(`  - [${b.sceneId ?? "unassigned"}] ${b.text}`);
}
console.log(`scenes: ${final.scenes.length}`);
for (const s of final.scenes) {
  console.log(`  - ${s.id} stale=${s.stale} summary: ${s.summary || "(none)"}`);
}
console.log(`chapters: ${final.chapters.length}`);
for (const c of final.chapters) {
  console.log(`  - ${c.id} "${c.title}" summary: ${c.summary || "(none)"}`);
}
let vectorCount = 0;
try {
  const store = JSON.parse(fs.readFileSync(path.join(tmp, "memory_vectors.json"), "utf8"));
  vectorCount = Object.keys(store.vectors).length;
} catch {
  // counted as 0
}
console.log(`memory vectors: ${vectorCount}`);

// One more turn so the context report includes memory sections.
{
  const done = new Promise((res) => (turnResolve = res));
  pipeline.submitText("I pause at the cliff path and think back on everything that led me here.");
  await done;
}
const report = pipeline.getLastContextReport();
console.log("\n=== CONTEXT REPORT (last turn) ===");
for (const s of report.sections) {
  console.log(
    `  ${s.label.padEnd(10)} chars=${String(s.chars).padEnd(6)} ~tok=${String(s.estTokens).padEnd(5)}` +
      (s.count != null ? ` items=${s.count}` : "") +
      (s.dropped ? ` dropped=${s.dropped}` : "")
  );
}
console.log(`  total ${report.totalChars} chars (~${report.totalEstTokens} tokens)`);

pipeline.stop();
const ok =
  final.scenes.length > 0 &&
  final.scenes.some((s) => s.summary) &&
  vectorCount > 0;
console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
process.exit(ok ? 0 : 1);
