// Model-free tests for the budgeted narrator context assembler (v0.5.0 item 3).
// Embeddings are stubbed: vectors are hand-built so cosine similarity is
// deterministic. The lorebook path runs keyword-only (no stored embeddings).
//
// Usage: npm run context:test
import assert from "node:assert/strict";
import { defaultWorldState, appendSessionBeat } from "../core/world_state.js";
import { endScene, setPinned } from "../core/memory.js";
import {
  assembleNarrativeContext,
  buildContextRuntimeConfig,
  estimateTokens,
  retrieveMemories
} from "../core/context.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

// 64-dim stub vectors (embeddings.js requires >= 32 dims).
function vec(primary) {
  const v = new Array(64).fill(0);
  v[primary] = 1;
  return v;
}

function makeCfg(overrides = {}) {
  return {
    narrativeSystem: "SYSTEM PROMPT",
    narrativeLengthDirective: "LENGTH DIRECTIVE",
    maxContextMessages: 4,
    lorebook: {
      maxEntries: 5,
      maxInjectChars: 3500,
      maxMatchMessages: null,
      vectorSimilarityThreshold: 0.35,
      vectorEnabled: false
    },
    context: buildContextRuntimeConfig({ context: overrides.context ?? {} })
  };
}

function makeWorld() {
  const ws = defaultWorldState();
  appendSessionBeat(ws, "Kael met the harbormaster.");
  appendSessionBeat(ws, "Kael was given a sealed letter.");
  const scene = endScene(ws, "The Harbor");
  scene.summary = "Kael arrived at the harbor and received a sealed letter.";
  ws.chapters[0].summary = "Kael's journey began at the harbor.";
  appendSessionBeat(ws, "Kael set out on the north road.");
  return ws;
}

const session = {
  messages: [
    { role: "user", content: "I open the letter." },
    { role: "assistant", content: "The wax seal cracks." },
    { role: "user", content: "I read it aloud." }
  ]
};

await check("estimateTokens is chars/4 rounded up", () => {
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
  assert.equal(estimateTokens(""), 0);
});

await check("prompt order: system, chapters, world, history, Assistant:", async () => {
  const ws = makeWorld();
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: null,
    embedQuery: async () => null
  });
  const idx = (s) => prompt.indexOf(s);
  assert.ok(idx("SYSTEM PROMPT") === 0);
  assert.ok(idx("LENGTH DIRECTIVE") > 0);
  assert.ok(idx("[Story so far]") > idx("LENGTH DIRECTIVE"));
  assert.ok(idx("Kael's journey began") > idx("[Story so far]"));
  assert.ok(idx("[World snapshot]") > idx("[Story so far]"));
  assert.ok(idx("User: I open the letter.") > idx("[World snapshot]"));
  assert.ok(prompt.trimEnd().endsWith("Assistant:"));
  assert.equal(report.totalChars, prompt.length);
  const labels = report.sections.map((s) => s.label);
  assert.deepEqual(labels, ["system", "pinned", "chapters", "lorebook", "retrieval", "world", "history"]);
});

await check("pinned entries always appear, ahead of chapters", async () => {
  const ws = makeWorld();
  setPinned(ws, "beat", ws.session_beats[0].id, true);
  const { prompt } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: null,
    embedQuery: async () => null
  });
  const pinnedIdx = prompt.indexOf("[Pinned memories]");
  assert.ok(pinnedIdx > 0);
  assert.ok(prompt.indexOf("Kael met the harbormaster.") > pinnedIdx);
  assert.ok(pinnedIdx < prompt.indexOf("[Story so far]"));
});

await check("retrieval: cosine match over beats and scenes, pinned excluded", async () => {
  const ws = makeWorld();
  const beatId = ws.session_beats[1].id; // sealed letter beat
  const sceneId = ws.scenes[0].id;
  const otherId = ws.session_beats[2].id;
  const store = {
    version: 1,
    vectors: {
      [beatId]: { h: "x", v: vec(0) },
      [sceneId]: { h: "x", v: vec(0) },
      [otherId]: { h: "x", v: vec(1) } // orthogonal — below threshold
    }
  };
  const matches = retrieveMemories(ws, store, vec(0), makeCfg().context);
  const ids = matches.map((m) => m.entry.id).sort();
  assert.deepEqual(ids, [beatId, sceneId].sort());

  // pinned beat is excluded from retrieval
  setPinned(ws, "beat", beatId, true);
  const after = retrieveMemories(ws, store, vec(0), makeCfg().context);
  assert.ok(!after.some((m) => m.entry.id === beatId));
});

await check("retrieval block lands in prompt with report scores", async () => {
  const ws = makeWorld();
  const beatId = ws.session_beats[1].id;
  const store = { version: 1, vectors: { [beatId]: { h: "x", v: vec(0) } } };
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: store,
    embedQuery: async () => vec(0)
  });
  assert.ok(prompt.includes("[Recalled story events]"));
  assert.ok(prompt.includes("Kael was given a sealed letter."));
  const r = report.sections.find((s) => s.label === "retrieval");
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].id, beatId);
  assert.ok(r.matches[0].score > 0.99);
});

