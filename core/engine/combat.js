// Combat resolution (design doc 02 §4, Phase 4). One full round per turn: the
// player attacks, every living enemy retaliates, the round advances, and the
// engine checks for victory (award XP) or defeat (downed). Enemies are minted
// from the GM bestiary stat blocks. Traits/Flaws ride along as text for the
// narrator — the engine never parses them (confirmed scope). Pure + seedable.

import { rollDie, rollExpr, rollDamageExpr, rollD20WithMode } from "./rng.js";
import { rankBonus, critFumble } from "./rules.js";
import { awardXp } from "./progression.js";

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const toInt = (v, d = 0) => {
  const n = parseInt(String(v ?? "").replace(/[^\d\-]/g, ""), 10);
  return Number.isFinite(n) ? n : d;
};

/** Fuzzy-match a creature name against the GM bestiary (name, then family). */
function findCreature(gmBestiary, name) {
  const q = String(name ?? "").trim().toLowerCase();
  const list = Array.isArray(gmBestiary) ? gmBestiary : [];
  if (!q) return null;
  return (
    list.find((c) => String(c?.name ?? "").toLowerCase() === q) ||
    list.find((c) => String(c?.name ?? "").toLowerCase().includes(q)) ||
    list.find((c) => q.includes(String(c?.name ?? "").toLowerCase()) && c?.name) ||
    list.find((c) => String(c?.family ?? "").toLowerCase() === q) ||
    null
  );
}

/** Low end of a "S (2–4)" group string, capped so rounds stay sane. Default 1. */
function packSize(typicalGroup) {
  const m = /\((\d+)/.exec(String(typicalGroup ?? ""));
  return Math.min(3, Math.max(1, m ? parseInt(m[1], 10) : 1));
}

function mintEnemy(creature, idx) {
  const vit = toInt(creature.vit, 8);
  const slug = String(creature.name ?? "foe").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: `${slug || "foe"}-${idx + 1}`,
    name: String(creature.name ?? "Foe"),
    rank: String(creature.rank ?? ""),
    vitality: { current: vit, max: vit },
    guard: toInt(creature.guard, 12),
    atk: toInt(creature.atk, 2),
    damage: String(creature.damage ?? "1d6"),
    traits: creature.trait ? [String(creature.trait)] : [],
    flaw: String(creature.flaw ?? ""),
    xp: toInt(creature.xp, 5),
    instanceOf: String(creature.name ?? "")
  };
}

/** Build a fresh encounter for a target name from the bestiary (or a generic foe). */
export function startEncounter(target, gmBestiary, _rng) {
  const creature = findCreature(gmBestiary, target);
  const count = creature ? packSize(creature.typicalGroup) : 1;
  const base = creature ?? { name: target || "Foe", vit: "20", guard: "12", atk: "+3", damage: "1d6", xp: "5" };
  const enemies = Array.from({ length: count }, (_, i) => mintEnemy(base, i));
  return { active: true, round: 1, canvas: [], enemies };
}

const living = (enemies) => enemies.filter((e) => e.vitality.current > 0);

/** Player's equipped weapon die (inventory slot "weapon"), default unarmed d4. */
function weaponDie(character) {
  const w = (character.inventory ?? []).find((it) => it.equipped && it.slot === "weapon");
  return String(w?.damage ?? "d4");
}

/**
 * Resolve one combat round (design doc 02 §4). Starts the encounter on the first
 * attack out of combat.
 * @returns {{ deltas, facts, sections, rolls, summary }}
 */
