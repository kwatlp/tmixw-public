// Build the structured `character` object from validated answers (design doc
// 01 §7). Deterministic and offline: the ONLY model touchpoint is freeform
// grading (the Unique Power / custom entries), and that result is passed in —
// when it is absent the builder writes a deterministic Rank-E fallback so
// creation never blocks on the backend (design §6, §11).
//
// Answers are keyed by field id; select extras follow the `<id>__statChoice`,
// `<id>__statChoiceSecondary`, `<id>__subtype`, `<id>__skillChoice` convention
// that validateAnswers() enforces. Output is consumed by doc 02's engine and a
// future CHARACTER tab; `createdBy: "app-forge"` marks app-produced sheets.

import { computeDerived } from "./derive.js";
import { statNamesFromSpec, findField } from "./validate.js";

const DEFAULT_RESOURCE_POOLS = ["vitality", "stamina", "aether"];

/**
 * @param {object} spec - validated character_creation.json
 * @param {object} answers - validated player answers (keyed by field id)
 * @param {Record<string, object>} [graded] - freeform grading results by field id
 * @param {() => string} [now] - clock seam for deterministic tests
 * @returns {object} the structured character sheet
 */
export function buildCharacter(spec, answers, graded = {}, now = () => new Date().toISOString()) {
  const statNames = statNamesFromSpec(spec);
  const character = {
    schemaVersion: 1,
    createdBy: "app-forge",
    createdAt: now()
  };

  // Working accumulators applied by option effects.
  const statBonuses = Object.fromEntries(statNames.map((s) => [s, 0]));
  const grantedSkills = [];
  const grantedTraits = [];
  const inventory = [];
  const coin = {};

  // --- per-step / per-field assembly -------------------------------------
  for (const step of spec.steps ?? []) {
    for (const f of step.fields ?? []) {
      const v = answers[f.id];
      switch (f.type) {
        case "text":
        case "longtext":
          if (typeof v === "string" && v.trim()) character[f.id] = v.trim();
          break;
        case "single-select": {
          const opt = (f.options ?? []).find((o) => o.id === v);
          if (!opt) break;
          const node = { id: opt.id, label: opt.label ?? opt.id };
          if (Array.isArray(opt.subtypes) && opt.subtypes.length > 0) {
            const sub = opt.subtypes.find((s) => s.id === answers[`${f.id}__subtype`]);
            if (sub) {
              node.subtype = sub.id;
              node.label = sub.label ?? node.label;
              for (const g of sub.grants ?? []) grantedTraits.push(g);
            }
          }
          if (Array.isArray(opt.effects?.grants)) {
            node.grants = opt.effects.grants.slice();
            for (const g of opt.effects.grants) grantedTraits.push(g);
          }
          applyEffects(opt.effects, f.id, answers, { statBonuses, grantedSkills, inventory, coin });
          character[f.id] = node;
          break;
        }
        case "multi-select":
          if (Array.isArray(v)) for (const s of v) grantedSkills.push(s);
          break;
        case "freeform-graded":
          character[f.id] = graded[f.id] ?? fallbackGrade(f, v);
          break;
        // point-buy handled below (needs the full stat set)
      }
    }
  }

  // --- stats: base (point-buy) + option bonuses --------------------------
  const pbField = findField(spec, (f) => f.type === "point-buy");
  const statsBase = {};
  for (const s of statNames) statsBase[s] = Number(answers?.[pbField?.id]?.[s] ?? 0);
  const stats = {};
  for (const s of statNames) stats[s] = statsBase[s] + (statBonuses[s] ?? 0);
  character.statsBase = statsBase;
  character.stats = stats;

  // --- skills (deduped, stamped at the start rank) -----------------------
  const startRank = spec.start?.rank ?? "E";
  const seenSkill = new Set();
  character.skills = [];
  for (const name of grantedSkills) {
    const key = String(name).trim().toLowerCase();
    if (!key || seenSkill.has(key)) continue;
    seenSkill.add(key);
    character.skills.push({ name: String(name).trim(), rank: startRank });
  }

  // --- inventory + armor → derived → resources ---------------------------
  character.inventory = inventory;
  const armor = inventory
    .filter((it) => it.equipped)
    .reduce((sum, it) => sum + (Number(it.armor) || 0), 0);

  const derived = computeDerived(spec.derived ?? {}, { ...stats, armor });
  character.derived = derived;
  // Stamp the formulas so the sheet is self-describing — the interaction engine
  // (doc 02) recomputes derived values when stats/armor change without needing
  // the creation spec at runtime.
  if (spec.derived && Object.keys(spec.derived).length) {
    character.derivedFormulas = { ...spec.derived };
  }

  const pools = Array.isArray(spec.start?.resourcePools)
    ? spec.start.resourcePools
    : DEFAULT_RESOURCE_POOLS;
  character.resources = {};
  for (const pool of pools) {
    if (derived[pool] != null) {
      character.resources[pool] = { current: derived[pool], max: derived[pool] };
    }
  }

  // --- coin (option grants, then any start floor) ------------------------
  character.coin = { ...(spec.start?.coin ?? {}), ...coin };

  // --- start constants ---------------------------------------------------
  character.rank = startRank;
  if (spec.start?.rankLabel) character.rankLabel = spec.start.rankLabel;
  character.xp = { ...(spec.start?.xp ?? { current: 0, max: 100 }) };
  character.conditions = Array.isArray(spec.start?.conditions) ? spec.start.conditions.slice() : [];
  if (grantedTraits.length > 0) character.traits = dedupeStrings(grantedTraits);

  return character;
}

