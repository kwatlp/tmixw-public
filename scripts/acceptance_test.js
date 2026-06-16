// Model-free tests for the acceptance pipeline (v0.6.0 M1, plan D1-D3).
// Generation is stubbed at `pipeline._generate`; the memory tick is spied
// (its internals are covered by memory_test.js). Each pipeline gets a fresh
// temp dir via LOCAL_AI_WRITABLE_CORE, so real session/world files are never
// touched. Retrieval and lorebook vectors are disabled — no embeddings model.
//
// Usage: npm run acceptance:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Must be set before app_paths is exercised; refreshed per pipeline below.
process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(
  path.join(os.tmpdir(), "tmixw-accept-")
);

const { createPipeline, resolvePipelineConfig } = await import(
  "../core/pipeline.js"
);
const { LENGTH_PRESETS, deriveCeiling, LENGTH_HEADROOM, LENGTH_CEILING_MAX } =
  await import("../core/length_presets.js");

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

const EXTRACTOR_MARKER = "Return ONLY the JSON object.";

/**
 * Fresh pipeline in a fresh writable dir.
 * `narrativeReplies`: queue of narrator stub outputs (last repeats).
 * `extractorDiff`: object the extractor stub returns as JSON, or an array
 * used as a queue (last repeats) — mirrors `narrativeReplies`.
 */
function makePipeline({ fileCfg = {}, narrativeReplies = ["A reply."], extractorDiff = { npcs: [] } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-accept-"));
  process.env.LOCAL_AI_WRITABLE_CORE = dir;

  const merged = {
    stdinPtt: false,
    context: { retrievalMaxEntries: 0 },
    lorebook: { vectorEnabled: false },
    memory: { autoSummarize: false },
    ...fileCfg,
    // template pinned to plain and streaming off: keeps tests deterministic
    // (no /api/v1/model detection fetch, no SSE attempt against a possibly
    // live local KoboldCPP). Streaming tests opt in with stream: true and a
    // stubbed _generateStream.
    narrative: { acceptGraceMs: 0, template: "plain", stream: false, ...(fileCfg.narrative ?? {}) }
  };
  const cfg = resolvePipelineConfig(merged, "NARRATIVE SYSTEM", "EXTRACTOR SYSTEM", "");
  const pl = createPipeline(cfg);

  const calls = { narrative: [], extractor: [] };
  let replyIdx = 0;
  let diffIdx = 0;
  pl._generate = async (prompt) => {
    if (prompt.includes(EXTRACTOR_MARKER)) {
      calls.extractor.push(prompt);
      const diffs = Array.isArray(extractorDiff) ? extractorDiff : [extractorDiff];
      const d = diffs[Math.min(diffIdx, diffs.length - 1)];
      diffIdx++;
      return JSON.stringify(d);
    }
    calls.narrative.push(prompt);
    const i = Math.min(replyIdx, narrativeReplies.length - 1);
    replyIdx++;
    return narrativeReplies[i];
  };

  // Hermeticity: the default koboldcpp adapter offers real tokenization, and
  // context assembly would fetch counts from a possibly live local KoboldCPP.
  // Force the chars/4 fallback so results never depend on the environment.
  pl._countTokensCached = null;

  const memoryTicks = [];
  pl._memoryTick = (prev, diff) => memoryTicks.push({ prev, diff });

  const events = [];
  for (const ev of ["narrative", "narrative:token", "narrative:pending", "narrative:accepted", "narrative:updated", "extractor:ok", "extractor:skip", "world:staleExtraction", "error"]) {
    pl.on(ev, (p) => events.push({ ev, ...p }));
  }

  pl.start();
  return { pl, calls, memoryTicks, events, dir };
}

async function runTurn(pl, text) {
  pl.submitText(text);
  await pl._gate;
}

function sessionMessages(pl) {
  return pl.session.messages.map((m) => ({ role: m.role, content: m.content }));
}

// --- D1: pending state ------------------------------------------------------

await check("pending: response is parked, not committed; no extraction yet", async () => {
  const { pl, calls, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } }
  });
  await runTurn(pl, "I open the door.");

  assert.deepEqual(sessionMessages(pl), [
    { role: "user", content: "I open the door." }
  ]);
  assert.equal(calls.extractor.length, 0, "extractor must not run before acceptance");
  assert.ok(events.find((e) => e.ev === "narrative"), "narrative emitted");
  const pending = events.find((e) => e.ev === "narrative:pending");
  assert.ok(pending, "narrative:pending emitted");
  assert.equal(pending.mode, "new");
  assert.equal(pl.getPendingState().pending.text, "A reply.");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null; // drop pending so stop() doesn't commit it
  pl.stop();
});

