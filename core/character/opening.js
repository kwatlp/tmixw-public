// Narrator handoff for app-forged characters (design doc 01 §10, Phase 4).
// Once the app has written a structured sheet, the opening narration must
// CONFIRM it, never CREATE it: the model is handed the finished numbers and
// told to welcome the player, render STATUS from those exact values, and open
// the first scene. Because the sheet is supplied and final, the truncation /
// fabrication failures the legacy prose forge hit drop to near zero.

/** Render the structured sheet as compact, model-friendly text. */
export function renderSheetForPrompt(character) {
  const c = character ?? {};
  const lines = [];
  const name = c.name || "(unnamed)";
  lines.push(`Name: ${name}${c.pronouns ? ` (${c.pronouns})` : ""}`);
  if (c.race) lines.push(`Race: ${labelOf(c.race)}`);
  if (c.origin) lines.push(`Origin: ${labelOf(c.origin)}`);
  const rank = [c.rank, c.rankLabel ? `(${c.rankLabel})` : ""].filter(Boolean).join(" ");
  const xp = c.xp ? ` · XP ${c.xp.current ?? 0}/${c.xp.max ?? 0}` : "";
  if (rank || xp) lines.push(`Rank: ${rank}${xp}`);
  if (c.stats) lines.push(`Stats: ${Object.entries(c.stats).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
  if (c.derived) lines.push(renderDerivedLine(c.derived, c.resources));
  if (Array.isArray(c.skills) && c.skills.length) {
    lines.push(`Skills: ${c.skills.map((s) => `${s.name} (${s.rank})`).join(", ")}`);
  }
  if (c.unique_power?.name) {
    const p = c.unique_power;
    lines.push(
      `Unique Power — ${p.name}: ${p.reliable ?? ""}` +
        (p.stretch ? ` Stretch: ${p.stretch}` : "") +
        (p.cost ? ` Cost: ${p.cost}.` : "")
    );
  }
  if (Array.isArray(c.traits) && c.traits.length) lines.push(`Traits: ${c.traits.join(", ")}`);
  if (c.coin && Object.keys(c.coin).length) {
    lines.push(`Coin: ${Object.entries(c.coin).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(", ")}`);
  }
  if (Array.isArray(c.inventory) && c.inventory.length) {
    lines.push(
      `Inventory: ${c.inventory.map((it) => `${it.name}${it.equipped ? " (equipped)" : ""}`).join(", ")}`
    );
  }
  return lines.join("\n");
}

function labelOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const sub = v.label && v.id && v.label !== v.id ? `${v.label}` : v.label || v.id;
    return sub || "";
  }
  return "";
}

function renderDerivedLine(derived, resources) {
  const parts = [];
  for (const [k, v] of Object.entries(derived)) {
    const pool = resources?.[k];
    const label = k.charAt(0).toUpperCase() + k.slice(1);
    parts.push(pool ? `${label} ${pool.current}/${pool.max}` : `${label} ${v}`);
  }
  return parts.join(" · ");
}

/**
 * Build the opening directive for an app-forged world: the finished sheet plus
 * the template's opening hint plus the do-not-alter guardrails.
 * @param {object} character - the structured world_state.character
 * @param {string} [openingHint] - template's post-creation opening instruction
 * @returns {string}
 */
export function buildConfirmOpeningDirective(character, openingHint) {
  const sheet = renderSheetForPrompt(character);
  const hint =
    String(openingHint ?? "").trim() ||
    "Welcome the player in-fiction, confirm their character, render a STATUS block from the exact numbers above, and open the first scene.";
  return [
    "SYSTEM — CHARACTER ALREADY CREATED. The player just finished the app's Character Forge. Their sheet is complete and FINAL. This instruction SUPERSEDES any 'Session Start' / Character Forge steps in your manual: skip the forge entirely.",
    "THE PLAYER'S CHARACTER SHEET (use these exact values):",
    sheet,
    hint,
    "HARD RULES for this opening message:\n" +
      "- Use the EXACT name, stats, skills, items, power, and coin above. Address the player by their real name, never \"Traveler\" or a placeholder.\n" +
      "- When you render the STATUS block, fill it with the real values above. NEVER output bracketed or angled placeholders like [Name], [Race], <Traveler>, or [show sheet] — write the actual data.\n" +
      "- Do NOT invent, re-roll, rename, or change any value. Do NOT ask any creation questions or present a forge — creation is done.\n" +
      "- Confirm the sheet, then move into the world."
  ].join("\n\n");
}