export function resolveAttack(proposal, character, encounter, rules, rng, gmBestiary) {
  let enc = encounter?.active ? clone(encounter) : startEncounter(proposal.target, gmBestiary, rng);
  const facts = [];
  // Structured blow-by-blow (text + side) so the renderer styles from data,
  // never by re-parsing these display strings (design doc 02 §6.2).
  const combatEvents = [];
  const rolls = [];
  if (!encounter?.active) {
    const names = enc.enemies.map((e) => e.name);
    facts.push(`Combat begins — ${names.length > 1 ? `${names.length}× ${names[0]}` : names[0]}`);
  }

  const { critOn, fumbleOn } = critFumble(rules);
  const stat = String(proposal.stat ?? "STR").toUpperCase();
  const statVal = Number(character.stats?.[stat]) || 0;
  const skill = (character.skills ?? []).find(
    (s) => String(s?.name ?? "").toLowerCase() === String(proposal.skill ?? "").toLowerCase()
  );
  const rb = skill ? rankBonus(rules, skill.rank) : 0;
  const gambit = proposal.gambit?.plausible === true;

  // --- player attack on the first living enemy (preferring the named target) ---
  const targets = living(enc.enemies);
  const target =
    targets.find((e) => e.name.toLowerCase() === String(proposal.target ?? "").toLowerCase()) || targets[0];

  let attackLine = "";
  let attackOutcome = null;
  if (target) {
    let nat;
    let diceLine;
    if (gambit || proposal.advantage) {
      const r = rollD20WithMode(rng, "advantage");
      nat = r.kept;
      diceLine = `2d20(${r.dice.join("/")})→${nat}`;
    } else {
      nat = rollDie(rng, 20);
      diceLine = `d20(${nat})`;
    }
    const bonus = statVal + rb;
    const total = nat + bonus;
    const crit = nat >= critOn;
    const hit = crit || (nat > fumbleOn && total >= target.guard);
    rolls.push({ label: "Attack", raw: nat, mods: bonus, total, vs: target.guard, outcome: hit ? "hit" : "miss", crit });
    attackLine = `${diceLine}+${bonus} = ${total} vs Guard ${target.guard} — ${crit ? "Critical hit" : hit ? "Hit" : "Miss"}`;
    attackOutcome = crit ? "crit" : hit ? "success" : "fail";
    facts.push(`Attack: ${attackLine}`);

    if (hit) {
      const wd = rollDamageExpr(rng, weaponDie(character), { doubleDice: crit });
      const gambitDmg = gambit ? rollExpr(rng, "1d6").total : 0;
      const dmg = Math.max(1, wd.total + Math.floor(statVal / 2) + gambitDmg);
      target.vitality.current = Math.max(0, target.vitality.current - dmg);
      const slain = target.vitality.current === 0;
      facts.push(`${dmg} damage to ${target.name}${slain ? " — slain" : ` (${target.vitality.current}/${target.vitality.max})`}`);
      combatEvents.push({ text: `You hit ${target.name} for ${dmg}${slain ? " (slain)" : ""}`, tone: "deal", slain });
    } else {
      combatEvents.push({ text: `You miss ${target.name}`, tone: "miss" });
    }
  }

  // --- enemy turns vs the player's Guard ---
  const playerGuard = Number(character.derived?.guard) || 10;
  let playerVit = Number(character.resources?.vitality?.current) || 0;
  for (const e of living(enc.enemies)) {
    const nat = rollDie(rng, 20);
    const total = nat + e.atk;
    const hit = nat > fumbleOn && total >= playerGuard;
    if (hit) {
      const dmg = rollDamageExpr(rng, e.damage).total;
      playerVit = Math.max(0, playerVit - dmg);
      facts.push(`${e.name} hits you for ${dmg}`);
      combatEvents.push({ text: `${e.name} hits you for ${dmg}`, tone: "take" });
    } else {
      combatEvents.push({ text: `${e.name} misses`, tone: "miss" });
    }
  }

  enc.round = (Number(enc.round) || 1) + 1;

  // --- round end: victory / defeat / ongoing ---------------------------------
  const deltas = { character: [] };
  deltas.character.push({ path: ["resources", "vitality", "current"], value: playerVit });

  const aliveAfter = living(enc.enemies);
  const defeated = playerVit <= 0;
  const victory = !defeated && aliveAfter.length === 0;

  // XP: gambit pays immediately; victory pays the slain enemies' XP.
  const gambitXp = gambit ? Number(rules?.gambit?.xpAward) || 5 : 0;
  const victoryXp = victory ? enc.enemies.reduce((s, e) => s + (Number(e.xp) || 0), 0) : 0;
  const totalXp = gambitXp + victoryXp;
  if (gambitXp) facts.push(`+${gambitXp} XP (gambit)`);
  if (victoryXp) facts.push(`+${victoryXp} XP`);
  if (totalXp > 0) {
    // Award against the post-damage player so a rank-up heal is computed correctly.
    const tmp = { ...character, resources: { ...character.resources, vitality: { ...(character.resources?.vitality ?? {}), current: playerVit } } };
    const award = awardXp(tmp, totalXp, rules);
    deltas.character.push(...award.deltas.character);
    for (const f of award.facts) if (/RANK/.test(f)) facts.push(f);
  }

  let summary;
  if (defeated) {
    enc = { active: false };
    deltas.encounterReplace = enc;
    const conds = Array.isArray(character.conditions) ? [...character.conditions] : [];
    if (!conds.includes("downed")) conds.push("downed");
    deltas.character.push({ path: ["conditions"], value: conds });
    facts.push("You have fallen (0 VIT) — downed.");
    summary = "You are downed.";
  } else if (victory) {
    enc = { active: false };
    deltas.encounterReplace = enc;
    facts.push("Victory — all enemies down.");
    summary = "The fight is won.";
  } else {
    deltas.encounterReplace = enc;
    summary = "The fight goes on.";
  }

  const sections = [];
  if (attackLine) sections.push({ type: "roll", title: "Attack", lines: [attackLine], outcome: attackOutcome });
  sections.push({ type: "combat", title: "Round", events: combatEvents });
  if (aliveAfter.length > 0 && !defeated) {
    sections.push({
      type: "enemies",
      title: "Enemies",
      enemies: enc.enemies.map((e) => ({
        name: e.name,
        cur: e.vitality.current,
        max: e.vitality.max,
        slain: e.vitality.current === 0
      }))
    });
  }

  return { deltas, facts, sections, rolls, summary };
}

/** Disengage from combat — ends the encounter, no XP. */
export function resolveFlee(encounter) {
  if (!encounter?.active) return { notFound: true };
  return {
    deltas: { encounterReplace: { active: false } },
    facts: ["You break off and flee the fight."],
    sections: [],
    summary: "You flee."
  };
}