await check("accept (explicit): commits message, extractor sees transcript + narrative (D2), memory tick fires, event logged", async () => {
  const { pl, calls, memoryTicks, dir } = makePipeline({
    // includeNarrative explicit (not relying on the default) so this test is
    // green on both sides of the D2 default flip.
    fileCfg: { narrative: { acceptGraceMs: 60_000 }, extractor: { includeNarrative: true } },
    narrativeReplies: ["The barkeep Mira waves you over."],
    extractorDiff: { npcs: [{ name: "Mira", status: "alive" }], session_beat: "Met Mira." }
  });
  await runTurn(pl, "I enter the tavern.");

  const r = pl.acceptPending();
  assert.equal(r.ok, true);
  await pl._postAcceptPromise;

  assert.deepEqual(sessionMessages(pl), [
    { role: "user", content: "I enter the tavern." },
    { role: "assistant", content: "The barkeep Mira waves you over." }
  ]);
  assert.equal(calls.extractor.length, 1);
  assert.ok(calls.extractor[0].includes("User said (this turn): I enter the tavern."));
  assert.ok(
    calls.extractor[0].includes("Narrator replied (this turn): The barkeep Mira waves you over."),
    "extractor prompt must include the accepted narrator reply (D2)"
  );
  assert.equal(pl.worldState.npcs[0]?.name, "Mira");
  assert.equal(memoryTicks.length, 1, "memory tick fires on acceptance");
  const eventsLog = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim();
  assert.ok(eventsLog.includes("Met Mira") || eventsLog.includes("barkeep"), "events.jsonl appended");
  pl.stop();
});

await check("D2 escape hatch: extractor.includeNarrative=false omits the reply", async () => {
  const { pl, calls } = makePipeline({
    fileCfg: {
      narrative: { acceptGraceMs: 60_000 },
      extractor: { includeNarrative: false }
    }
  });
  await runTurn(pl, "Hello.");
  pl.acceptPending();
  await pl._postAcceptPromise;
  assert.ok(!calls.extractor[0].includes("Narrator replied"), "no narrative block when disabled");
  pl.stop();
});

await check("auto-accept: grace timer commits without player action", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 40 } }
  });
  await runTurn(pl, "I wait.");
  assert.equal(sessionMessages(pl).length, 1, "still pending right after the turn");
  await new Promise((r) => setTimeout(r, 150));
  await pl._postAcceptPromise;
  const accepted = events.find((e) => e.ev === "narrative:accepted");
  assert.ok(accepted, "narrative:accepted emitted");
  assert.equal(accepted.reason, "auto");
  assert.equal(sessionMessages(pl).length, 2);
  pl.stop();
});

await check("acceptGraceMs 0: commits immediately (pre-v0.6.0 feel)", async () => {
  const { pl, events } = makePipeline();
  await runTurn(pl, "Hi.");
  await pl._postAcceptPromise;
  assert.equal(sessionMessages(pl).length, 2);
  assert.equal(events.find((e) => e.ev === "narrative:accepted")?.reason, "auto");
  pl.stop();
});

await check("next-send: sending a new message accepts the previous pending first", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } },
    narrativeReplies: ["First reply.", "Second reply."]
  });
  await runTurn(pl, "First.");
  await runTurn(pl, "Second.");
  await pl._postAcceptPromise;

  const msgs = sessionMessages(pl);
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["user", "assistant", "user"],
    "previous reply committed before the new user message"
  );
  assert.equal(msgs[1].content, "First reply.");
  assert.equal(events.find((e) => e.ev === "narrative:accepted")?.reason, "next-send");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("stop(): pending response is committed, not lost", async () => {
  const { pl } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } }
  });
  await runTurn(pl, "Onward.");
  pl.stop();
  assert.equal(sessionMessages(pl).length, 2, "stop commits the pending reply");
  await pl._postAcceptPromise;
});

// --- D3: per-response controls ----------------------------------------------

