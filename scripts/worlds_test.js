// Model-free tests for the multi-world store (v0.9.0 M1, plan D1/D2/D3):
// world-aware app_paths resolution, registry handling, and the legacy
// flat-save migration (backup, copy-verify-delete, commit via worlds.json).
// Each case runs in a fresh temp dir via LOCAL_AI_WRITABLE_CORE, so real
// session/world files are never touched.
//
// Usage: npm run worlds:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(
  path.join(os.tmpdir(), "tmixw-worlds-")
);

const {
  getActiveWorldDir,
  getEventsPath,
  getRecordingsDir,
  getSessionPath,
  getWorldStatePath,
  setActiveWorld
} = await import("../core/app_paths.js");
const {
  activateWorld,
  createWorld,
  deleteWorldToTrash,
  ensureWorldsLayout,
  getWorldDir,
  loadWorldMeta,
  loadWorldsRegistry,
  renameWorld,
  saveWorldsRegistry
} = await import("../core/worlds.js");
const { defaultWorldState, loadWorldState, saveWorldState, WORLD_STATE_SCHEMA_VERSION } =
  await import("../core/world_state.js");

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

/** Fresh writable core dir; clears any explicit/cached world resolution. */
function freshCoreDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-worlds-"));
  process.env.LOCAL_AI_WRITABLE_CORE = dir;
  setActiveWorld(null);
  return dir;
}

function writeLegacySave(dir, { name = "Kaela", session = true, vectors = true } = {}) {
  const ws = defaultWorldState();
  ws.character = { name };
  fs.writeFileSync(path.join(dir, "world_state.json"), JSON.stringify(ws, null, 2), "utf8");
  if (session) {
    fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ messages: [] }), "utf8");
  }
  if (vectors) {
    fs.writeFileSync(path.join(dir, "memory_vectors.json"), JSON.stringify({ beats: {} }), "utf8");
  }
  return ws;
}

await check("fresh install: ensureWorldsLayout creates and activates a blank world", () => {
  const dir = freshCoreDir();
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, false);
  assert.equal(boot.created, true);
  const reg = loadWorldsRegistry();
  assert.equal(reg.activeWorldId, boot.activeWorldId);
  assert.equal(reg.worlds.length, 1);
  assert.equal(reg.worlds[0].name, "My World");
  assert.ok(getWorldStatePath().startsWith(path.join(dir, "worlds")));
  const state = loadWorldState();
  assert.equal(state.schemaVersion, WORLD_STATE_SCHEMA_VERSION);
  const meta = loadWorldMeta(boot.activeWorldId);
  assert.equal(meta.id, boot.activeWorldId);
  assert.equal(meta.templateId, null);
});

await check("legacy migration: copy-verify-delete with backup, name from character", () => {
  const dir = freshCoreDir();
  writeLegacySave(dir);
  const legacyBytes = fs.readFileSync(path.join(dir, "world_state.json"));
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, true);
  assert.deepEqual(boot.movedFiles, ["world_state.json", "session.json", "memory_vectors.json"]);
  // backup created in the legacy dir
  assert.ok(boot.backupPath && fs.existsSync(boot.backupPath));
  assert.ok(path.basename(boot.backupPath).startsWith("world_state.backup-pre-worlds-"));
  // moved bytes identical; originals gone
  const worldDir = getWorldDir(boot.activeWorldId);
  assert.ok(legacyBytes.equals(fs.readFileSync(path.join(worldDir, "world_state.json"))));
  for (const f of ["world_state.json", "session.json", "memory_vectors.json"]) {
    assert.ok(!fs.existsSync(path.join(dir, f)), `${f} should be removed from legacy dir`);
  }
  // registered + named from character.name
  const reg = loadWorldsRegistry();
  assert.equal(reg.activeWorldId, boot.activeWorldId);
  assert.equal(reg.worlds[0].name, "Kaela");
  // state readable through the seam, content intact
  assert.equal(loadWorldState().character.name, "Kaela");
});

