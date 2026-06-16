// Model-free tests for the story-template loader (v0.9.0 M4, plan D5):
// manifest validation (kept in lockstep with templates/manifest.schema.json —
// the authoring source of truth), discovery, apply-at-creation, GM bestiary
// separation, and the narrator-only GM context block. Temp dirs via
// LOCAL_AI_WRITABLE_CORE; the bundled Solterra template is the live fixture.
//
// Usage: npm run story_templates:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(
  path.join(os.tmpdir(), "tmixw-stpl-")
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");

const {
  applyTemplate,
  discoverTemplates,
  GM_BESTIARY_FILENAME,
  loadGmBestiary,
  validateManifest
} = await import("../core/story_templates.js");
const { assembleNarrativeContext, buildContextRuntimeConfig } = await import(
  "../core/context.js"
);
const { loadWorldState, WORLD_STATE_SCHEMA_VERSION } = await import(
  "../core/world_state.js"
);
const { setActiveWorld } = await import("../core/app_paths.js");

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

const SOLTERRA_DIR = path.join(REPO, "templates", "solterra-guildblade");
const solterraManifest = () =>
  JSON.parse(fs.readFileSync(path.join(SOLTERRA_DIR, "template.json"), "utf8"));
const schema = JSON.parse(
  fs.readFileSync(path.join(REPO, "templates", "manifest.schema.json"), "utf8")
);

function freshCoreDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-stpl-"));
  process.env.LOCAL_AI_WRITABLE_CORE = dir;
  setActiveWorld(null);
  return dir;
}

await check("Solterra manifest validates", () => {
  const v = validateManifest(solterraManifest());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

await check("schema parity: every JSON-Schema-required field is enforced by the validator", () => {
  // The schema file is the authoring source of truth; this guards against
  // the hand-rolled validator drifting looser than it (plan risk #5).
  for (const field of schema.required) {
    const m = solterraManifest();
    delete m[field];
    assert.equal(
      validateManifest(m).ok,
      false,
      `dropping required "${field}" should fail validation`
    );
  }
  for (const field of schema.properties.narrator.required) {
    const m = solterraManifest();
    delete m.narrator[field];
    assert.equal(
      validateManifest(m).ok,
      false,
      `dropping required narrator.${field} should fail validation`
    );
  }
});

await check("validator: type and shape violations are reported", () => {
  const bad = solterraManifest();
  bad.schemaVersion = 2;
  bad.id = "Has Spaces";
  bad.narrator.promptMode = "replace";
  bad.seed.session_beats = [{ not: "a string" }];
  bad.seed.npcs = [{ status: "no name" }];
  const v = validateManifest(bad);
  assert.equal(v.ok, false);
  assert.ok(v.errors.length >= 5, `expected >=5 errors, got: ${v.errors.join(" | ")}`);
});

await check("discovery: bundled Solterra found; user-installed template wins on id collision", () => {
  const dir = freshCoreDir();
  let found = discoverTemplates();
  const solterra = found.find((t) => t.id === "solterra-guildblade");
  assert.ok(solterra, "bundled solterra-guildblade not discovered");
  assert.equal(solterra.name, "Solterra: Guildblade");
  // user override: same id under <writableCoreDir>/templates/
  const userDir = path.join(dir, "templates", "solterra-guildblade");
  fs.mkdirSync(userDir, { recursive: true });
  const m = solterraManifest();
  m.name = "Solterra (user copy)";
  fs.writeFileSync(path.join(userDir, "template.json"), JSON.stringify(m), "utf8");
  fs.copyFileSync(
    path.join(SOLTERRA_DIR, "system_prompt.md"),
    path.join(userDir, "system_prompt.md")
  );
  fs.copyFileSync(
    path.join(SOLTERRA_DIR, "bestiary.gm.json"),
    path.join(userDir, "bestiary.gm.json")
  );
  found = discoverTemplates();
  const overridden = found.filter((t) => t.id === "solterra-guildblade");
  assert.equal(overridden.length, 1, "id collision must resolve to one entry");
  assert.equal(overridden[0].name, "Solterra (user copy)");
});

await check("discovery: invalid manifest is skipped, not fatal", () => {
  const dir = freshCoreDir();
  const badDir = path.join(dir, "templates", "broken");
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, "template.json"), '{"schemaVersion": 99}', "utf8");
  const found = discoverTemplates();
  assert.ok(!found.some((t) => t.id === "broken"));
  assert.ok(found.some((t) => t.id === "solterra-guildblade"), "bundled still discovered");
});

await check("applyTemplate: Solterra seed lands in a fresh world, ids stamped, beats wrapped", () => {
  freshCoreDir();
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-stpl-world-"));
  const template = discoverTemplates().find((t) => t.id === "solterra-guildblade");
  const patch = applyTemplate(worldDir, template);

  const ws = JSON.parse(fs.readFileSync(path.join(worldDir, "world_state.json"), "utf8"));
  assert.equal(ws.schemaVersion, WORLD_STATE_SCHEMA_VERSION);
  assert.equal(ws.current_location, "Kalthas — Charter Chapterhouse");
  assert.equal(ws.npcs.length, 2);
  assert.ok(ws.npcs.every((n) => typeof n.id === "string" && n.id.startsWith("npc_")));
  assert.ok(ws.npcs.some((n) => n.name === "Skyra"));
  assert.equal(ws.locations.length, 2);
  assert.equal(ws.lorebook.length, 7);
  assert.ok(ws.lorebook.every((e) => e.id?.startsWith("lore_") && e.keywords.length > 0));
  assert.equal(ws.session_beats.length, 1);
  assert.ok(ws.session_beats[0].id?.startsWith("beat_"), "beats must be wrapped objects");
  assert.deepEqual(ws.character, {}, "Solterra character stays empty (the Forge fills it)");
  assert.deepEqual(ws.bestiary, [], "player bestiary starts empty");

  // GM separation: stat blocks live beside, never inside, world state.
  assert.ok(fs.existsSync(path.join(worldDir, GM_BESTIARY_FILENAME)));
  const raw = JSON.stringify(ws);
  assert.ok(!raw.includes("Goblin Scrapper"), "GM stat blocks must not enter world state");

  // world.json patch: narrator override + onboarding handoff
  assert.equal(patch.narrator.promptMode, "override");
  assert.ok(patch.narrator.systemPrompt.length > 1000, "Guildblade manual should be the prompt");
  assert.equal(patch.narrator.config.lengthPreset, "brief");
  assert.ok(patch.onboarding.firstMessageHint.includes("Character Forge"));
});