await check("regenerate: discards pending; only the final accepted text is extracted", async () => {
  const { pl, calls, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 }, extractor: { includeNarrative: true } },
    narrativeReplies: ["Draft one.", "Draft two."]
  });
  await runTurn(pl, "Go.");
  pl.regenerateLast();
  await pl._gate;

  assert.equal(pl.getPendingState().pending.text, "Draft two.");
  assert.equal(events.find((e) => e.ev === "narrative:updated")?.mode, "regenerate");
  assert.equal(calls.extractor.length, 0, "discarded draft never extracted");

  pl.acceptPending();
  await pl._postAcceptPromise;
  assert.equal(calls.extractor.length, 1);
  assert.ok(calls.extractor[0].includes("Draft two."), "extractor sees the accepted text only");
  assert.ok(!calls.extractor[0].includes("Draft one."));
  assert.equal(sessionMessages(pl)[1].content, "Draft two.");
  pl.stop();
});

await check("continue: extends the pending text in place", async () => {
  const { pl, calls } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } },
    narrativeReplies: ["The hall is dark.", "A torch gutters in the distance."]
  });
  await runTurn(pl, "I look around.");
  pl.continueLast();
  await pl._gate;

  assert.equal(
    pl.getPendingState().pending.text,
    "The hall is dark. A torch gutters in the distance."
  );
  // Continue-mode prompt is seeded with the existing response after "Assistant:".
  const continuePrompt = calls.narrative[1];
  assert.ok(continuePrompt.endsWith("Assistant: The hall is dark."));
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("rewrite: one-shot directive lands in the system block, not in later turns", async () => {
  const { pl, calls } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } },
    narrativeReplies: ["Plain.", "With more dialogue.", "Next turn."]
  });
  await runTurn(pl, "Speak.");
  pl.rewriteLast("more dialogue");
  await pl._gate;

  assert.equal(pl.getPendingState().pending.text, "With more dialogue.");
  assert.ok(
    calls.narrative[1].includes("Style note for this response only: more dialogue"),
    "rewrite directive injected"
  );

  await runTurn(pl, "And then?");
  assert.ok(
    !calls.narrative[2].includes("Style note for this response only"),
    "directive is one-shot"
  );
  await pl._postAcceptPromise;
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("regenerate after acceptance: un-commits the last assistant message", async () => {
  const { pl } = makePipeline({
    narrativeReplies: ["Old reply.", "New reply."]
  });
  await runTurn(pl, "Go."); // graceMs 0 → accepted immediately
  await pl._postAcceptPromise;
  assert.equal(sessionMessages(pl)[1].content, "Old reply.");

  pl.regenerateLast();
  await pl._gate;
  await pl._postAcceptPromise; // graceMs 0 → new pending accepted immediately

  const msgs = sessionMessages(pl);
  assert.equal(msgs.length, 2, "old assistant message replaced, not duplicated");
  assert.equal(msgs[1].content, "New reply.");
  pl.stop();
});

// --- tech-debt session item 3: extraction revert on regenerate-after-grace ---

await check("regenerate after acceptance: reverts the prior turn's extraction when safe", async () => {
  const { pl, events } = makePipeline({
    narrativeReplies: ["Old reply.", "New reply."],
    extractorDiff: [{ npcs: [{ name: "Mira", status: "alive" }] }, {}]
  });
  await runTurn(pl, "Go."); // graceMs 0 → accepted immediately
  await pl._postAcceptPromise;
  assert.ok(
    pl.worldState.npcs.some((n) => n.name === "Mira"),
    "first extraction applied"
  );

  pl.regenerateLast();
  await pl._gate;
  await pl._postAcceptPromise;

  assert.ok(
    !pl.worldState.npcs.some((n) => n.name === "Mira"),
    "stale extraction reverted"
  );
  assert.ok(!events.find((e) => e.ev === "world:staleExtraction"), "clean revert, no flag");
  assert.equal(sessionMessages(pl)[1].content, "New reply.");
  pl.stop();
});

await check("extraction revert drops the turn's lore entries too", async () => {
  const { pl } = makePipeline({
    narrativeReplies: ["Old reply.", "New reply."],
    extractorDiff: [
      { lorebook: [{ title: "The Heron Order", content: "A quiet sect.", keywords: ["heron"] }] },
      {}
    ]
  });
  await runTurn(pl, "Go.");
  await pl._postAcceptPromise;
  const heron = pl.worldState.lorebook.find((e) => e.title === "The Heron Order");
  assert.ok(heron, "lore entry applied directly (no review queue)");
  assert.equal(
    pl.worldState.codex.prov[heron.id]?.content,
    "ai",
    "AI provenance stamped"
  );
  assert.ok(pl.worldState.codex.isNew[heron.id], "new entry flagged as draft");

  pl.regenerateLast();
  await pl._gate;
  await pl._postAcceptPromise;

  assert.ok(
    !pl.worldState.lorebook.some((e) => e.title === "The Heron Order"),
    "lore entry reverted with the diff"
  );
  pl.stop();
});

