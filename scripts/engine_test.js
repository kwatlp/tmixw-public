// Model-free tests for the deterministic interaction engine (design doc 02).
// Phase 1 here: seedable RNG, rules load/validate/accessors, and the v5→v6
// world-state migration. Later increments append economy/inventory/checks.
//
// Usage: npm run engine:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-engine-"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, "..");
const SOLTERRA_DIR = path.join(REPO, "templates", "solterra-guildblade");

const { makeRng, rollDie, rollDice, rollExpr, parseDice, rollD20WithMode } = await import(
  "../core/engine/rng.js"
);
const { loadRules, validateRules, DEFAULT_RULES, dcFor, rankBonus, damageDie, coinRatios, xpToNext, nextRank, critFumble } =
  await import("../core/engine/rules.js");
const { defaultWorldState, migrateWorldState, WORLD_STATE_SCHEMA_VERSION, applyExtractorDiff } =
  await import("../core/world_state.js");
const { resolve, renderMechanicsDirective } = await import("../core/engine/resolve.js");
const { classifyFastPath, classifyIntent } = await import("../core/engine/intent.js");
const { applyDeltas } = await import("../core/engine/apply.js");
const { toBase, fromBase, canAfford, spend, gain } = await import("../core/engine/economy.js");
const { awardXp } = await import("../core/engine/progression.js");

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

// --- rng.js -----------------------------------------------------------------

await check("rng: same seed → identical stream (replayable)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  const seqA = Array.from({ length: 10 }, () => a.next());
  const seqB = Array.from({ length: 10 }, () => b.next());
  assert.deepEqual(seqA, seqB);
  assert.equal(makeRng(42).seed, 42);
});

await check("rng: different seeds diverge", () => {
  const a = Array.from({ length: 20 }, ((r) => () => r.next())(makeRng(1)));
  const b = Array.from({ length: 20 }, ((r) => () => r.next())(makeRng(2)));
  assert.notDeepEqual(a, b);
});

await check("rng: rollDie stays in 1..sides over many draws", () => {
  const rng = makeRng(7);
  for (let i = 0; i < 2000; i++) {
    const d = rollDie(rng, 20);
    assert.ok(d >= 1 && d <= 20, `d20 out of range: ${d}`);
  }
});

await check("rng: rollDice sums its dice; parseDice/rollExpr handle NdM", () => {
  const rng = makeRng(99);
  const { total, dice } = rollDice(rng, 3, 6);
  assert.equal(dice.length, 3);
  assert.equal(total, dice.reduce((s, d) => s + d, 0));
  assert.deepEqual(parseDice("2d8"), { count: 2, sides: 8 });
  assert.deepEqual(parseDice("d12"), { count: 1, sides: 12 });
  assert.equal(parseDice("nonsense"), null);
  assert.deepEqual(rollExpr(makeRng(1), "garbage"), { total: 0, dice: [] });
});

await check("rng: advantage keeps high, disadvantage keeps low", () => {
  for (let seed = 0; seed < 200; seed++) {
    const adv = rollD20WithMode(makeRng(seed), "advantage");
    assert.equal(adv.kept, Math.max(...adv.dice));
    const dis = rollD20WithMode(makeRng(seed), "disadvantage");
    assert.equal(dis.kept, Math.min(...dis.dice));
  }
});

// --- rules.js ---------------------------------------------------------------

await check("rules: Solterra rules.json loads, validates, merges over defaults", () => {
  const r = loadRules(SOLTERRA_DIR, { gm: { rulesFile: "rules.json" } });
  assert.equal(dcFor(r, "tough"), 18);
  assert.equal(dcFor(r, "heroic"), 26);
  assert.equal(rankBonus(r, "E"), 1);
  assert.equal(rankBonus(r, "S"), 6);
  assert.equal(damageDie(r, "light"), "d6");
  assert.equal(coinRatios(r).gc, 200);
  assert.equal(xpToNext(r, "E"), 100);
  assert.equal(xpToNext(r, "S"), null, "top rank has no next threshold");
  assert.equal(nextRank(r, "E"), "D");
  assert.equal(nextRank(r, "S"), null);
  assert.deepEqual(critFumble(r), { critOn: 20, fumbleOn: 1 });
});