/** Apply a chosen option's `effects` into the working accumulators. */
function applyEffects(effects, fieldId, answers, acc) {
  if (!effects || typeof effects !== "object") return;
  // Flat stat mods.
  if (effects.stat && typeof effects.stat === "object") {
    for (const [stat, amt] of Object.entries(effects.stat)) {
      if (stat in acc.statBonuses) acc.statBonuses[stat] += Number(amt) || 0;
    }
  }
  // Player-chosen stat bonuses (primary + secondary).
  applyStatChoice(effects.statChoice, answers[`${fieldId}__statChoice`], acc.statBonuses);
  applyStatChoice(effects.statChoiceSecondary, answers[`${fieldId}__statChoiceSecondary`], acc.statBonuses);
  // Skills: flat grants + a player choice.
  if (effects.skillChoice && typeof effects.skillChoice === "object") {
    const pick = answers[`${fieldId}__skillChoice`];
    const picks = Array.isArray(pick) ? pick : pick ? [pick] : [];
    for (const p of picks) acc.grantedSkills.push(p);
  }
  // Items: stamped equipped so armor flows into Guard.
  for (const item of effects.grantItems ?? []) {
    acc.inventory.push({ ...item, equipped: item.equipped !== false });
  }
  // Coin.
  if (effects.coin && typeof effects.coin === "object") {
    for (const [k, amt] of Object.entries(effects.coin)) {
      acc.coin[k] = (acc.coin[k] ?? 0) + (Number(amt) || 0);
    }
  }
}

function applyStatChoice(rule, picks, statBonuses) {
  if (!rule || typeof rule !== "object") return;
  const amount = Number(rule.amount) || 0;
  const arr = Array.isArray(picks) ? picks : picks ? [picks] : [];
  for (const stat of arr) {
    if (stat in statBonuses) statBonuses[stat] += amount;
  }
}

/**
 * Deterministic Rank-E writeup when grading is unavailable (design §6, §11).
 * Exported so grade.js shares one fallback source — the builder itself never
 * imports the inference layer, keeping character construction pure/offline.
 */
export function fallbackGrade(field, text) {
  const shape = field.grade?.outputShape;
  if (shape === "unique_power" || field.id === "unique_power") {
    const concept = String(text ?? "").trim();
    return {
      name: concept ? firstWords(concept, 4) : "Untitled Power",
      reliable: concept
        ? `A modest, dependable expression of: ${concept}`
        : "A modest, dependable knack — useful, never scene-winning.",
      stretch: "With effort it can reach further, at a real cost.",
      cost: "10 STA",
      graded: false
    };
  }
  return { value: String(text ?? "").trim(), graded: false };
}

function firstWords(s, n) {
  return s.split(/\s+/).slice(0, n).join(" ");
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = String(s).trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(String(s).trim());
  }
  return out;
}