await check("regenerate after a later world write: no revert, staleness flagged", async () => {
  const { pl, events } = makePipeline({
    narrativeReplies: ["Old reply.", "New reply."],
    extractorDiff: [{ npcs: [{ name: "Mira", status: "alive" }] }, {}]
  });
  await runTurn(pl, "Go.");
  await pl._postAcceptPromise;

  // Any write between acceptance and regenerate (lore review, corrections,
  // memory edits, a persisted memory tick) breaks byte-equality.
  pl.worldState.npcs.push({ name: "Intruder", status: "alive" });

  pl.regenerateLast();
  await pl._gate;
  await pl._postAcceptPromise;

  assert.ok(
    pl.worldState.npcs.some((n) => n.name === "Mira"),
    "no revert: extracted NPC survives"
  );
  assert.ok(
    pl.worldState.npcs.some((n) => n.name === "Intruder"),
    "no revert: intervening write survives"
  );
  const flag = events.find((e) => e.ev === "world:staleExtraction");
  assert.ok(flag, "staleness flagged");
  assert.equal(flag.reason, "world-changed");
  pl.stop();
});

await check("controls no-op when there is nothing to operate on", async () => {
  const { pl, events } = makePipeline();
  pl.regenerateLast();
  await pl._gate;
  assert.equal(events.length, 0);
  assert.equal(sessionMessages(pl).length, 0);
  pl.stop();
});

await check("generation failure during regenerate restores the previous response as pending", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000 } },
    narrativeReplies: ["Good draft."]
  });
  await runTurn(pl, "Go.");
  const realGen = pl._generate;
  pl._generate = async (prompt) => {
    if (!prompt.includes(EXTRACTOR_MARKER)) throw new Error("backend down");
    return realGen(prompt);
  };
  pl.regenerateLast();
  await pl._gate;

  assert.equal(pl.getPendingState().pending.text, "Good draft.");
  assert.equal(pl.getPendingState().pending.mode, "restored");
  assert.ok(events.find((e) => e.ev === "error"));
  pl._generate = realGen;
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

// --- v0.7.0 M1: token streaming over the pending state -----------------------

await check("streaming: tokens emit progressively; pending parks the final text only", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } }
  });
  pl._generateStream = async (prompt, gen, cfg, onText) => {
    onText("The door");
    onText("The door creaks");
    onText("The door creaks open.");
    return "The door creaks open.";
  };
  await runTurn(pl, "I push the door.");

  const tokens = events.filter((e) => e.ev === "narrative:token").map((e) => e.text);
  assert.deepEqual(tokens, ["The door", "The door creaks", "The door creaks open."]);
  assert.equal(pl.getPendingState().pending.text, "The door creaks open.");
  assert.equal(sessionMessages(pl).length, 1, "nothing committed until acceptance");
  // Final narrative event still fires with the full text (renderer replaces).
  assert.equal(events.find((e) => e.ev === "narrative")?.text, "The door creaks open.");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("streaming: transport failure falls back to non-streaming silently", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } },
    narrativeReplies: ["Fallback reply."]
  });
  pl._generateStream = async () => {
    throw new Error("SSE refused");
  };
  await runTurn(pl, "Hello.");

  assert.equal(events.filter((e) => e.ev === "narrative:token").length, 0);
  assert.equal(pl.getPendingState().pending.text, "Fallback reply.");
  assert.ok(!events.find((e) => e.ev === "error"), "fallback is silent");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("streaming continue: token events carry the existing response as prefix", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } }
  });
  pl._generateStream = async (prompt, gen, cfg, onText) => {
    onText("First.");
    return "First.";
  };
  await runTurn(pl, "Go.");
  pl._generateStream = async (prompt, gen, cfg, onText) => {
    onText("And then");
    onText("And then more.");
    return "And then more.";
  };
  pl.continueLast();
  await pl._gate;

  const tokens = events.filter((e) => e.ev === "narrative:token").map((e) => e.text);
  assert.deepEqual(tokens.slice(-2), ["First. And then", "First. And then more."]);
  assert.equal(pl.getPendingState().pending.text, "First. And then more.");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("streaming: empty stream result retries non-streaming (immediate-EOS guard)", async () => {
  const { pl } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } },
    narrativeReplies: ["Recovered reply."]
  });
  pl._generateStream = async () => "";
  await runTurn(pl, "Hello.");
  assert.equal(pl.getPendingState().pending.text, "Recovered reply.");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