await check("legacy migration: world_state.json alone (no session/vectors)", () => {
  const dir = freshCoreDir();
  writeLegacySave(dir, { session: false, vectors: false });
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, true);
  assert.deepEqual(boot.movedFiles, ["world_state.json"]);
  assert.ok(!fs.existsSync(path.join(dir, "world_state.json")));
});

await check("crashed earlier attempt: worlds/ without registry is cleared and redone", () => {
  const dir = freshCoreDir();
  writeLegacySave(dir);
  const junk = path.join(dir, "worlds", "world_partial");
  fs.mkdirSync(junk, { recursive: true });
  fs.writeFileSync(path.join(junk, "world_state.json"), "{not json", "utf8");
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, true);
  assert.ok(!fs.existsSync(junk), "partial attempt should be cleared");
  assert.equal(loadWorldState().character.name, "Kaela");
});

await check("post-commit leftovers: registry wins, legacy file ignored and preserved", () => {
  const dir = freshCoreDir();
  writeLegacySave(dir);
  ensureWorldsLayout();
  // simulate crash between commit and delete: legacy file reappears
  fs.writeFileSync(path.join(dir, "world_state.json"), JSON.stringify({ leftover: true }), "utf8");
  setActiveWorld(null);
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, false);
  assert.ok(fs.existsSync(path.join(dir, "world_state.json")), "leftover must not be deleted");
  assert.equal(loadWorldState().character.name, "Kaela");
});

await check("registry repair: dangling activeWorldId falls back to an existing world", () => {
  freshCoreDir();
  ensureWorldsLayout();
  const meta = createWorld({ name: "Second" });
  const reg = loadWorldsRegistry();
  reg.activeWorldId = "world_does_not_exist";
  // strand the first world: drop its dir, keep the row
  fs.rmSync(getWorldDir(reg.worlds[0].id), { recursive: true, force: true });
  saveWorldsRegistry(reg);
  setActiveWorld(null);
  const boot = ensureWorldsLayout();
  assert.equal(boot.activeWorldId, meta.id);
  assert.equal(loadWorldsRegistry().activeWorldId, meta.id);
});

await check("registry repair: no surviving worlds creates a fresh one", () => {
  const dir = freshCoreDir();
  ensureWorldsLayout();
  fs.rmSync(path.join(dir, "worlds"), { recursive: true, force: true });
  setActiveWorld(null);
  const boot = ensureWorldsLayout();
  assert.ok(fs.existsSync(getWorldDir(boot.activeWorldId)));
  assert.equal(loadWorldsRegistry().activeWorldId, boot.activeWorldId);
});

await check("lazy resolution: registry drives CLI-style path lookups; no registry = flat layout", () => {
  const dir = freshCoreDir();
  const boot = ensureWorldsLayout();
  setActiveWorld(null); // simulate a fresh CLI process: no explicit world
  assert.equal(getActiveWorldDir(), getWorldDir(boot.activeWorldId));
  assert.ok(getSessionPath().startsWith(path.join(dir, "worlds")));
  const flat = freshCoreDir();
  assert.equal(getActiveWorldDir(), flat);
  assert.equal(getWorldStatePath(), path.join(flat, "world_state.json"));
});

await check("recordings/ and events.jsonl stay app-level after activation", () => {
  const dir = freshCoreDir();
  ensureWorldsLayout();
  assert.equal(getRecordingsDir(), path.join(dir, "recordings"));
  assert.equal(getEventsPath(), path.join(dir, "events.jsonl"));
});

