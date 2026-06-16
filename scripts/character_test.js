// Model-free tests for the app-owned character foundation (design doc 01
// Phase 1): the safe derived-stat evaluator, spec + answer validation, the
// structured character builder, and manifest/spec discovery. The bundled
// Solterra character_creation.json is the live fixture.
//
// Usage: npm run character:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(
  path.join(os.tmpdir(), "tmixw-char-")
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SOLTERRA_DIR = path.join(REPO, "templates", "solterra-guildblade");

const { evaluateFormula, computeDerived } = await import("../core/character/derive.js");
const { validateCreationSpec, validateAnswers } = await import("../core/character/validate.js");
const { buildCharacter } = await import("../core/character/build.js");
const { gradeFreeform } = await import("../core/character/grade.js");
const { renderSheetForPrompt, buildConfirmOpeningDirective } = await import(
  "../core/character/opening.js"
);
const { loadCreationSpec } = await import("../core/character/spec.js");
const { discoverTemplates, validateManifest } = await import("../core/story_templates.js");

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

const solterraSpec = () =>
  JSON.parse(fs.readFileSync(path.join(SOLTERRA_DIR, "character_creation.json"), "utf8"));

// --- derive.js (the shared evaluator) ---------------------------------------

await check("derive: operator precedence and parens", () => {
  assert.equal(evaluateFormula("2 + 3 * 4"), 14);
  assert.equal(evaluateFormula("(2 + 3) * 4"), 20);
  assert.equal(evaluateFormula("-3 + 5"), 2);
  assert.equal(evaluateFormula("10 / 2 / 5"), 1);
});

await check("derive: functions floor/ceil/round/min/max", () => {
  assert.equal(evaluateFormula("floor(7/2)"), 3);
  assert.equal(evaluateFormula("ceil(7/2)"), 4);
  assert.equal(evaluateFormula("round(2.5)"), 3);
  assert.equal(evaluateFormula("min(armor, 3)", { armor: 5 }), 3);
  assert.equal(evaluateFormula("max(1, 9, 4)"), 9);
});

await check("derive: named variables resolve", () => {
  assert.equal(evaluateFormula("50 + 5*CON", { CON: 10 }), 100);
  assert.equal(evaluateFormula("30 + 3*(INT + WIL)", { INT: 7, WIL: 9 }), 78);
  assert.equal(evaluateFormula("10 + floor(AGI/2) + min(armor, 3)", { AGI: 14, armor: 1 }), 18);
});

await check("derive: unknown identifier is rejected (no reach outside the bag)", () => {
  assert.throws(() => evaluateFormula("FOO + 1", {}), /unknown identifier/);
  assert.throws(() => evaluateFormula("CON + bonus", { CON: 5 }), /unknown identifier/);
});

await check("derive: malformed expressions throw, never silently yield NaN", () => {
  assert.throws(() => evaluateFormula("2 +"));
  assert.throws(() => evaluateFormula("(2 + 3"));
  assert.throws(() => evaluateFormula("2 3"));
  assert.throws(() => evaluateFormula("1 / 0"), /division by zero/);
});

await check("derive: computeDerived chains earlier keys into later ones", () => {
  const out = computeDerived({ a: "CON * 2", b: "a + 1" }, { CON: 5 });
  assert.deepEqual(out, { a: 10, b: 11 });
});

// --- validate.js: spec ------------------------------------------------------

await check("validateCreationSpec: Solterra spec is valid", () => {
  const v = validateCreationSpec(solterraSpec());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

await check("validateCreationSpec: structural problems are all reported", () => {
  assert.equal(validateCreationSpec({ schemaVersion: 1 }).ok, false); // no steps
  assert.equal(validateCreationSpec({ schemaVersion: 2, steps: [] }).ok, false);
  const badDerived = solterraSpec();
  badDerived.derived.guard = "10 + NONSENSE";
  const v = validateCreationSpec(badDerived);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("derived.guard")), v.errors.join(" | "));
});

// --- validate.js: answers ---------------------------------------------------

const goodAnswers = () => ({
  name: "Vex",
  pronouns: "she/her",
  look: "lean, scarred",
  race: "beastkin",
  race__statChoice: ["AGI"],
  race__subtype: "feline",
  origin: "frontier-scout",
  origin__skillChoice: "Tracking",
  stats: { STR: 7, AGI: 11, CON: 10, INT: 7, CHA: 6, WIL: 9 },
  skills: ["Stealth", "Archery", "Healing"],
  unique_power: "I step through shadows for a moment"
});

await check("validateAnswers: a complete, legal answer set passes", () => {
  const v = validateAnswers(solterraSpec(), goodAnswers());
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
});

