// Intent classification (design doc 02 §3.1, §7). Turns a player message into a
// structured ActionProposal. Two tiers:
//   - Fast path (here): unambiguous commands matched by grammar, zero model calls.
//   - Referee path (Phase 3): a constrained LLM call for freeform actions.
// Anything unmatched ⇒ { actionType: "freeform" } — a plain narration turn with
// no mechanics, identical to today.

const FAST_PATTERNS = [
  [/^(?:equip|wield|wear|don|ready)\s+(.+)$/i, (m) => ({ actionType: "equip", item: m[1].trim() })],
  [/^(?:unequip|unwield|remove|sheathe|doff|stow|put away)\s+(.+)$/i, (m) => ({ actionType: "unequip", item: m[1].trim() })],
  [/^(?:use|drink|quaff|consume|eat|apply)\s+(.+)$/i, (m) => ({ actionType: "use", item: m[1].trim() })],
  [/^(?:rest|make camp|set up camp|short rest|long rest|sleep|take a rest|camp)\b.*$/i, () => ({ actionType: "rest" })],
  [/^(?:flee|run away|retreat|disengage|escape the fight|break off)\b.*$/i, () => ({ actionType: "flee" })]
];

/** Synchronous fast-path classifier; returns a proposal or null (no match). */
export function classifyFastPath(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  for (const [re, build] of FAST_PATTERNS) {
    const m = re.exec(t);
    if (m) return { ...build(m), raw: t };
  }
  return null;
}

/**
 * Classify a player message. Phase 2: fast path then `freeform`. Phase 3 adds a
 * referee LLM pass (via `ctx.referee`) for unmatched freeform that looks like a
 * check/action. Always resolves to a proposal; never throws.
 * @param {string} text
 * @param {{ referee?: (text: string) => Promise<object|null> }} [ctx]
 * @returns {Promise<object>} ActionProposal
 */
export async function classifyIntent(text, ctx = {}) {
  const fast = classifyFastPath(text);
  if (fast) return fast;
  if (typeof ctx.referee === "function") {
    try {
      const proposal = await ctx.referee(String(text ?? ""));
      if (proposal && typeof proposal === "object" && proposal.actionType) {
        return { ...proposal, raw: String(text ?? "").trim() };
      }
    } catch {
      /* fall through to freeform */
    }
  }
  return { actionType: "freeform", raw: String(text ?? "").trim() };
}
