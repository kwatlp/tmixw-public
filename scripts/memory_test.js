// Model-free tests for the hierarchical story memory (v0.5.0 item 1).
// Summarization runs against a stub `generate`; embeddings are not exercised
// here (regenerable cache, exercised in the live app).
//
// Usage: npm run memory:test
import assert from "node:assert/strict";
import { defaultWorldState, appendSessionBeat } from "../core/world_state.js";
import {
  buildMemoryRuntimeConfig,
  detectSceneBoundary,
  endScene,
  startChapter,
  editBeat,
  deleteBeat,
  deleteScene,
  deleteChapter,
  editSceneSummary,
  setPinned,
  unassignedBeats,
  runSummarization
} from "../core/memory.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

function worldWithBeats(n) {
  const ws = defaultWorldState();
  for (let i = 0; i < n; i++) appendSessionBeat(ws, `Beat number ${i + 1}.`);
  return ws;
}

const memCfg = buildMemoryRuntimeConfig({ memory: { sceneBeatThreshold: 3 } });

check("boundary: none under threshold, no location change", () => {
  const ws = worldWithBeats(2);
  assert.equal(detectSceneBoundary(ws, { npcs: [] }, memCfg, new Set()), null);
});

check("boundary: beat threshold fires", () => {
  const ws = worldWithBeats(3);
  assert.equal(detectSceneBoundary(ws, null, memCfg, new Set()), "beat-threshold");
});

check("boundary: new location fires, known location does not", () => {
  const ws = worldWithBeats(1);
  const diff = { locations: [{ name: "The Sunken Vault" }] };
  assert.equal(
    detectSceneBoundary(ws, diff, memCfg, new Set(["harborton"])),
    "location-change"
  );
  assert.equal(
    detectSceneBoundary(ws, diff, memCfg, new Set(["the sunken vault"])),
    null
  );
});

check("boundary: never fires with zero unassigned beats", () => {
  const ws = defaultWorldState();
  const diff = { locations: [{ name: "Somewhere New" }] };
  assert.equal(detectSceneBoundary(ws, diff, memCfg, new Set()), null);
});

check("endScene rolls up beats, creates Chapter 1, assigns sceneId", () => {
  const ws = worldWithBeats(3);
  const scene = endScene(ws, "Arrival");
  assert.ok(scene);
  assert.equal(ws.chapters.length, 1);
  assert.equal(ws.chapters[0].title, "Chapter 1");
  assert.equal(scene.parentId, ws.chapters[0].id);
  assert.equal(scene.beatIds.length, 3);
  assert.equal(unassignedBeats(ws).length, 0);
  assert.ok(ws.session_beats.every((b) => b.sceneId === scene.id));
  assert.equal(endScene(ws), null, "no beats left → no scene");
});

check("startChapter: later scenes land in the new chapter", () => {
  const ws = worldWithBeats(2);
  endScene(ws);
  const ch2 = startChapter(ws, "Into the Hills");
  appendSessionBeat(ws, "A new journey begins.");
  const scene2 = endScene(ws);
  assert.equal(scene2.parentId, ch2.id);
});

check("editBeat flags parent scene+chapter stale only when summarized", () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  // unsummarized: no stale flag needed
  editBeat(ws, scene.beatIds[0], "Edited text.");
  assert.equal(scene.stale, false);
  scene.summary = "A summary.";
  ws.chapters[0].summary = "Chapter summary.";
  editBeat(ws, scene.beatIds[0], "Edited again.");
  assert.equal(scene.stale, true);
  assert.equal(ws.chapters[0].stale, true);
  assert.equal(ws.session_beats[0].text, "Edited again.");
});

check("deleteBeat removes from scene.beatIds and flags stale", () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  scene.summary = "A summary.";
  const doomed = scene.beatIds[0];
  assert.equal(deleteBeat(ws, doomed), true);
  assert.equal(ws.session_beats.length, 1);
  assert.ok(!scene.beatIds.includes(doomed));
  assert.equal(scene.stale, true);
});

check("deleteScene removes its beats; deleteChapter cascades", () => {
  const ws = worldWithBeats(2);
  const scene1 = endScene(ws);
  appendSessionBeat(ws, "Another beat.");
  const scene2 = endScene(ws);
  assert.equal(deleteScene(ws, scene1.id), true);
  assert.equal(ws.scenes.length, 1);
  assert.equal(ws.session_beats.length, 1);
  assert.equal(ws.session_beats[0].sceneId, scene2.id);
  assert.equal(deleteChapter(ws, ws.chapters[0].id), true);
  assert.equal(ws.scenes.length, 0);
  assert.equal(ws.session_beats.length, 0);
});

