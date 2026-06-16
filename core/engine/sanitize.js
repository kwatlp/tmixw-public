// Strip stray mechanical output from narration (design doc 02 §8). A weak local
// model often ignores the do-not-print directive and prints its own status
// blocks, XP lines, stat-sheet dumps, fabricated section headers, and ⟦…⟧
// markers — frequently with numbers that CONTRADICT the engine. The app renders
// the authoritative numbers as sections, so we drop the model's versions from
// the prose before display. Conservative: only whole lines that are clearly
// mechanical, plus inline ⟦…⟧ spans.

// Tested line-by-line after dropping a leading run of emphasis/quote/list markers.
const MECH_LINE = [
  /^§\s*\d/, // "§17 ..." hallucinated section numbering
  /^\d+\s*[·.)\-]\s+[A-Z]/, // "17 · QUEST WRAP-UP" heading-shaped numbered line
  /\b(VIT|STA|AET|HP|MP|GUARD)\b\s*\d+\s*\/\s*\d+/i, // status block: VIT 65/65
  /^(STR|AGI|CON|INT|CHA|WIL)\s+\d+\s*$/i, // bare stat line in a sheet dump
  /^XP\s*(reward|gain|update|:)/i, // "XP reward: +1 XP"
  /^[+\-]\d+\s*XP\b/i, // "+1 XP"
  /^(status update|skill slots?|rank|coins?|inventory|coin)\s*[:.]/i, // sheet labels
  /^(quest wrap-?up|quest completed|end of session|first sandbox)\b/i, // hallucinated GM section titles
  /^(guard|vit|sta|aet|hp|mp|vitality|stamina|aether)\s+\d+\s*$/i, // bare "Guard 16" pool line
  /^[A-Za-z][\w'’ -]{0,20}\s+\d+\s*\/\s*\d+\s*$/, // bare "Alpha 21/30" enemy-HP dump line
  /\bvs\.?\s*DC\s*\d+/i, // model-printed check result: "...= 32 vs DC 25 — Success"
  /^rolling\b.*\bd\d/i, // "Rolling 2d20: ..."
  /\b\d*d20\b/i, // any line reciting a d20 roll — the app renders the real one
  /that'?s a gambit\b/i, // referee-speak leaking into prose ("that's a gambit, take Advantage")
  /\bvs\.?\s*guard\s*\d+/i // model-printed attack result: "... vs Guard 13 — Hit"
];

// Markdown heading lines (## §18 ...). The narration should not contain headers;
// they're the manual's territory, recited by a confused model.
const MD_HEADING = /^\s{0,3}#{1,6}\s+\S/;

function isMechanicalLine(line) {
  if (MD_HEADING.test(line)) return true;
  // Drop a leading run of emphasis/quote/list markers, then test.
  const t = line.replace(/^[\s*_>#-]+/, "").trim();
  if (!t) return false;
  return MECH_LINE.some((re) => re.test(t));
}

/**
 * Remove model-printed mechanical noise from a narration string. Pure.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeNarration(text) {
  let s = String(text ?? "");
  if (!s.trim()) return s;
  // Inline app-style markers the model mimics — the renderer adds the real ones.
  s = s.replace(/⟦[^⟧]*⟧/g, "");
  const kept = s.split(/\r?\n/).filter((line) => !isMechanicalLine(line));
  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n") // collapse the gaps left by removed lines
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