await check("validateAnswers: point-buy must spend exactly the pool, within bounds", () => {
  const under = goodAnswers();
  under.stats.WIL = 8; // sum 49
  assert.ok(validateAnswers(solterraSpec(), under).errors.some((e) => e.includes("exactly 50")));

  const outOfRange = goodAnswers();
  outOfRange.stats.STR = 2; // below min 3
  outOfRange.stats.AGI = 12; // keep sum 50 (11->12, 7->6)
  outOfRange.stats.INT = 6;
  assert.ok(validateAnswers(solterraSpec(), outOfRange).errors.some((e) => e.includes("STR=2")));
});

await check("validateAnswers: required, membership, and exact counts are enforced", () => {
  const noName = goodAnswers();
  noName.name = "";
  assert.ok(validateAnswers(solterraSpec(), noName).errors.some((e) => e.includes("name is required")));

  const badRace = goodAnswers();
  badRace.race = "dragon";
  assert.ok(validateAnswers(solterraSpec(), badRace).errors.some((e) => e.includes("dragon")));

  const wrongSkillCount = goodAnswers();
  wrongSkillCount.skills = ["Stealth", "Archery"]; // only 2
  assert.ok(validateAnswers(solterraSpec(), wrongSkillCount).errors.some((e) => e.includes("exactly 3")));

  const missingStatChoice = goodAnswers();
  delete missingStatChoice.race__statChoice;
  assert.ok(validateAnswers(solterraSpec(), missingStatChoice).errors.some((e) => e.includes("statChoice")));
});

// --- build.js: the structured sheet (golden) --------------------------------

await check("buildCharacter: produces the structured §7 sheet with deterministic math", () => {
  const spec = solterraSpec();
  const c = buildCharacter(spec, goodAnswers(), {}, () => "2026-06-14T00:00:00.000Z");

  assert.equal(c.createdBy, "app-forge");
  assert.equal(c.schemaVersion, 1);
  assert.equal(c.createdAt, "2026-06-14T00:00:00.000Z");
  assert.equal(c.name, "Vex");

  // base point-buy preserved; race(+1 AGI) + origin(+2 AGI) applied to final
  assert.deepEqual(c.statsBase, { STR: 7, AGI: 11, CON: 10, INT: 7, CHA: 6, WIL: 9 });
  assert.deepEqual(c.stats, { STR: 7, AGI: 14, CON: 10, INT: 7, CHA: 6, WIL: 9 });

  // derived from the final stats + equipped armor (leather = 1)
  assert.deepEqual(c.derived, { vitality: 100, stamina: 80, aether: 78, guard: 18 });
  assert.deepEqual(c.resources, {
    vitality: { current: 100, max: 100 },
    stamina: { current: 80, max: 80 },
    aether: { current: 78, max: 78 }
  });

  // skills: origin's chosen skill + the three picked, deduped, stamped Rank E
  assert.deepEqual(
    c.skills.map((s) => s.name),
    ["Tracking", "Stealth", "Archery", "Healing"]
  );
  assert.ok(c.skills.every((s) => s.rank === "E"));

  // race subtype label + traits; origin items + coin
  assert.equal(c.race.id, "beastkin");
  assert.equal(c.race.label, "Feline-kin");
  assert.deepEqual(c.traits, ["night sight", "silent step"]);
  assert.equal(c.coin.ss, 15);
  assert.ok(c.inventory.some((it) => it.name === "Shortbow" && it.equipped));

  // start constants
  assert.equal(c.rank, "E");
  assert.equal(c.rankLabel, "Tin");
  assert.deepEqual(c.xp, { current: 0, max: 100 });
});

await check("buildCharacter: missing grading falls back deterministically (never blocks)", () => {
  const c = buildCharacter(solterraSpec(), goodAnswers(), {}, () => "t");
  assert.equal(c.unique_power.graded, false);
  assert.ok(typeof c.unique_power.name === "string" && c.unique_power.name.length > 0);
  assert.ok(typeof c.unique_power.cost === "string");
});

await check("buildCharacter: a supplied grade is used verbatim over the fallback", () => {
  const graded = { unique_power: { name: "Gloamstep", reliable: "r", stretch: "s", cost: "10 STA", graded: true } };
  const c = buildCharacter(solterraSpec(), goodAnswers(), graded, () => "t");
  assert.deepEqual(c.unique_power, graded.unique_power);
});

// --- grade.js (the one LLM step) --------------------------------------------

const powerField = () => solterraSpec().steps.find((s) => s.id === "power").fields[0];

await check("gradeFreeform: a well-formed model reply is shaped and marked graded", async () => {
  const generate = async () =>
    'Sure! {"name":"Gloamstep","reliable":"Step a few feet through shadow.","stretch":"Cross a lit room, but it drains you.","cost":"10 STA"} hope that helps';
  const r = await gradeFreeform(powerField(), "I slip between shadows", { generate });
  assert.equal(r.graded, true);
  assert.equal(r.name, "Gloamstep");
  assert.equal(r.cost, "10 STA");
  assert.ok(r.reliable && r.stretch);
});