// --- message-fin meta (doc 03) ----------------------------------------------

await check("fin meta: finishReason length → truncated true on narrative + pending", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } }
  });
  pl._generateStream = async (prompt, gen, cfg, onText, onDone) => {
    onText("A short reply.");
    onDone({ finishReason: "length" });
    return "A short reply.";
  };
  await runTurn(pl, "Tell me a long story.");

  const narr = events.find((e) => e.ev === "narrative");
  const pending = events.find((e) => e.ev === "narrative:pending");
  assert.equal(narr.meta.finishReason, "length");
  assert.equal(narr.meta.truncated, true, "length reason ⇒ truncated");
  assert.equal(pending.meta.truncated, true, "meta rides the pending event too");
  assert.equal(pl._pending.meta.finishReason, "length", "parked on the pending object");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("fin meta: finishReason stop → complete (not truncated)", async () => {
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: true } }
  });
  pl._generateStream = async (prompt, gen, cfg, onText, onDone) => {
    onText("A complete thought.");
    onDone({ finishReason: "stop" });
    return "A complete thought.";
  };
  await runTurn(pl, "Hi.");
  const narr = events.find((e) => e.ev === "narrative");
  assert.equal(narr.meta.finishReason, "stop");
  assert.equal(narr.meta.truncated, false);
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("fin meta: no reason + reply pegs the budget → truncated via heuristic", async () => {
  // brief preset ceiling = target 120 × 1.6 headroom = 192 tokens (doc 06);
  // ~800 chars ≈ 200 tokens (chars/4) clears 0.98×192 ≈ 188.
  const { pl, events } = makePipeline({
    fileCfg: { narrative: { acceptGraceMs: 60_000, stream: false, lengthPreset: "brief" } },
    narrativeReplies: ["x".repeat(800)]
  });
  await runTurn(pl, "Ramble.");
  const narr = events.find((e) => e.ev === "narrative");
  assert.equal(narr.meta.finishReason, "unknown", "non-stream has no adapter reason");
  assert.equal(narr.meta.truncated, true, "token-budget heuristic fires");
  assert.equal(narr.meta.lengthPreset, "brief");
  pl._pending.timer && clearTimeout(pl._pending.timer);
  pl._pending = null;
  pl.stop();
});

await check("stopGeneration: no-op when nothing is streaming", async () => {
  const { pl } = makePipeline();
  assert.deepEqual(pl.stopGeneration(), { ok: false });
  pl.stop();
});

// --- tech-debt session item 5: stop while the extractor holds the slot -------

/**
 * Shared setup: turn 1's extraction parks on a gate (it "holds the slot"),
 * turn 2's narration stream parks on another gate (so _streamActive is true),
 * and the adapter is faked with the given abortScope + an abort spy.
 */
async function makeStopDuringExtraction(abortScope) {
  const { pl } = makePipeline({
    fileCfg: { narrative: { stream: true } } // acceptGraceMs stays 0
  });
  let releaseExtraction;
  const extractionGate = new Promise((r) => (releaseExtraction = r));
  pl._generate = async (prompt) => {
    if (prompt.includes(EXTRACTOR_MARKER)) {
      await extractionGate;
      return JSON.stringify({ npcs: [{ name: "Mira", status: "alive" }] });
    }
    return "A reply.";
  };
  pl._generateStream = async () => "First reply.";
  await runTurn(pl, "Go."); // accepted immediately; extraction now in flight

  let streamStartedResolve;
  const streamStarted = new Promise((r) => (streamStartedResolve = r));
  let releaseStream;
  const streamGate = new Promise((r) => (releaseStream = r));
  pl._generateStream = async () => {
    streamStartedResolve();
    await streamGate;
    return "Second reply.";
  };
  const aborts = { count: 0 };
  pl.inference = { abortScope, abort: async () => aborts.count++ };

  pl.submitText("And then?"); // not awaited — narration must be in flight
  await streamStarted;
  return { pl, aborts, releaseExtraction, releaseStream };
}

await check("stopGeneration: global abort defers until the in-flight extraction lands", async () => {
  const { pl, aborts, releaseExtraction, releaseStream } = await makeStopDuringExtraction("global");

  assert.deepEqual(pl.stopGeneration(), { ok: true, deferred: true });
  assert.equal(aborts.count, 0, "abort must not hit the extraction holding the slot");

  releaseExtraction();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(aborts.count, 1, "abort fires once the slot frees");

  releaseStream();
  await pl._gate;
  await pl._postAcceptPromise;
  assert.ok(
    pl.worldState.npcs.some((n) => n.name === "Mira"),
    "extraction completed despite the stop"
  );
  pl.stop();
});

