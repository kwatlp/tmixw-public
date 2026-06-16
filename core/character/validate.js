// Creation-spec + answer validation (design doc 01 §4, §8). Mirrors the
// hand-rolled, every-error-at-once style of validateManifest() in
// core/story_templates.js — authors and the renderer both get one round trip.
//
// validateCreationSpec() guards the template data shape; validateAnswers() is
// the server-authoritative check the renderer's client-side validation only
// mirrors for responsiveness (design §9: characterCreate re-validates here).

import { evaluateFormula } from "./derive.js";

const FIELD_TYPES = new Set([
  "text",
  "longtext",
  "single-select",
  "multi-select",
  "point-buy",
  "freeform-graded"
]);

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v.trim() !== "";

/**
 * Structural validation of a parsed character_creation.json.
 * @param {unknown} spec
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateCreationSpec(spec) {
  const errors = [];
  if (!isObj(spec)) return { ok: false, errors: ["spec must be a JSON object"] };

  if (spec.schemaVersion !== 1) errors.push("schemaVersion must be the integer 1");
  if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
    errors.push("steps must be a non-empty array");
  } else {
    const stepIds = new Set();
    spec.steps.forEach((step, si) => {
      const at = `steps[${si}]`;
      if (!isObj(step)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (!isStr(step.id)) errors.push(`${at}.id must be a non-empty string`);
      else if (stepIds.has(step.id)) errors.push(`${at}.id "${step.id}" is duplicated`);
      else stepIds.add(step.id);
      if (!Array.isArray(step.fields) || step.fields.length === 0) {
        errors.push(`${at}.fields must be a non-empty array`);
        return;
      }
      step.fields.forEach((f, fi) => validateField(f, `${at}.fields[${fi}]`, errors));
    });
  }

  if (spec.derived != null) {
    if (!isObj(spec.derived)) errors.push("derived must be an object of formula strings");
    else {
      for (const [k, expr] of Object.entries(spec.derived)) {
        if (typeof expr !== "string") {
          errors.push(`derived.${k} must be a formula string`);
          continue;
        }
        // Compile-check the formula with all-zero variables: catches syntax
        // and unknown-identifier errors at load, not at character build.
        try {
          const zeros = {};
          for (const s of statNamesFromSpec(spec)) zeros[s] = 0;
          zeros.armor = 0;
          for (const prior of Object.keys(spec.derived)) zeros[prior] = 0;
          evaluateFormula(expr, zeros);
        } catch (e) {
          errors.push(`derived.${k}: ${e.message}`);
        }
      }
    }
  }

  if (spec.start != null && !isObj(spec.start)) errors.push("start must be an object");

  return { ok: errors.length === 0, errors };
}

function validateField(f, at, errors) {
  if (!isObj(f)) {
    errors.push(`${at} must be an object`);
    return;
  }
  if (!isStr(f.id)) errors.push(`${at}.id must be a non-empty string`);
  if (!FIELD_TYPES.has(f.type)) {
    errors.push(`${at}.type "${f.type}" is not a known field type`);
    return;
  }
  if (f.type === "single-select") {
    if (!Array.isArray(f.options) || f.options.length === 0) {
      errors.push(`${at}.options must be a non-empty array`);
    } else {
      f.options.forEach((o, oi) => {
        if (!isObj(o) || !isStr(o.id)) errors.push(`${at}.options[${oi}].id must be a non-empty string`);
      });
    }
  } else if (f.type === "multi-select") {
    if (!Array.isArray(f.options) || f.options.length === 0) {
      errors.push(`${at}.options must be a non-empty array`);
    }
    if (!Number.isInteger(f.count) || f.count < 1) errors.push(`${at}.count must be a positive integer`);
  } else if (f.type === "point-buy") {
    if (!Number.isInteger(f.pool) || f.pool < 1) errors.push(`${at}.pool must be a positive integer`);
    if (!Array.isArray(f.stats) || f.stats.length === 0) errors.push(`${at}.stats must be a non-empty array`);
    if (f.min != null && !Number.isInteger(f.min)) errors.push(`${at}.min must be an integer`);
    if (f.max != null && !Number.isInteger(f.max)) errors.push(`${at}.max must be an integer`);
    if (Number.isInteger(f.min) && Number.isInteger(f.max) && f.min > f.max) {
      errors.push(`${at}.min must not exceed max`);
    }
  }
}

/** The point-buy stat list — derived formulas reference these names. */
export function statNamesFromSpec(spec) {
  for (const step of spec?.steps ?? []) {
    for (const f of step?.fields ?? []) {
      if (f?.type === "point-buy" && Array.isArray(f.stats)) return f.stats.slice();
    }
  }
  return [];
}

/** Find the first field of a given type (helper for the renderer/builder). */
export function findField(spec, predicate) {
  for (const step of spec?.steps ?? []) {
    for (const f of step?.fields ?? []) {
      if (predicate(f)) return f;
    }
  }
  return null;
}