await check("rules: a missing rulesFile yields DEFAULT_RULES (engine still runs)", () => {
  const r = loadRules(SOLTERRA_DIR, { gm: {} });
  assert.equal(r, DEFAULT_RULES);
  assert.equal(dcFor(r, "routine"), 14);
});

await check("rules: a partial file merges, keeping default tables", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmixw-rules-"));
  fs.writeFileSync(path.join(dir, "r.json"), JSON.stringify({ resolution: { dcByDifficulty: { tough: 19 } } }));
  const r = loadRules(dir, { gm: { rulesFile: "r.json" } });
  assert.equal(dcFor(r, "tough"), 19, "override applied");
  assert.equal(dcFor(r, "routine"), 14, "untouched difficulty keeps the default");
  assert.equal(rankBonus(r, "E"), 1, "untouched table keeps the default");
});

await check("rules: validateRules flags type violations, accepts partial", () => {
  assert.equal(validateRules({ resolution: { critOn: 20 } }).ok, true);
  assert.equal(validateRules({ schemaVersion: 2 }).ok, false);
  assert.equal(validateRules({ resolution: "nope" }).ok, false);
  assert.equal(validateRules(null).ok, false);
});

// --- world-state migration v5→v6 -------------------------------------------

await check("migration: v5 → v6 adds the empty encounter section", () => {
  const ws = defaultWorldState();
  assert.deepEqual(ws.encounter, { active: false });
  assert.equal(ws.schemaVersion, WORLD_STATE_SCHEMA_VERSION);

  const legacy = { ...defaultWorldState(), schemaVersion: 5 };
  delete legacy.encounter;
  const changed = migrateWorldState(legacy);
  assert.equal(changed, true);
  assert.equal(legacy.schemaVersion, 6);
  assert.deepEqual(legacy.encounter, { active: false });

  // idempotent
  assert.equal(migrateWorldState(legacy), false);
});

// --- Phase 2: intent, resolvers, deltas, economy, progression ---------------

const RULES = loadRules(SOLTERRA_DIR, { gm: { rulesFile: "rules.json" } });
const clone = (v) => JSON.parse(JSON.stringify(v));
const sampleChar = () => ({
  createdBy: "app-forge",
  name: "Vex",
  stats: { STR: 7, AGI: 14, CON: 10, INT: 7, CHA: 6, WIL: 9 },
  derivedFormulas: {
    vitality: "50 + 5*CON", stamina: "40 + 4*CON",
    aether: "30 + 3*(INT + WIL)", guard: "10 + floor(AGI/2) + min(armor, 3)"
  },
  derived: { vitality: 100, stamina: 80, aether: 78, guard: 18 },
  resources: {
    vitality: { current: 60, max: 100 },
    stamina: { current: 40, max: 80 },
    aether: { current: 78, max: 78 }
  },
  skills: [{ name: "Tracking", rank: "E" }],
  coin: { gc: 0, ss: 15, cb: 0 },
  xp: { current: 95, max: 100 },
  rank: "E",
  inventory: [
    { name: "Shortbow", slot: "weapon", damage: "d6", equipped: true },
    { name: "Leather jerkin", slot: "armor", armor: 1, equipped: true },
    { name: "Mail shirt", slot: "armor", armor: 2, equipped: false }
  ],
  conditions: []
});

await check("intent: fast path matches commands, freeform falls through", () => {
  assert.deepEqual(classifyFastPath("equip mail shirt"), { actionType: "equip", item: "mail shirt", raw: "equip mail shirt" });
  assert.equal(classifyFastPath("unequip leather jerkin").actionType, "unequip");
  assert.equal(classifyFastPath("drink healing potion").actionType, "use");
  assert.equal(classifyFastPath("make camp for the night").actionType, "rest");
  assert.equal(classifyFastPath("I creep toward the gnashers"), null);
});

await check("intent: classifyIntent resolves freeform with no referee", async () => {
  const p = await classifyIntent("I look around the room");
  assert.equal(p.actionType, "freeform");
});

