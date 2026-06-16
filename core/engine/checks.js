// Skill/stat checks (design doc 02 §5; Solterra §3). d20 + stat (+ skill-rank
// bonus when a ranked skill applies) vs a difficulty DC; natural crit/fumble;
// advantage/disadvantage. A creative+plausible gambit (flagged by the referee)
// grants advantage and the flat gambit XP, win or lose. Pure + seedable.

import { rollDie, rollD20WithMode } from "./rng.js";
import { dcFor, rankBonus, critFumble } from "./rules.js";
import { awardXp } from "./progression.js";

const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

/**
 * @param {object} proposal - ActionProposal { stat, skill?, difficulty?, advantage?, disadvantage?, gambit?:{plausible} }
 * @param {object} character
 * @param {object} rules
 * @param {object} rng - seeded
 * @returns {{ rolls, facts, sections, deltas, summary }}
 */
export function resolveCheck(proposal, character, rules, rng) {
  const stat = String(proposal.stat ?? "").toUpperCase();
  const statVal = Number(character.stats?.[stat]) || 0;
  const skillName = String(proposal.skill ?? "").trim();
  const skill = (character.skills ?? []).find(
    (s) => String(s?.name ?? "").toLowerCase() === skillName.toLowerCase()
  );
  const rb = skill ? rankBonus(rules, skill.rank) : 0;
  const difficulty = String(proposal.difficulty ?? "tough").toLowerCase();
  const dc = dcFor(rules, difficulty);
  const { critOn, fumbleOn } = critFumble(rules);

  const gambitPlausible = proposal.gambit?.plausible === true;
  const mode = gambitPlausible || proposal.advantage
    ? "advantage"
    : proposal.disadvantage
      ? "disadvantage"
      : null;

  let nat;
  let diceLine;
  if (mode) {
    const r = rollD20WithMode(rng, mode);
    nat = r.kept;
    diceLine = `2d20(${r.dice.join("/")})→${nat}`;
  } else {
    nat = rollDie(rng, 20);
    diceLine = `d20(${nat})`;
  }

  const bonus = statVal + rb;
  const total = nat + bonus;
  const crit = nat >= critOn;
  const fumble = nat <= fumbleOn;
  const outcome = crit
    ? "critical success"
    : fumble
      ? "complication"
      : total >= dc
        ? "success"
        : "failure";

  const label = skillName || stat || "Check";
  const modStr = `${bonus >= 0 ? "+" : ""}${bonus}`;
  const line = `${diceLine}${modStr} = ${total} vs DC ${dc} — ${cap(outcome)}`;
  const facts = [`${label} check: ${line}`];
  const rolls = [
    { label, expr: `d20+${bonus}`, raw: nat, mods: bonus, total, vs: dc, outcome: outcome.includes("success") ? "success" : "failure", crit }
  ];
  // Normalized outcome rides the section so the renderer tints/cues from data,
  // not by re-parsing `line` (design doc 02 §6.2).
  const sectionOutcome = crit ? "crit" : outcome === "success" ? "success" : "fail";
  const sections = [{ type: "roll", title: label, lines: [line], outcome: sectionOutcome }];

  // Gambit pays whether the roll lands or not (the attempt is never punished).
  const deltas = { character: [] };
  if (gambitPlausible) {
    const award = awardXp(character, rules?.gambit?.xpAward ?? 5, rules);
    deltas.character.push(...award.deltas.character);
    facts.push(...award.facts.filter((f) => /XP|RANK/.test(f)));
  }

  return { rolls, facts, sections, deltas, summary: `${label}: ${outcome}.` };
}