/**
 * Server-authoritative validation of player answers against the spec.
 * Answers are keyed by field id; select extras use the `<id>__statChoice`,
 * `<id>__statChoiceSecondary`, `<id>__subtype`, `<id>__skillChoice` convention.
 * @param {object} spec
 * @param {object} answers
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateAnswers(spec, answers) {
  const errors = [];
  if (!isObj(spec)) return { ok: false, errors: ["spec must be an object"] };
  if (!isObj(answers)) return { ok: false, errors: ["answers must be an object"] };

  for (const step of spec.steps ?? []) {
    for (const f of step.fields ?? []) {
      const v = answers[f.id];
      const required = f.required === true;

      if (f.type === "text" || f.type === "longtext" || f.type === "freeform-graded") {
        const s = typeof v === "string" ? v : "";
        if (required && !s.trim()) errors.push(`${f.id} is required`);
        if (Number.isInteger(f.maxLen) && s.length > f.maxLen) {
          errors.push(`${f.id} exceeds maxLen ${f.maxLen}`);
        }
      } else if (f.type === "single-select") {
        if (v == null || v === "") {
          if (required) errors.push(`${f.id} is required`);
          continue;
        }
        const opt = (f.options ?? []).find((o) => o.id === v);
        if (!opt) {
          errors.push(`${f.id}="${v}" is not one of the offered options`);
          continue;
        }
        validateSelectExtras(f, opt, answers, errors);
      } else if (f.type === "multi-select") {
        const arr = Array.isArray(v) ? v : [];
        if (arr.length !== f.count) {
          errors.push(`${f.id} must select exactly ${f.count} (got ${arr.length})`);
        }
        const allowCustom = f.allowCustom?.enabled === true;
        if (!allowCustom) {
          const opts = new Set(f.options ?? []);
          for (const choice of arr) {
            if (!opts.has(choice)) errors.push(`${f.id}: "${choice}" is not an offered option`);
          }
        }
        if (new Set(arr).size !== arr.length) errors.push(`${f.id} has duplicate selections`);
      } else if (f.type === "point-buy") {
        validatePointBuy(f, v, errors);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function validateSelectExtras(f, opt, answers, errors) {
  const eff = opt.effects ?? {};
  if (isObj(eff.statChoice)) {
    const picks = answers[`${f.id}__statChoice`];
    checkStatChoice(eff.statChoice, picks, `${f.id}__statChoice`, errors);
  }
  if (isObj(eff.statChoiceSecondary)) {
    const picks = answers[`${f.id}__statChoiceSecondary`];
    checkStatChoice(eff.statChoiceSecondary, picks, `${f.id}__statChoiceSecondary`, errors);
  }
  if (isObj(eff.skillChoice)) {
    const pick = answers[`${f.id}__skillChoice`];
    const from = Array.isArray(eff.skillChoice.from) ? eff.skillChoice.from : null;
    const count = Number.isInteger(eff.skillChoice.count) ? eff.skillChoice.count : 1;
    const picks = Array.isArray(pick) ? pick : pick ? [pick] : [];
    if (picks.length !== count) errors.push(`${f.id}__skillChoice must pick ${count}`);
    if (from) for (const p of picks) if (!from.includes(p)) errors.push(`${f.id}__skillChoice: "${p}" not allowed`);
  }
  if (Array.isArray(opt.subtypes) && opt.subtypes.length > 0) {
    const sub = answers[`${f.id}__subtype`];
    if (!opt.subtypes.some((s) => s.id === sub)) {
      errors.push(`${f.id}__subtype must be one of ${opt.subtypes.map((s) => s.id).join(", ")}`);
    }
  }
}

function checkStatChoice(rule, picks, label, errors) {
  const count = Number.isInteger(rule.count) ? rule.count : 1;
  const arr = Array.isArray(picks) ? picks : picks ? [picks] : [];
  if (arr.length !== count) errors.push(`${label} must pick exactly ${count} stat(s)`);
  if (Array.isArray(rule.from)) {
    for (const p of arr) if (!rule.from.includes(p)) errors.push(`${label}: "${p}" not allowed`);
  }
}

function validatePointBuy(f, v, errors) {
  if (!isObj(v)) {
    errors.push(`${f.id} must be a { STAT: number } object`);
    return;
  }
  const min = Number.isInteger(f.min) ? f.min : 0;
  const max = Number.isInteger(f.max) ? f.max : Infinity;
  let sum = 0;
  for (const stat of f.stats ?? []) {
    const n = v[stat];
    if (!Number.isInteger(n)) {
      errors.push(`${f.id}.${stat} must be an integer`);
      continue;
    }
    if (n < min || n > max) errors.push(`${f.id}.${stat}=${n} is outside [${min}, ${max}]`);
    sum += n;
  }
  for (const key of Object.keys(v)) {
    if (!(f.stats ?? []).includes(key)) errors.push(`${f.id} has unexpected stat "${key}"`);
  }
  if (f.spendAllRequired !== false && sum !== f.pool) {
    errors.push(`${f.id} must spend exactly ${f.pool} points (spent ${sum})`);
  } else if (sum > f.pool) {
    errors.push(`${f.id} overspends the ${f.pool}-point pool (spent ${sum})`);
  }
}