await check("resolve: freeform → null (narration only, no mechanics)", () => {
  assert.equal(resolve({ actionType: "freeform" }, sampleChar(), { active: false }, RULES, makeRng(1)), null);
  assert.equal(resolve({ actionType: "equip", item: "the moon" }, sampleChar(), { active: false }, RULES, makeRng(1)), null);
});

await check("resolve: equip recomputes Guard via the shared evaluator", () => {
  const r = resolve({ actionType: "equip", item: "mail shirt" }, sampleChar(), { active: false }, RULES, makeRng(1));
  assert.equal(r.actionType, "equip");
  // armor 1 (leather) + 2 (mail) = 3 → guard 10 + floor(14/2) + min(3,3) = 20
  const status = r.sections.find((s) => s.type === "status");
  assert.equal(status.snapshot.GUARD, "20");
  assert.ok(r.narration.facts.some((f) => /Guard 18 → 20/.test(f)), r.narration.facts.join("|"));
});

await check("resolve: rest restores pools per rules.rest", () => {
  const r = resolve({ actionType: "rest" }, sampleChar(), { active: false }, RULES, makeRng(1));
  const status = r.sections.find((s) => s.type === "status");
  assert.equal(status.snapshot.STA, "80/80", "stamina to full");
  assert.equal(status.snapshot.VIT, "85/100", "vitality +25% of max");
});

await check("commit: applyDeltas writes the projected mechanical fields exactly", () => {
  const ws = { character: sampleChar(), encounter: { active: false } };
  const r = resolve({ actionType: "equip", item: "mail shirt" }, ws.character, ws.encounter, RULES, makeRng(1));
  const before = clone(ws.character);
  applyDeltas(ws, r.deltas);
  assert.equal(ws.character.derived.guard, 20);
  assert.equal(ws.character.inventory.find((i) => i.name === "Mail shirt").equipped, true);
  // unrelated fields untouched
  assert.deepEqual(ws.character.stats, before.stats);
  // absolute deltas are idempotent (the pipeline still applies them once)
  applyDeltas(ws, r.deltas);
  assert.equal(ws.character.derived.guard, 20);
});

await check("directive: renderMechanicsDirective wraps the facts as do-not-alter", () => {
  const r = resolve({ actionType: "rest" }, sampleChar(), { active: false }, RULES, makeRng(1));
  const d = renderMechanicsDirective(r);
  assert.ok(/RESOLVED MECHANICS/.test(d));
  assert.ok(/do NOT/i.test(d));
  assert.ok(/SUPERSEDES/.test(d), "must override the manual's resolution rules");
  assert.ok(/Failure is a failure/.test(d), "outcome is binding");
  assert.equal(renderMechanicsDirective(null), "", "no mechanics ⇒ empty directive");
});

await check("economy: coin math normalizes across denominations", () => {
  assert.equal(toBase({ gc: 1, ss: 0, cb: 0 }, RULES), 200);
  assert.equal(toBase({ gc: 0, ss: 15, cb: 0 }, RULES), 150);
  assert.deepEqual(fromBase(215, RULES), { gc: 1, ss: 1, cb: 5 });
  assert.equal(canAfford({ ss: 15 }, 150, RULES), true);
  assert.equal(canAfford({ ss: 15 }, 151, RULES), false);
  assert.equal(spend({ ss: 15 }, 200, RULES), null, "unaffordable → null");
  assert.deepEqual(spend({ gc: 1 }, 50, RULES), { gc: 0, ss: 15, cb: 0 });
  assert.deepEqual(gain({ ss: 15 }, 60, RULES), { gc: 1, ss: 1, cb: 0 });
});

await check("progression: awardXp crosses the rank threshold (the ding)", () => {
  const c = sampleChar(); // xp 95/100
  const { deltas, rankUps, facts } = awardXp(c, 5, RULES);
  assert.equal(rankUps.length, 1);
  assert.deepEqual(rankUps[0], { from: "E", to: "D", statPoints: 2 });
  const get = (path) => deltas.character.find((d) => d.path.join(".") === path)?.value;
  assert.equal(get("rank"), "D");
  assert.equal(get("xp.current"), 0);
  assert.equal(get("xp.max"), 150);
  assert.equal(get("resources.vitality.max"), 110);
  assert.ok(facts.some((f) => /RANK UP/.test(f)));
});