check("deleting a chapter's last scene clears its summary (nothing left to describe)", () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  ws.chapters[0].summary = "Chapter summary.";
  assert.equal(deleteScene(ws, scene.id), true);
  assert.equal(ws.chapters[0].summary, "");
  assert.equal(ws.chapters[0].stale, false);
});

check("deleting one of several scenes keeps chapter summary, flags stale", () => {
  const ws = worldWithBeats(2);
  const scene1 = endScene(ws);
  appendSessionBeat(ws, "Another beat.");
  endScene(ws);
  ws.chapters[0].summary = "Chapter summary.";
  assert.equal(deleteScene(ws, scene1.id), true);
  assert.equal(ws.chapters[0].summary, "Chapter summary.");
  assert.equal(ws.chapters[0].stale, true);
});

check("setPinned works across kinds", () => {
  const ws = worldWithBeats(1);
  const beatId = ws.session_beats[0].id;
  const scene = endScene(ws);
  assert.equal(setPinned(ws, "beat", beatId, true), true);
  assert.equal(setPinned(ws, "scene", scene.id, true), true);
  assert.equal(setPinned(ws, "chapter", ws.chapters[0].id, true), true);
  assert.equal(ws.session_beats[0].pinned, true);
  assert.equal(setPinned(ws, "scene", "nope", true), false);
});

const stubGenerate = async (prompt) =>
  prompt.includes("Chapter summary:") ? "STUB CHAPTER SUMMARY" : "STUB SCENE SUMMARY";

await checkAsync("auto summarization fills empty summaries only", async () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  const done = await runSummarization(ws, stubGenerate);
  assert.deepEqual(done.scenes, [scene.id]);
  assert.equal(scene.summary, "STUB SCENE SUMMARY");
  assert.equal(ws.chapters[0].summary, "STUB CHAPTER SUMMARY");
  // second auto pass: nothing to do
  const again = await runSummarization(ws, stubGenerate);
  assert.deepEqual(again, { scenes: [], chapters: [] });
});

await checkAsync("auto pass never rewrites stale or edited summaries", async () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  await runSummarization(ws, stubGenerate);
  editSceneSummary(ws, scene.id, "PLAYER SUMMARY");
  scene.stale = true; // simulate a later beat edit
  const done = await runSummarization(ws, stubGenerate);
  assert.deepEqual(done.scenes, []);
  assert.equal(scene.summary, "PLAYER SUMMARY");
});

await checkAsync("forced regenerate targets explicit ids, even edited ones", async () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  await runSummarization(ws, stubGenerate);
  editSceneSummary(ws, scene.id, "PLAYER SUMMARY");
  // forced without filter: edited summary survives
  await runSummarization(ws, stubGenerate, { force: true });
  assert.equal(scene.summary, "PLAYER SUMMARY");
  // forced WITH the id: rewritten, edited flag cleared
  await runSummarization(ws, stubGenerate, { force: true, sceneIds: [scene.id] });
  assert.equal(scene.summary, "STUB SCENE SUMMARY");
  assert.equal(scene.edited, false);
});

await checkAsync("forced scene regenerate cascades to its (unedited) chapter in the same run", async () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  await runSummarization(ws, stubGenerate);
  const done = await runSummarization(ws, stubGenerate, { force: true, sceneIds: [scene.id] });
  assert.deepEqual(done.chapters, [ws.chapters[0].id]);
  assert.equal(ws.chapters[0].stale, false);
});

await checkAsync("forced scene regenerate leaves an edited chapter stale, not rewritten", async () => {
  const ws = worldWithBeats(2);
  const scene = endScene(ws);
  await runSummarization(ws, stubGenerate);
  ws.chapters[0].summary = "PLAYER CHAPTER";
  ws.chapters[0].edited = true;
  const done = await runSummarization(ws, stubGenerate, { force: true, sceneIds: [scene.id] });
  assert.deepEqual(done.chapters, []);
  assert.equal(ws.chapters[0].summary, "PLAYER CHAPTER");
  assert.equal(ws.chapters[0].stale, true);
});

await checkAsync("explicit regenerate of a sceneless chapter clears stale leftovers", async () => {
  const ws = worldWithBeats(2);
  endScene(ws);
  await runSummarization(ws, stubGenerate);
  // simulate a pre-fix world: scene gone but chapter summary/stale left behind
  ws.scenes = [];
  ws.chapters[0].stale = true;
  const chId = ws.chapters[0].id;
  const done = await runSummarization(ws, stubGenerate, { force: true, chapterIds: [chId] });
  assert.deepEqual(done.chapters, [chId]);
  assert.equal(ws.chapters[0].summary, "");
  assert.equal(ws.chapters[0].stale, false);
  // auto pass still ignores sceneless chapters
  const again = await runSummarization(ws, stubGenerate);
  assert.deepEqual(again, { scenes: [], chapters: [] });
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll memory tests passed");
process.exit(failures ? 1 : 0);