await check("gradeFreeform: retries once on bad JSON, then succeeds", async () => {
  let calls = 0;
  const generate = async () => {
    calls++;
    return calls === 1
      ? "no json here, sorry"
      : '{"name":"Emberhand","reliable":"Light a candle or singe rope.","stretch":"A burst of flame at a cost.","cost":"5 AET"}';
  };
  const r = await gradeFreeform(powerField(), "fire from my hands", { generate });
  assert.equal(calls, 2);
  assert.equal(r.graded, true);
  assert.equal(r.name, "Emberhand");
});

await check("gradeFreeform: backend failure falls back deterministically (never throws)", async () => {
  const generate = async () => {
    throw new Error("ECONNREFUSED");
  };
  const r = await gradeFreeform(powerField(), "I bend light", { generate });
  assert.equal(r.graded, false);
  assert.ok(typeof r.name === "string" && r.name.length > 0);
});

await check("gradeFreeform: empty text never calls the model", async () => {
  let called = false;
  const generate = async () => {
    called = true;
    return "{}";
  };
  const r = await gradeFreeform(powerField(), "   ", { generate });
  assert.equal(called, false);
  assert.equal(r.graded, false);
});

// --- opening.js (narrator handoff, §10) -------------------------------------

await check("renderSheetForPrompt: renders the final numbers and resource pools", () => {
  const c = buildCharacter(solterraSpec(), goodAnswers(), {}, () => "t");
  const sheet = renderSheetForPrompt(c);
  assert.ok(sheet.includes("Name: Vex"));
  assert.ok(sheet.includes("AGI 14"), sheet); // race+origin bonus reflected
  assert.ok(/Vitality 100\/100/.test(sheet), sheet); // pool as current/max
  assert.ok(/Guard 18/.test(sheet), sheet); // non-pool derived as a value
  assert.ok(sheet.includes("Tracking (E)"));
});

await check("buildConfirmOpeningDirective: embeds the sheet, the hint, and the do-not-alter rules", () => {
  const c = buildCharacter(solterraSpec(), goodAnswers(), {}, () => "t");
  const d = buildConfirmOpeningDirective(c, "Press the tin plate into their palm.");
  assert.ok(d.includes("Press the tin plate into their palm."));
  assert.ok(d.includes("Name: Vex"));
  assert.ok(/do not invent|do not .*change|EXACT/i.test(d), d);
  assert.ok(/creation is done|already created|SUPERSEDES/i.test(d), d);
  // must explicitly forbid placeholder output (the live-pass failure mode)
  assert.ok(/placeholder|\[Name\]|Traveler/i.test(d), d);
});

await check("validateManifest: onboarding.mode must be a known value", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOLTERRA_DIR, "template.json"), "utf8"));
  assert.equal(validateManifest(manifest).ok, true);
  assert.equal(manifest.onboarding.mode, "app-forge");
  manifest.onboarding.mode = "telepathy";
  assert.equal(validateManifest(manifest).ok, false);
});

// --- spec.js + manifest wiring ----------------------------------------------

await check("loadCreationSpec: returns the validated Solterra spec via the manifest", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOLTERRA_DIR, "template.json"), "utf8"));
  const res = loadCreationSpec(SOLTERRA_DIR, manifest);
  assert.ok(res && res.spec, "spec should load");
  assert.deepEqual(res.errors, []);
  assert.equal(res.spec.schemaVersion, 1);
});

await check("loadCreationSpec: null when the manifest references no spec", () => {
  assert.equal(loadCreationSpec(SOLTERRA_DIR, { onboarding: {} }), null);
});

await check("validateManifest: onboarding.characterCreationFile must be a string", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(SOLTERRA_DIR, "template.json"), "utf8"));
  assert.equal(validateManifest(manifest).ok, true);
  manifest.onboarding.characterCreationFile = 42;
  const v = validateManifest(manifest);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("characterCreationFile")));
});

await check("discoverTemplates: attaches the validated creationSpec to Solterra", () => {
  const solterra = discoverTemplates().find((t) => t.id === "solterra-guildblade");
  assert.ok(solterra, "bundled solterra-guildblade not discovered");
  assert.ok(solterra.creationSpec, "creationSpec should be attached");
  assert.equal(solterra.creationSpec.schemaVersion, 1);
});

console.log(
  failures === 0 ? "\ncharacter:test ALL PASS" : `\ncharacter:test FAILURES: ${failures}`
);
process.exit(failures === 0 ? 0 : 1);