await check("create + activate second world: paths move, no state bleed", () => {
  freshCoreDir();
  const boot = ensureWorldsLayout();
  const a = loadWorldState();
  a.character = { name: "Alpha" };
  saveWorldState(a);
  const metaB = createWorld({ name: "Beta World" });
  activateWorld(metaB.id);
  assert.equal(getActiveWorldDir(), getWorldDir(metaB.id));
  assert.equal(loadWorldState().character.name, undefined, "fresh world must not see Alpha");
  assert.ok(loadWorldMeta(metaB.id).lastPlayedAt, "activation stamps lastPlayedAt");
  activateWorld(boot.activeWorldId);
  assert.equal(loadWorldState().character.name, "Alpha");
});

await check("pre-v4 legacy save: moved verbatim, schema migration runs on first load in the world dir", () => {
  const dir = freshCoreDir();
  const oldState = {
    schemaVersion: 3,
    character: { name: "Old Timer" },
    npcs: [{ name: "Greybeard", status: "alive", notes: "" }],
    quests: [],
    locations: [],
    session_beats: ["a bare string beat"],
    scenes: [],
    chapters: [],
    lorebook: [],
    correction_history: [],
    current_location: "",
    pending_extractions: []
  };
  fs.writeFileSync(path.join(dir, "world_state.json"), JSON.stringify(oldState, null, 2), "utf8");
  const boot = ensureWorldsLayout();
  assert.equal(boot.migrated, true);
  const worldDir = getWorldDir(boot.activeWorldId);
  // moved verbatim: still v3 on disk
  const raw = JSON.parse(fs.readFileSync(path.join(worldDir, "world_state.json"), "utf8"));
  assert.equal(raw.schemaVersion, 3);
  // first load migrates in place and backs up inside the world dir
  const state = loadWorldState();
  assert.equal(state.schemaVersion, WORLD_STATE_SCHEMA_VERSION);
  assert.equal(state.npcs[0].name, "Greybeard");
  const backups = fs.readdirSync(worldDir).filter((f) => f.startsWith("world_state.backup-v3-"));
  assert.equal(backups.length, 1, "schema backup should land beside the world's state file");
});

await check("rename: world.json and registry row both update; bad input throws", () => {
  freshCoreDir();
  ensureWorldsLayout();
  const meta = createWorld({ name: "Before" });
  const renamed = renameWorld(meta.id, "  After  ");
  assert.equal(renamed.name, "After");
  assert.equal(loadWorldMeta(meta.id).name, "After");
  assert.equal(loadWorldsRegistry().worlds.find((w) => w.id === meta.id).name, "After");
  assert.throws(() => renameWorld(meta.id, "   "), /non-empty/);
  assert.throws(() => renameWorld("world_nope", "X"), /unknown/);
});

await check("delete: soft-deletes to worlds/.trash, refuses the active world", () => {
  const dir = freshCoreDir();
  const boot = ensureWorldsLayout();
  const victim = createWorld({ name: "Doomed" });
  // content must survive the trash move
  fs.writeFileSync(
    path.join(getWorldDir(victim.id), "world_state.json"),
    JSON.stringify({ marker: "doomed-state" }),
    "utf8"
  );
  assert.throws(() => deleteWorldToTrash(boot.activeWorldId), /active world/);
  const { trashedTo } = deleteWorldToTrash(victim.id);
  assert.ok(trashedTo.includes(path.join("worlds", ".trash")));
  assert.ok(!fs.existsSync(getWorldDir(victim.id)), "world dir should be gone");
  assert.ok(
    fs.readFileSync(path.join(trashedTo, "world_state.json"), "utf8").includes("doomed-state"),
    "trashed content must be recoverable"
  );
  assert.ok(!loadWorldsRegistry().worlds.some((w) => w.id === victim.id));
  assert.throws(() => deleteWorldToTrash(victim.id), /unknown/);
  // trash is invisible to the picker and to repair
  setActiveWorld(null);
  const boot2 = ensureWorldsLayout();
  assert.equal(boot2.activeWorldId, boot.activeWorldId);
});

console.log(failures === 0 ? "\nworlds:test ALL PASS" : `\nworlds:test FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