await check("progression: a sub-threshold award just adds XP", () => {
  const c = sampleChar();
  c.xp = { current: 10, max: 100 };
  const { deltas, rankUps } = awardXp(c, 5, RULES);
  assert.equal(rankUps.length, 0);
  assert.deepEqual(deltas.character, [{ path: ["xp", "current"], value: 15 }]);
});

await check("extractor guard: engine-owned fields skipped on app-forge sheets (§9)", () => {
  const ws = defaultWorldState();
  ws.character = sampleChar();
  applyExtractorDiff(ws, { player_character: { xp: { current: 999 }, look: "weathered" } });
  assert.equal(ws.character.xp.current, 95, "engine owns xp — extractor write ignored");
  assert.equal(ws.character.look, "weathered", "soft fields still flow from the extractor");
});

// --- Phase 3: checks + referee ----------------------------------------------

const { resolveCheck } = await import("../core/engine/checks.js");
const { parseProposal, runReferee, looksLikeAction, buildRefereePrompt } = await import(
  "../core/engine/referee.js"
);

/** First d20 for a seed (resolveCheck's first draw on a no-advantage check). */
function seedForNat(nat) {
  for (let s = 1; s < 200000; s++) if (rollDie(makeRng(s), 20) === nat) return s;
  throw new Error(`no seed found for nat ${nat}`);
}

await check("checks: a mid roll + stat beats the DC → success", () => {
  const seed = seedForNat(12);
  const r = resolveCheck({ actionType: "check", stat: "AGI", difficulty: "tough" }, sampleChar(), RULES, makeRng(seed));
  // nat 12 + AGI 14 = 26 vs DC 18
  assert.equal(r.rolls[0].total, 26);
  assert.equal(r.rolls[0].outcome, "success");
  const rollSection = r.sections.find((s) => s.type === "roll");
  assert.ok(rollSection);
  // Structured outcome rides the section so the renderer never parses the line.
  assert.equal(rollSection.outcome, "success");
  assert.match(r.facts[0], /vs DC 18 — Success/);
});

await check("checks: natural 20 crits, natural 1 is a complication", () => {
  const crit = resolveCheck({ actionType: "check", stat: "STR" }, sampleChar(), RULES, makeRng(seedForNat(20)));
  assert.equal(crit.rolls[0].crit, true);
  assert.match(crit.facts[0], /Critical success/);
  const fumble = resolveCheck({ actionType: "check", stat: "STR" }, sampleChar(), RULES, makeRng(seedForNat(1)));
  assert.match(fumble.facts[0], /Complication/);
});

await check("checks: a matching ranked skill adds its rank bonus", () => {
  const seed = seedForNat(10);
  const withSkill = resolveCheck({ actionType: "check", stat: "AGI", skill: "Tracking" }, sampleChar(), RULES, makeRng(seed));
  // nat 10 + AGI 14 + rank E (+1) = 25
  assert.equal(withSkill.rolls[0].total, 25);
});

await check("checks: a plausible gambit pays XP win or lose", () => {
  const c = sampleChar();
  c.xp = { current: 10, max: 100 }; // avoid rank-up noise
  const r = resolveCheck(
    { actionType: "check", stat: "AGI", gambit: { described: true, plausible: true } },
    c, RULES, makeRng(seedForNat(3)) // low roll — likely a miss
  );
  const xpDelta = r.deltas.character.find((d) => d.path.join(".") === "xp.current");
  assert.equal(xpDelta.value, 15, "gambit awards +5 XP regardless of the roll");
  assert.ok(r.facts.some((f) => /\+5 XP/.test(f)));
});

await check("referee: parseProposal normalizes a check, defaults difficulty", () => {
  const p = parseProposal('ok {"actionType":"check","stat":"agi","skill":"Stealth","gambit":{"described":true,"plausible":true}} done');
  assert.equal(p.actionType, "check");
  assert.equal(p.stat, "AGI");
  assert.equal(p.difficulty, "tough");
  assert.deepEqual(p.gambit, { described: true, plausible: true });
});