await check("memory budget: zero budget drops pinned/chapters/retrieval, never history", async () => {
  const ws = makeWorld();
  setPinned(ws, "beat", ws.session_beats[0].id, true);
  const cfg = makeCfg({ context: { memoryMaxChars: 0 } });
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null
  });
  assert.ok(!prompt.includes("[Pinned memories]"));
  assert.ok(!prompt.includes("[Story so far]"));
  assert.ok(prompt.includes("User: I open the letter."));
  const pinnedSec = report.sections.find((s) => s.label === "pinned");
  assert.equal(pinnedSec.dropped, 1);
});

await check("budget spends on pinned before chapters (priority order)", async () => {
  const ws = makeWorld();
  setPinned(ws, "scene", ws.scenes[0].id, true);
  // Budget fits the pinned scene line but not also the chapter line.
  const pinnedLineLen = ("- The Harbor: " + ws.scenes[0].summary).length + 1;
  const cfg = makeCfg({ context: { memoryMaxChars: pinnedLineLen + 4 } });
  const { prompt } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null
  });
  assert.ok(prompt.includes("[Pinned memories]"));
  assert.ok(!prompt.includes("[Story so far]"));
});

await check("style directives (D4) land in the system block after the length directive", async () => {
  const ws = makeWorld();
  const { buildStyleDirectives, normalizeStyle } = await import("../core/style_presets.js");
  const style = normalizeStyle({ tone: "grim", tense: "past", notes: "lots of dialogue" });
  const cfg = { ...makeCfg(), narrativeStyleDirectives: buildStyleDirectives(style) };
  const { prompt } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null
  });
  const idx = (s) => prompt.indexOf(s);
  assert.ok(idx("Tone: grim") > idx("LENGTH DIRECTIVE"));
  assert.ok(idx("Tense: narrate in the past tense.") > idx("Tone: grim"));
  assert.ok(idx("Style notes from the player: lots of dialogue") > idx("Tense:"));
  assert.ok(idx("[Story so far]") > idx("Style notes from the player:"));
});

await check("default style + no extras: prompt byte-identical to a cfg without the fields", async () => {
  const ws = makeWorld();
  const { buildStyleDirectives, normalizeStyle } = await import("../core/style_presets.js");
  const base = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: null,
    embedQuery: async () => null
  });
  const withDefaults = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: { ...makeCfg(), narrativeStyleDirectives: buildStyleDirectives(normalizeStyle({})) },
    vectorStore: null,
    embedQuery: async () => null,
    extraDirective: ""
  });
  assert.equal(withDefaults.prompt, base.prompt);
});

await check("extraDirective (rewrite one-shot) appends to the system block", async () => {
  const ws = makeWorld();
  const { prompt } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: null,
    embedQuery: async () => null,
    extraDirective: "Style note for this response only: slower"
  });
  const idx = (s) => prompt.indexOf(s);
  assert.ok(idx("Style note for this response only: slower") > idx("LENGTH DIRECTIVE"));
  assert.ok(idx("[Story so far]") > idx("Style note for this response only"));
});

await check("embed failure degrades silently (no retrieval, prompt still builds)", async () => {
  const ws = makeWorld();
  const store = { version: 1, vectors: {} };
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg: makeCfg(),
    vectorStore: store,
    embedQuery: async () => {
      throw new Error("backend down");
    }
  });
  assert.ok(prompt.includes("[World snapshot]"));
  const r = report.sections.find((s) => s.label === "retrieval");
  assert.equal(r.count, 0);
});

await check("real token counter: budget drops use real counts; report carries tokens", async () => {
  const ws = makeWorld();
  setPinned(ws, "scene", ws.scenes[0].id, true);
  const pinnedLineLen = ("- The Harbor: " + ws.scenes[0].summary).length + 1;
  const cfg = makeCfg({ context: { memoryMaxChars: pinnedLineLen + 4 } });
  // Counter at chars/2 — twice the chars/4 estimate, so a line that fits the
  // char-era budget no longer fits the token budget (memoryMaxChars/4).
  const countTokens = async (t) => Math.ceil(String(t).length / 2);
  const base = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null
  });
  assert.ok(base.prompt.includes("[Pinned memories]"), "fits under the char budget");
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null,
    countTokens
  });
  assert.ok(!prompt.includes("[Pinned memories]"), "dropped under the real count");
  const pinnedSec = report.sections.find((s) => s.label === "pinned");
  assert.equal(pinnedSec.dropped, 1);
  const sys = report.sections.find((s) => s.label === "system");
  assert.equal(sys.tokens, Math.ceil(sys.chars / 2));
  assert.equal(report.totalTokens, Math.ceil(prompt.length / 2));
});

await check("counter unavailable (null or throwing): byte-identical chars/4 fallback", async () => {
  const ws = makeWorld();
  setPinned(ws, "beat", ws.session_beats[0].id, true);
  const cfg = makeCfg();
  const base = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null
  });
  const nulled = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null,
    countTokens: async () => null
  });
  assert.equal(nulled.prompt, base.prompt);
  assert.equal(nulled.report.totalTokens, undefined);
  assert.ok(nulled.report.sections.every((s) => s.tokens === undefined));
  const throwing = await assembleNarrativeContext({
    session,
    worldState: ws,
    cfg,
    vectorStore: null,
    embedQuery: async () => null,
    countTokens: async () => {
      throw new Error("backend down");
    }
  });
  assert.equal(throwing.prompt, base.prompt);
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll context tests passed");
process.exit(failures ? 1 : 0);
