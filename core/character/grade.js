// Freeform grading — the ONE LLM step in character creation (design doc 01 §6).
// The Unique Power (and custom races/skills) are creative, not numeric: a single
// constrained, low-temperature call grades the player's free text to the power
// band and returns a small JSON object. Isolated from narration — no world
// state, no streaming, no pipeline. On any failure (bad JSON twice, or the
// backend down) it falls back to the deterministic Rank-E writeup so creation
// never blocks on the model (design §11).

import { createInferenceAdapter, buildInferenceRuntimeConfig } from "../inference/index.js";
import { fallbackGrade } from "./build.js";

/** Low-temp, short generation — a grade is a few sentences of JSON, not prose. */
const GRADER_GEN = { max_length: 320, temperature: 0.3, top_p: 0.9, rep_pen: 1.05 };

const DEFAULT_BAND =
  "Rank E (the lowest, starting tier): modest and dependable. It must NOT be " +
  "able to win a major scene outright, end a fight in one stroke, or bend the " +
  "world. Reliable in small ways; the stretch use costs real effort.";

/** Brace-matched first JSON object (mirrors the extractor pipeline's parser). */
function extractJsonObject(text) {
  const s = String(text ?? "").trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return s.slice(start, i + 1);
  }
  return null;
}

function tryParse(raw) {
  const slice = extractJsonObject(raw);
  if (!slice) return null;
  try {
    const o = JSON.parse(slice);
    return o && typeof o === "object" && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

/** Coerce a parsed object to the field's declared output shape; null if it can't. */
function shapeResult(field, parsed) {
  if (!parsed) return null;
  const shape = field?.grade?.outputShape ?? (field?.id === "unique_power" ? "unique_power" : null);
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  if (shape === "unique_power") {
    const name = str(parsed.name);
    const reliable = str(parsed.reliable);
    const stretch = str(parsed.stretch);
    if (!name || !reliable || !stretch) return null;
    return { name, reliable, stretch, cost: str(parsed.cost) || "10 STA" };
  }
  // Generic shape: accept a { value } or a single string-ish payload.
  const value = str(parsed.value);
  return value ? { value } : null;
}

function buildGraderPrompt(field, text, band) {
  const shape = field?.grade?.outputShape ?? (field?.id === "unique_power" ? "unique_power" : "value");
  const schema =
    shape === "unique_power"
      ? '{ "name": string, "reliable": string (one sentence — the dependable use), "stretch": string (one sentence — the costly reach), "cost": string (e.g. "10 STA" or "5 AET") }'
      : '{ "value": string }';
  return [
    "You are grading a player's creative idea for a solo fantasy RPG, fitting it to a power band.",
    `POWER BAND: ${band}`,
    `PLAYER'S IDEA:\n${String(text ?? "").trim()}`,
    `Reply with ONLY one JSON object, no markdown or commentary, matching:\n${schema}`,
    "Keep it within the band — name it, give a reliable use and a costly stretch use."
  ].join("\n\n");
}

/**
 * Grade one freeform field. Always resolves to a usable object: a graded result
 * (`graded: true`) or the deterministic fallback (`graded: false`).
 * @param {object} field - the freeform-graded spec field
 * @param {string} text - the player's free text
 * @param {object} [opts]
 * @param {(prompt: string, gen: object) => Promise<string>} [opts.generate] - injectable for tests
 * @param {object} [opts.inferenceConfig] - resolved inference runtime config (default: koboldcpp)
 * @param {string} [opts.band] - power-band description
 * @returns {Promise<object>}
 */
export async function gradeFreeform(field, text, opts = {}) {
  if (!String(text ?? "").trim()) return fallbackGrade(field, text);
  const generate = opts.generate ?? defaultGenerate(opts.inferenceConfig);
  const band = opts.band ?? DEFAULT_BAND;
  const base = buildGraderPrompt(field, text, band);

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nYour previous reply was not valid JSON. Reply with ONLY the JSON object.`;
    let raw;
    try {
      raw = await generate(prompt, GRADER_GEN);
    } catch {
      break; // backend unreachable — stop retrying, fall back
    }
    const shaped = shapeResult(field, tryParse(raw));
    if (shaped) return { ...shaped, graded: true };
  }
  return fallbackGrade(field, text);
}

function defaultGenerate(inferenceConfig) {
  const adapter = createInferenceAdapter(inferenceConfig ?? buildInferenceRuntimeConfig({}));
  return (prompt, gen) => adapter.generate(prompt, gen);
}