await check("referee: freeform/garbage/stat-less all degrade to freeform-or-null", () => {
  assert.deepEqual(parseProposal('{"actionType":"freeform"}'), { actionType: "freeform" });
  assert.equal(parseProposal("no json here"), null);
  assert.deepEqual(parseProposal('{"actionType":"check"}'), { actionType: "freeform" }, "a check needs a stat");
});

await check("referee: runReferee retries then falls back; never throws", async () => {
  let calls = 0;
  const flaky = async () => (++calls === 1 ? "junk" : '{"actionType":"check","stat":"STR","difficulty":"severe"}');
  const p = await runReferee("I force the door", { stats: sampleChar().stats }, flaky);
  assert.equal(calls, 2);
  assert.equal(p.stat, "STR");
  assert.equal(p.difficulty, "severe");

  const dead = async () => { throw new Error("backend down"); };
  assert.deepEqual(await runReferee("x", {}, dead), { actionType: "freeform" });
});

await check("referee: looksLikeAction gates the model call", () => {
  assert.equal(looksLikeAction("I leap the chasm onto the ledge"), true);
  assert.equal(looksLikeAction("I look around the tavern"), false);
  assert.equal(looksLikeAction("I greet the clerk", true), true, "in combat everything is action");
  // explicit check requests / stat invocations must engage the engine
  assert.equal(looksLikeAction("i cause a wisdom check"), true);
  assert.equal(looksLikeAction("I use my wisdom to understand the statue"), true);
  assert.match(buildRefereePrompt("I climb", { stats: { STR: 7 }, skills: [{ name: "Athletics" }] }), /Athletics/);
});

await check("intent: classifyIntent uses the referee for action freeform", async () => {
  const referee = async () => ({ actionType: "check", stat: "AGI" });
  const p = await classifyIntent("I vault the railing", { referee });
  assert.equal(p.actionType, "check");
  assert.equal(p.stat, "AGI");
  // fast-path still wins over the referee
  const eq = await classifyIntent("equip mail shirt", { referee });
  assert.equal(eq.actionType, "equip");
});

// --- sanitize: strip the model's stray mechanical output (§8) ---------------

const { sanitizeNarration } = await import("../core/engine/sanitize.js");

await check("sanitize: strips status blocks, XP lines, sheet dumps, hallucinated headers", () => {
  const dirty = [
    "You flee deeper into the mine.",
    "",
    "XP reward: +1 XP",
    "*Status update:*",
    "VIT 76/85 · STA 63/68 · AET 78/78",
    "## §18 · QUEST COMPLETED",
    "STR 4",
    "SKILL SLOTS: 2/3",
    "coins: 10 SS",
    "Guard 16",
    "Alpha 21/30"
  ].join("\n");
  const clean = sanitizeNarration(dirty);
  assert.ok(clean.includes("You flee deeper into the mine."), "prose kept");
  assert.ok(!/XP reward/i.test(clean));
  assert.ok(!/VIT 76\/85/.test(clean));
  assert.ok(!/§18|QUEST COMPLETED/.test(clean));
  assert.ok(!/SKILL SLOTS/.test(clean));
  assert.ok(!/^STR 4$/m.test(clean));
  assert.ok(!/^Guard 16$/m.test(clean));
  assert.ok(!/Alpha 21\/30/.test(clean));
});

await check("sanitize: strips a model-printed roll line (vs DC), keeps the prose", () => {
  const t = "You concentrate.\n\nRolling 2d20: 12 + 12 + 8 = 32 vs DC 25 — Success\n\nAncient power fills you.";
  const clean = sanitizeNarration(t);
  assert.ok(clean.includes("You concentrate."));
  assert.ok(clean.includes("Ancient power fills you."));
  assert.ok(!/vs DC/i.test(clean));
  assert.ok(!/Rolling 2d20/i.test(clean));
});

