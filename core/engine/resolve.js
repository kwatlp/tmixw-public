// Resolution dispatcher (design doc 02 §3.2, §5). Takes an ActionProposal +
// current state + rules + a seeded RNG and produces a ResolutionResult: the
// engine→everything contract carrying rolls, do-not-alter narration facts,
// path-based deltas (applied on COMMIT), and the labeled sections the app
// renders. Pure and deterministic — same inputs + seed ⇒ same result.

import { applyDeltas, buildStatusSection } from "./apply.js";
import { resolveEquip, resolveUse } from "./inventory.js";
import { resolveRest } from "./recovery.js";
import { resolveCheck } from "./checks.js";
import { resolveAttack, resolveFlee } from "./combat.js";

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** actionTypes that carry no mechanics — a plain narration turn (no deltas). */
export function isFreeform(actionType) {
  return !actionType || actionType === "freeform";
}

/**
 * @param {object} proposal - ActionProposal
 * @param {object} character - world_state.character
 * @param {object} encounter - world_state.encounter
 * @param {object} rules - resolved rules
 * @param {{ seed: number }} rng - seeded RNG
 * @param {object[]|null} [gmBestiary] - GM creature stat blocks (combat enemy source)
 * @returns {object|null} ResolutionResult, or null for freeform (no mechanics)
 */
export function resolve(proposal, character, encounter, rules, rng, gmBestiary = null) {
  const actionType = proposal?.actionType;
  if (isFreeform(actionType)) return null;

  let out;
  switch (actionType) {
    case "equip":
      out = resolveEquip(character, proposal.item, true);
      break;
    case "unequip":
      out = resolveEquip(character, proposal.item, false);
      break;
    case "use":
      out = resolveUse(character, proposal.item);
      break;
    case "rest":
      out = resolveRest(character, rules);
      break;
    case "check":
      out = resolveCheck(proposal, character, rules, rng);
      break;
    case "attack":
      out = resolveAttack(proposal, character, encounter, rules, rng, gmBestiary);
      break;
    case "flee":
      out = resolveFlee(encounter);
      break;
    default:
      return null; // unknown → freeform
  }

  // A command that found no target (e.g. "equip the moon") degrades to freeform.
  if (out?.notFound) return null;

  const deltas = out.deltas ?? { character: [] };
  const facts = out.facts ?? [];

  // Status reflects the POST-action projected state (the same deltas commit on
  // accept), so what the player reads matches what lands.
  const projected = clone(character);
  applyDeltas({ character: projected, encounter: clone(encounter) }, deltas);

  // Resolver-provided sections (roll, loot) first, then the projected status.
  const sections = [...(out.sections ?? [])];
  sections.push(buildStatusSection(projected));

  const result = {
    actionType,
    seed: rng?.seed ?? null,
    rolls: out.rolls ?? [],
    narration: { summary: out.summary ?? "", facts },
    deltas,
    sections,
    public: { actionType, facts, rolls: out.rolls ?? [], sections }
  };
  return result;
}

/**
 * The RESOLVED MECHANICS directive (design doc 02 §6.1) — injected into the
 * narration prompt so the model narrates the engine's outcomes as final and
 * never prints its own numbers.
 * @param {object} result - ResolutionResult
 * @returns {string}
 */
export function renderMechanicsDirective(result) {
  if (!result || (result.narration?.facts ?? []).length === 0) return "";
  const facts = result.narration.facts.map((f) => `- ${f}`).join("\n");
  return [
    "[RESOLVED MECHANICS — the engine has ALREADY rolled the dice; the outcomes",
    " below are FINAL. This SUPERSEDES the resolution/combat rules in your manual:",
    " for THIS turn do NOT roll, do NOT compute, and do NOT print any number, roll",
    " line, \"Resolving mechanics\" block, STATUS line, battle line, or XP — the",
    " interface renders all of that. Narrate the outcomes below EXACTLY as they",
    " stand: a Failure is a failure, a success is a success. Contradicting or",
    " inventing a number is a hard error.]",
    facts,
    "Write prose only. Weave in the facts above; invent no other mechanical results."
  ].join("\n");
}