await check("stopGeneration: stream-scoped abort fires immediately during extraction", async () => {
  const { pl, aborts, releaseExtraction, releaseStream } = await makeStopDuringExtraction("stream");

  assert.deepEqual(pl.stopGeneration(), { ok: true });
  assert.equal(aborts.count, 1, "stream-scoped abort cannot hit a background generate");

  releaseExtraction();
  releaseStream();
  await pl._gate;
  await pl._postAcceptPromise;
  pl.stop();
});

// --- Story-template onboarding (v0.9.0 D5) ----------------------------------

await check("first-turn directive: in the first narrator prompt, gone once a reply is committed", async () => {
  const { pl, calls } = makePipeline({
    fileCfg: {
      narrative: { acceptGraceMs: 0, template: "plain", stream: false },
      narrativeFirstTurnDirective: "RUN THE CHARACTER FORGE NOW."
    }
  });
  await runTurn(pl, "I enter the chapterhouse.");
  assert.ok(
    calls.narrative[0].includes("RUN THE CHARACTER FORGE NOW."),
    "directive must reach the first prompt's system block"
  );
  await pl._postAcceptPromise;
  await runTurn(pl, "I look at the quest board.");
  assert.equal(calls.narrative.length, 2);
  assert.ok(
    !calls.narrative[1].includes("RUN THE CHARACTER FORGE NOW."),
    "directive is one-shot — never after the first committed reply"
  );
  pl.stop();
});

// --- design doc 06: length as a soft target (target vs derived ceiling) ---

const resolveLen = (narrative) =>
  resolvePipelineConfig({ narrative }, "NARRATIVE SYSTEM", "EXTRACTOR SYSTEM", "");

await check("doc06: preset max_length is a derived ceiling = target × headroom", async () => {
  for (const [id, p] of Object.entries(LENGTH_PRESETS)) {
    const cfg = resolveLen({ lengthPreset: id });
    const expected = Math.round(p.target * LENGTH_HEADROOM);
    assert.equal(cfg.narrative.max_length, expected, `${id} ceiling`);
    assert.equal(cfg.narrativeLengthCeiling, expected, `${id} surfaced ceiling`);
    assert.equal(cfg.narrativeLengthTarget, p.target, `${id} surfaced target`);
    assert.ok(
      cfg.narrative.max_length > p.target,
      `${id}: ceiling must exceed the target (headroom > 1), so the cap is a backstop`
    );
  }
});

await check("doc06: every preset directive says resolve/yield + shorter-is-fine, never antiEos", async () => {
  for (const id of Object.keys(LENGTH_PRESETS)) {
    const cfg = resolveLen({ lengthPreset: id });
    const d = cfg.narrativeLengthDirective;
    assert.match(d, /resolve the beat and yield/i, `${id} resolve/yield clause`);
    assert.match(d, /shorter is fine/i, `${id} shorter-is-fine clause`);
    assert.ok(!("antiEos" in cfg.narrative), `${id} must not set antiEos`);
  }
});

await check("doc06: custom preserves the slider value as the literal ceiling + nudges", async () => {
  const cfg = resolveLen({ lengthPreset: "custom", max_length: 333 });
  assert.equal(cfg.narrative.max_length, 333, "custom keeps the slider ceiling");
  assert.equal(cfg.narrativeLengthTarget, null, "custom has no fixed target");
  assert.equal(cfg.narrativeLengthCeiling, 333);
  assert.match(cfg.narrativeLengthDirective, /resolve the beat and yield/i, "custom still nudges");
});

await check("doc06: unknown preset falls back to standard; deriveCeiling clamps", async () => {
  const cfg = resolveLen({ lengthPreset: "wat" });
  assert.equal(cfg.narrativeLengthPreset, "standard");
  assert.equal(cfg.narrative.max_length, Math.round(LENGTH_PRESETS.standard.target * LENGTH_HEADROOM));
  assert.equal(deriveCeiling(0), LENGTH_CEILING_MAX, "non-positive target → max clamp, never zero");
  assert.equal(deriveCeiling(NaN), LENGTH_CEILING_MAX, "non-finite target → max clamp");
});

console.log(failures > 0 ? `\n${failures} failure(s)` : "\nAll acceptance tests passed");
process.exit(failures > 0 ? 1 : 0);