await check("sanitize: strips combat-mechanics leak (d20 / 'that's a gambit' / vs Guard)", () => {
  const t = "The alpha circles low.\n\nThe cart is greased — that's a gambit, take Advantage. [STR, 2d20 9\n\nd20(17)+12 = 29 vs Guard 13 — Hit\n\nYou loose an arrow.";
  const clean = sanitizeNarration(t);
  assert.ok(clean.includes("The alpha circles low."));
  assert.ok(clean.includes("You loose an arrow."));
  assert.ok(!/gambit/i.test(clean));
  assert.ok(!/2d20|d20\(/i.test(clean));
  assert.ok(!/vs Guard/i.test(clean));
});

await check("sanitize: keeps ordinary prose and removes inline ⟦…⟧ markers", () => {
  const text = "The shortbow sings ⟦Status VIT 10/10⟧ and the gnasher drops. You have 10 silver to your name.";
  const clean = sanitizeNarration(text);
  assert.ok(clean.includes("The shortbow sings"));
  assert.ok(clean.includes("the gnasher drops"));
  assert.ok(clean.includes("10 silver to your name"), "numbers inside prose sentences are kept");
  assert.ok(!clean.includes("⟦"));
});

await check("sanitize: blank/whitespace passes through untouched", () => {
  assert.equal(sanitizeNarration(""), "");
  assert.equal(sanitizeNarration("   "), "   ");
});

// --- Phase 4: combat --------------------------------------------------------

const { rollDamageExpr } = await import("../core/engine/rng.js");
const { startEncounter, resolveAttack, resolveFlee } = await import("../core/engine/combat.js");
const GM_BESTIARY = JSON.parse(
  fs.readFileSync(path.join(SOLTERRA_DIR, "bestiary.gm.json"), "utf8")
).creatures;

const fighter = () => ({
  createdBy: "app-forge", name: "Vex",
  stats: { STR: 10, AGI: 12, CON: 10, INT: 7, CHA: 6, WIL: 9 },
  derived: { guard: 14 },
  resources: { vitality: { current: 100, max: 100 } },
  xp: { current: 10, max: 100 }, rank: "E",
  inventory: [{ name: "Arming sword", slot: "weapon", damage: "d8", equipped: true }],
  skills: [], conditions: []
});

await check("rng: rollDamageExpr keeps the flat modifier and can crit-double", () => {
  for (let s = 0; s < 50; s++) {
    const r = rollDamageExpr(makeRng(s), "1d6+3");
    assert.equal(r.flat, 3);
    assert.ok(r.total >= 4 && r.total <= 9, `1d6+3 out of range: ${r.total}`);
  }
  const dbl = rollDamageExpr(makeRng(1), "2d8", { doubleDice: true });
  assert.equal(dbl.dice.length, 4, "crit doubles the dice count");
  assert.deepEqual(rollDamageExpr(makeRng(1), "5"), { total: 5, dice: [], flat: 5 }, "bare number = flat");
});

await check("combat: startEncounter mints enemies from the bestiary stat block", () => {
  const enc = startEncounter("Goblin Scrapper", GM_BESTIARY, makeRng(1));
  assert.equal(enc.active, true);
  assert.equal(enc.round, 1);
  assert.ok(enc.enemies.length >= 1 && enc.enemies.length <= 3);
  const g = enc.enemies[0];
  assert.equal(g.name, "Goblin Scrapper");
  assert.equal(g.vitality.max, 5); // vit "5" parsed
  assert.equal(g.guard, 11);
  assert.equal(g.atk, 2); // "+2"
  assert.equal(g.damage, "1d4+1");
  assert.equal(g.xp, 2);
  assert.ok(g.id.startsWith("goblin-scrapper-"));
  assert.deepEqual(g.traits, ["Craven: flees when the pack drops to half."]);
});

await check("combat: a fight starts on the first attack, runs rounds, and victory awards XP", () => {
  const ws = { character: fighter(), encounter: { active: false } };
  let result;
  for (let round = 1; round <= 10; round++) {
    result = resolve({ actionType: "attack", target: "Goblin Scrapper", stat: "STR" }, ws.character, ws.encounter, RULES, makeRng(1000 + round), GM_BESTIARY);
    assert.ok(result, "attack resolves to mechanics");
    assert.ok(result.sections.some((s) => s.type === "roll" || s.type === "combat"));
    // Combat section carries structured events (text + tone), not display strings.
    const round0 = result.sections.find((s) => s.type === "combat");
    assert.ok(Array.isArray(round0.events) && round0.events.every((e) => e.text && e.tone), "structured combat events");
    applyDeltas(ws, result.deltas);
    if (!ws.encounter.active) break;
  }
  assert.equal(ws.encounter.active, false, "combat ends");
  assert.ok(ws.character.xp.current > 10, "victory awarded XP");
});

await check("combat: a hit reduces enemy VIT; a crit doubles damage dice", () => {
  const enc = { active: true, round: 1, enemies: [{ id: "g-1", name: "Gnasher", vitality: { current: 40, max: 40 }, guard: 1, atk: 0, damage: "1d4", xp: 5 }] };
  // guard 1 ⇒ almost always a hit; assert VIT dropped and a roll section exists.
  const r = resolveAttack({ actionType: "attack", target: "Gnasher", stat: "STR" }, fighter(), enc, RULES, makeRng(3), GM_BESTIARY);
  const enemyAfter = r.deltas.encounterReplace.enemies[0];
  assert.ok(enemyAfter.vitality.current < 40, "enemy took damage");
  assert.ok(r.sections.some((s) => s.type === "roll"));
  // Enemies section exposes structured rows (name/cur/max), not parsed strings.
  const enemies = r.sections.find((s) => s.type === "enemies");
  assert.ok(enemies && enemies.enemies[0].name === "Gnasher" && enemies.enemies[0].max === 40);
});

await check("combat: enemy retaliation downs the player → encounter cleared + condition", () => {
  const frail = fighter();
  frail.resources.vitality.current = 1;
  frail.derived.guard = 1; // enemy will hit
  const enc = { active: true, round: 1, enemies: [{ id: "b-1", name: "Brute", vitality: { current: 50, max: 50 }, guard: 30, atk: 10, damage: "3d6+5", xp: 12 }] };
  const r = resolveAttack({ actionType: "attack", target: "Brute", stat: "STR" }, frail, enc, RULES, makeRng(7), GM_BESTIARY);
  assert.equal(r.deltas.encounterReplace.active, false, "encounter ends on defeat");
  const vit = r.deltas.character.find((d) => d.path.join(".") === "resources.vitality.current");
  assert.equal(vit.value, 0);
  const cond = r.deltas.character.find((d) => d.path.join(".") === "conditions");
  assert.ok(cond.value.includes("downed"));
  assert.ok(r.facts.some((f) => /fallen|downed/i.test(f)));
});

await check("combat: a gambit attack pays the flat gambit XP", () => {
  const enc = { active: true, round: 1, enemies: [{ id: "g-1", name: "Gnasher", vitality: { current: 40, max: 40 }, guard: 12, atk: 0, damage: "1d4", xp: 5 }] };
  const c = fighter();
  c.xp = { current: 10, max: 100 };
  const r = resolveAttack({ actionType: "attack", target: "Gnasher", stat: "STR", gambit: { described: true, plausible: true } }, c, enc, RULES, makeRng(2), GM_BESTIARY);
  assert.ok(r.facts.some((f) => /gambit/i.test(f)));
  const xp = r.deltas.character.find((d) => d.path.join(".") === "xp.current");
  assert.equal(xp.value, 15, "+5 gambit XP");
});

await check("combat: flee ends an active encounter; no-op out of combat", () => {
  const enc = { active: true, round: 2, enemies: [{ id: "g-1", name: "Gnasher", vitality: { current: 5, max: 18 }, guard: 12, atk: 5, damage: "1d6", xp: 5 }] };
  assert.equal(resolveFlee(enc).deltas.encounterReplace.active, false);
  // through the dispatcher (resolve wraps the result):
  const wrapped = resolve({ actionType: "flee" }, fighter(), enc, RULES, makeRng(1), GM_BESTIARY);
  assert.equal(wrapped.deltas.encounterReplace.active, false);
  assert.equal(resolve({ actionType: "flee" }, fighter(), { active: false }, RULES, makeRng(1), GM_BESTIARY), null, "flee out of combat → freeform");
});

await check("apply: encounterReplace swaps the whole encounter", () => {
  const ws = { character: {}, encounter: { active: true, round: 3 } };
  applyDeltas(ws, { encounterReplace: { active: false } });
  assert.deepEqual(ws.encounter, { active: false });
});

console.log(failures === 0 ? "\nengine:test ALL PASS" : `\nengine:test FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
