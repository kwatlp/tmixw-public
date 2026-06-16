// XP awards + rank-up detection (design doc 02 §5; Solterra §7). Deterministic:
// awards XP, and on crossing the threshold advances the rank, carries the
// excess, raises resource maxima, and heals — the automatic half of the "ding".
// The player-choice half (stat points to place, skill raise, Awakening) is
// flagged on the result for the narrator/UI; the engine never picks for them.

import { xpToNext, nextRank } from "./rules.js";

/**
 * @param {object} character
 * @param {number} amount - XP to award
 * @param {object} rules
 * @returns {{ deltas, facts, rankUps: object[] }}
 */
export function awardXp(character, amount, rules) {
  const deltas = { character: [] };
  const facts = [];
  const rankUps = [];
  const add = Math.max(0, Math.floor(Number(amount) || 0));
  if (add === 0) return { deltas, facts, rankUps };

  let rank = String(character.rank ?? "").toUpperCase();
  let current = (Number(character.xp?.current) || 0) + add;
  let max = Number(character.xp?.max) || 0;
  facts.push(`+${add} XP`);

  // Resource maxima accumulate across multiple level-ups in one award.
  const maxBumps = { vitality: 0, stamina: 0, aether: 0 };
  const cfg = rules?.progression?.rankUp ?? {};

  // Cross as many thresholds as the award allows (rare, but correct).
  let guard = 0;
  while (max > 0 && current >= max && nextRank(rules, rank) && guard++ < 10) {
    current -= max;
    const newRank = nextRank(rules, rank);
    maxBumps.vitality += Number(cfg.vitMax) || 0;
    maxBumps.stamina += Number(cfg.staMax) || 0;
    maxBumps.aether += Number(cfg.aetMax) || 0;
    rankUps.push({ from: rank, to: newRank, statPoints: Number(cfg.statPoints) || 0 });
    facts.push(`RANK UP: ${rank} → ${newRank}`);
    rank = newRank;
    const nx = xpToNext(rules, rank);
    max = nx == null ? 0 : nx; // capped at top rank
  }

  if (rankUps.length > 0) {
    deltas.character.push({ path: ["rank"], value: rank });
    deltas.character.push({ path: ["xp", "current"], value: current });
    deltas.character.push({ path: ["xp", "max"], value: max });
    applyRankUpResources(character, maxBumps, cfg, deltas, facts);
  } else {
    deltas.character.push({ path: ["xp", "current"], value: current });
  }
  return { deltas, facts, rankUps };
}

/** Raise resource maxima, then heal by healFraction of the NEW max (the ding). */
function applyRankUpResources(character, maxBumps, cfg, deltas, facts) {
  const heal = Number(cfg.healFraction) || 0;
  const res = character.resources ?? {};
  for (const [pool, bump] of Object.entries(maxBumps)) {
    const p = res[pool];
    if (!p || typeof p !== "object") continue;
    const newMax = (Number(p.max) || 0) + bump;
    const healed = Math.min(newMax, (Number(p.current) || 0) + Math.floor(newMax * heal));
    deltas.character.push({ path: ["resources", pool, "max"], value: newMax });
    deltas.character.push({ path: ["resources", pool, "current"], value: healed });
  }
  if (heal > 0) facts.push(`Restored ${Math.round(heal * 100)}% of pools`);
}
