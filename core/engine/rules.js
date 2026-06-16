// Rules tables for the interaction engine (design doc 02 §4.3). The
// machine-readable twin of a template's narrator prose (Solterra §3–§4): the
// engine computes from `rules.json`; the prose only explains feel. Referenced
// from the manifest under `gm.rulesFile`; resolved through the same sandbox as
// every other template file. Absent ⇒ DEFAULT_RULES (the engine still runs).

import fs from "node:fs";
import { resolveTemplateFile } from "../story_templates.js";

/** Engine defaults — also the merge base, so a partial rules.json is safe. */
export const DEFAULT_RULES = Object.freeze({
  schemaVersion: 1,
  resolution: {
    die: "d20",
    dcByDifficulty: { routine: 14, tough: 18, severe: 22, heroic: 26 },
    rankBonus: { E: 1, D: 2, C: 3, B: 4, A: 5, S: 6 },
    critOn: 20,
    fumbleOn: 1
  },
  damage: { formula: "weaponDie + floor(stat/2)", dice: { light: "d6", standard: "d8", heavy: "d12" } },
  gambit: { xpAward: 5, options: ["advantage", "+1d6", "ignoreGuard", "rider"] },
  // ratios expressed in the base unit (smallest).
  currency: { units: ["gc", "ss", "cb"], ratiosToBase: { gc: 200, ss: 10, cb: 1 } },
  progression: {
    rankOrder: ["E", "D", "C", "B", "A", "S"],
    xpToNextByRank: { E: 100, D: 150, C: 225, B: 340, A: 500 },
    awards: { mook: 5, elite: 12, boss: 25, quest: 25, gambit: 5, discovery: 10 },
    rankUp: { vitMax: 10, staMax: 5, aetMax: 5, statPoints: 2, healFraction: 0.5 }
  },
  rest: { recoverFraction: { stamina: 1, vitality: 0.25 } },
  regenerateRerolls: false
});

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge a partial rules object over DEFAULT_RULES (objects only; arrays replace). */
function mergeRules(base, over) {
  if (!isObj(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k === "__proto__" || k === "constructor") continue;
    out[k] = isObj(v) && isObj(out[k]) ? mergeRules(out[k], v) : v;
  }
  return out;
}

/**
 * Structural validation of a parsed rules.json. Permissive — anything absent
 * falls back to DEFAULT_RULES — but type violations are reported.
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRules(rules) {
  const errors = [];
  if (!isObj(rules)) return { ok: false, errors: ["rules must be a JSON object"] };
  if (rules.schemaVersion != null && rules.schemaVersion !== 1) {
    errors.push("schemaVersion must be the integer 1");
  }
  const r = rules.resolution;
  if (r != null) {
    if (!isObj(r)) errors.push("resolution must be an object");
    else {
      if (r.dcByDifficulty != null && !isObj(r.dcByDifficulty)) errors.push("resolution.dcByDifficulty must be an object");
      if (r.rankBonus != null && !isObj(r.rankBonus)) errors.push("resolution.rankBonus must be an object");
      if (r.critOn != null && !Number.isInteger(r.critOn)) errors.push("resolution.critOn must be an integer");
      if (r.fumbleOn != null && !Number.isInteger(r.fumbleOn)) errors.push("resolution.fumbleOn must be an integer");
    }
  }
  if (rules.currency != null && rules.currency.ratiosToBase != null && !isObj(rules.currency.ratiosToBase)) {
    errors.push("currency.ratiosToBase must be an object");
  }
  if (rules.progression != null && rules.progression.xpToNextByRank != null && !isObj(rules.progression.xpToNextByRank)) {
    errors.push("progression.xpToNextByRank must be an object");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Load + validate a template's rules, merged over DEFAULT_RULES. Non-fatal:
 * any problem (no reference, escape, bad JSON, failed validation) returns
 * DEFAULT_RULES with a warning, so the engine always has a usable table.
 * @returns {object} the resolved rules
 */
export function loadRules(templateDir, manifest) {
  const rel = manifest?.gm?.rulesFile;
  if (typeof rel !== "string" || !rel.trim()) return DEFAULT_RULES;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolveTemplateFile(templateDir, rel), "utf8"));
  } catch (err) {
    console.warn(`[engine] rules.json not loadable — using defaults (${err.message})`);
    return DEFAULT_RULES;
  }
  const v = validateRules(parsed);
  if (!v.ok) {
    console.warn(`[engine] rules.json failed validation — using defaults:\n  - ${v.errors.join("\n  - ")}`);
    return DEFAULT_RULES;
  }
  return mergeRules(DEFAULT_RULES, parsed);
}

// --- typed accessors (tolerate a bare/partial rules object) -----------------

export function dcFor(rules, difficulty) {
  const t = rules?.resolution?.dcByDifficulty ?? DEFAULT_RULES.resolution.dcByDifficulty;
  return Number(t[String(difficulty ?? "").toLowerCase()] ?? t.tough ?? 18);
}

export function rankBonus(rules, rank) {
  const t = rules?.resolution?.rankBonus ?? DEFAULT_RULES.resolution.rankBonus;
  return Number(t[String(rank ?? "").toUpperCase()] ?? 0);
}

export function damageDie(rules, weight) {
  const t = rules?.damage?.dice ?? DEFAULT_RULES.damage.dice;
  return t[String(weight ?? "standard").toLowerCase()] ?? t.standard ?? "d8";
}

export function coinRatios(rules) {
  return rules?.currency?.ratiosToBase ?? DEFAULT_RULES.currency.ratiosToBase;
}

export function xpToNext(rules, rank) {
  const t = rules?.progression?.xpToNextByRank ?? DEFAULT_RULES.progression.xpToNextByRank;
  const v = t[String(rank ?? "").toUpperCase()];
  return v == null ? null : Number(v); // null = no further rank (capped)
}

export function nextRank(rules, rank) {
  const order = rules?.progression?.rankOrder ?? DEFAULT_RULES.progression.rankOrder;
  const i = order.indexOf(String(rank ?? "").toUpperCase());
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}

export function critFumble(rules) {
  const r = rules?.resolution ?? DEFAULT_RULES.resolution;
  return { critOn: Number(r.critOn ?? 20), fumbleOn: Number(r.fumbleOn ?? 1) };
}