await check("applied world round-trips through loadWorldState (no migration rewrite)", () => {
  const dir = freshCoreDir();
  const template = discoverTemplates().find((t) => t.id === "solterra-guildblade");
  applyTemplate(dir, template); // legacy-flat layout: dir doubles as world dir
  const before = fs.readFileSync(path.join(dir, "world_state.json"), "utf8");
  const ws = loadWorldState();
  assert.equal(ws.schemaVersion, WORLD_STATE_SCHEMA_VERSION);
  assert.equal(ws.npcs.length, 2);
  const after = fs.readFileSync(path.join(dir, "world_state.json"), "utf8");
  assert.equal(before, after, "a freshly applied world must not need self-healing writes");
});

await check("applyTemplate: file references may not escape the template folder", () => {
  freshCoreDir();
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-stpl-world-"));
  const template = discoverTemplates().find((t) => t.id === "solterra-guildblade");
  const evil = {
    ...template,
    manifest: {
      ...template.manifest,
      narrator: { ...template.manifest.narrator, systemPromptFile: "../../core/config.example.json" }
    }
  };
  assert.throws(() => applyTemplate(worldDir, evil), /escapes the template folder/);
});

await check("loadGmBestiary: creatures from the copied file; null when absent", () => {
  freshCoreDir();
  const worldDir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-stpl-world-"));
  assert.equal(loadGmBestiary(worldDir), null);
  const template = discoverTemplates().find((t) => t.id === "solterra-guildblade");
  applyTemplate(worldDir, template);
  const creatures = loadGmBestiary(worldDir);
  assert.ok(Array.isArray(creatures) && creatures.length >= 60);
  assert.ok(creatures.some((c) => c.name === "Goblin Scrapper"));
});

// --- GM context block (context.js gmBestiary arg) ---------------------------

const ctxCfg = {
  narrativeSystem: "SYS",
  narrativeLengthDirective: "",
  maxContextMessages: 4,
  lorebook: {
    maxEntries: 5,
    maxInjectChars: 3500,
    maxMatchMessages: null,
    vectorSimilarityThreshold: 0.35,
    vectorEnabled: false
  },
  context: buildContextRuntimeConfig({})
};
const gmCreatures = [
  {
    name: "Gnasher",
    rank: "E",
    role: "Mook",
    vit: "12",
    guard: "12",
    atk: "+3",
    damage: "1d6+1",
    trait: "Pack tactics: advantage when a packmate is adjacent.",
    flaw: "Craven: flees alone.",
    xp: "4",
    typicalGroup: "M (3-6)"
  },
  { name: "Ash Wraith", rank: "C", vit: "40", guard: "15", atk: "+6", damage: "2d6", trait: "Incorporeal.", flaw: "Bound to its ash pile.", xp: "30" }
];

await check("GM block: creatures named in recent speech get stat lines (Flaw included, narrator-only)", async () => {
  freshCoreDir();
  const { defaultWorldState } = await import("../core/world_state.js");
  const session = { messages: [{ role: "user", content: "I sneak up on the gnasher pack." }] };
  const { prompt, report } = await assembleNarrativeContext({
    session,
    worldState: defaultWorldState(),
    cfg: ctxCfg,
    vectorStore: null,
    embedQuery: async () => null,
    gmBestiary: gmCreatures
  });
  assert.ok(prompt.includes("[GM bestiary"), "GM block missing");
  assert.ok(prompt.includes("Gnasher (E Mook)"));
  assert.ok(prompt.includes("Flaw: Craven: flees alone."));
  assert.ok(!prompt.includes("Ash Wraith"), "unmentioned creatures stay out");
  const sec = report.sections.find((s) => s.label === "gmBestiary");
  assert.deepEqual(sec.names, ["Gnasher"]);
});

await check("GM block: absent without a mention; gmBestiary null is byte-identical", async () => {
  const { defaultWorldState } = await import("../core/world_state.js");
  const session = { messages: [{ role: "user", content: "I order an ale." }] };
  const base = { session, worldState: defaultWorldState(), cfg: ctxCfg, vectorStore: null, embedQuery: async () => null };
  const withGm = await assembleNarrativeContext({ ...base, gmBestiary: gmCreatures });
  const without = await assembleNarrativeContext({ ...base });
  assert.equal(withGm.prompt, without.prompt, "no mention = no block = identical prompt");
  assert.ok(!withGm.prompt.includes("[GM bestiary"));
});

console.log(
  failures === 0 ? "\nstory_templates:test ALL PASS" : `\nstory_templates:test FAILURES: ${failures}`
);
process.exit(failures === 0 ? 0 : 1);
