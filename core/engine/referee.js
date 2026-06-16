// Referee intent pass (design doc 02 §3.1, §7). A single constrained, low-temp
// inference call that maps freeform prose → a structured ActionProposal. The
// referee PROPOSES (what stat/skill, how hard, was it a clever gambit); it never
// resolves — the engine rolls and applies. Brace-matched JSON parse + one retry,
// then a safe `freeform` fallback, so a confused model just degrades to plain
// narration. `generate` is injectable for tests.

const REFEREE_GEN = { max_length: 200, temperature: 0.2, top_p: 0.9, rep_pen: 1.05 };

const ACTION_TYPES = new Set(["check", "attack", "freeform"]);
const DIFFICULTIES = new Set(["routine", "tough", "severe", "heroic"]);

export const REFEREE_SYSTEM = [
  "You are the REFEREE for a solo fantasy RPG. Read the player's action and classify it as JSON.",
  "If the player strikes, shoots, or otherwise attacks a creature, return an ATTACK with the target creature's name. If it is a meaningful non-combat attempt that could fail in an interesting way (leaping a gap, sneaking past a guard, forcing a door, persuading someone), return a CHECK. If it is pure talk, looking around, or trivial movement, return freeform.",
  "When the player is IN COMBAT, almost every action is an attack (or a gambit) — prefer ATTACK unless they clearly disengage.",
  "Schema:",
  '{ "actionType": "check" | "attack" | "freeform", "target": <creature name, for attack>, "stat": <one of the STATS>, "skill": <one of the SKILLS, or omit>, "difficulty": "routine"|"tough"|"severe"|"heroic", "gambit": { "described": boolean, "plausible": boolean } }',
  "Pick the single most relevant stat.",
  "DIFFICULTY — be generous; most actions are routine or tough:",
  "- routine: simple but failable (a short jump, climbing a ladder, a normal door).",
  "- tough: the default for an ordinary adventuring action (vaulting a chasm, sneaking past one guard, forcing a stuck door).",
  "- severe: genuinely hard (a long leap with a bad landing, slipping past many guards).",
  "- heroic: ONLY near-impossible, last-ditch feats. Almost never for ordinary movement.",
  "GAMBIT — gambit.plausible is true ONLY when the action cleverly and specifically uses the environment, an item, or a power to gain an edge. A plain jump, climb, or attack is NOT a gambit (set both false).",
  "Reply with ONLY the JSON object — no prose, no code fences."
].join("\n");

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

/** Parse + normalize a referee reply to an ActionProposal, or null if unparseable. */
export function parseProposal(raw) {
  const slice = extractJsonObject(raw);
  if (!slice) return null;
  let o;
  try {
    o = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const type = ACTION_TYPES.has(o.actionType) ? o.actionType : "freeform";
  if (type === "freeform") return { actionType: "freeform" };

  if (type === "attack") {
    const p = { actionType: "attack" };
    if (o.target) p.target = String(o.target).trim();
    if (o.stat) p.stat = String(o.stat).toUpperCase();
    if (o.gambit && typeof o.gambit === "object") {
      p.gambit = { described: !!o.gambit.described, plausible: !!o.gambit.plausible };
    }
    return p;
  }

  const p = { actionType: "check" };
  if (o.stat) p.stat = String(o.stat).toUpperCase();
  if (o.skill) p.skill = String(o.skill);
  p.difficulty = DIFFICULTIES.has(String(o.difficulty).toLowerCase())
    ? String(o.difficulty).toLowerCase()
    : "tough";
  if (o.gambit && typeof o.gambit === "object") {
    p.gambit = { described: !!o.gambit.described, plausible: !!o.gambit.plausible };
  }
  // A check needs a stat to resolve; without one, fall back to narration.
  if (!p.stat) return { actionType: "freeform" };
  return p;
}

export function buildRefereePrompt(text, ctx) {
  const stats = ctx?.stats ? Object.keys(ctx.stats).join(", ") : "STR, AGI, CON, INT, CHA, WIL";
  const skills = (ctx?.skills ?? []).map((s) => s.name).filter(Boolean).join(", ") || "(none)";
  return [
    ctx?.system ?? REFEREE_SYSTEM,
    `STATS: ${stats}`,
    `SKILLS: ${skills}`,
    ctx?.inEncounter ? "The player is currently IN COMBAT." : "",
    `PLAYER ACTION:\n${String(text ?? "").trim()}`
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * @param {string} text
 * @param {object} ctx - { stats, skills, inEncounter, system }
 * @param {(prompt: string, gen: object) => Promise<string>} generate
 * @returns {Promise<object>} ActionProposal (never throws)
 */
export async function runReferee(text, ctx, generate) {
  const base = buildRefereePrompt(text, ctx);
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? base : `${base}\n\nReply with ONLY the JSON object.`;
    let raw;
    try {
      raw = await generate(prompt, REFEREE_GEN);
    } catch {
      break;
    }
    const proposal = parseProposal(raw);
    if (proposal) return proposal;
  }
  return { actionType: "freeform" };
}

/**
 * Cheap pre-filter so pure-narration turns never pay for a referee call. Only
 * action-ish prose (or being in combat) triggers the model pass.
 */
const ACTION_CUES = /\b(attack|strike|hit|stab|slash|shoot|fire|loose|swing|throw|hurl|leap|jump|vault|climb|scale|sneak|creep|hide|dodge|parry|block|dash|charge|grapple|grab|shove|push|kick|force|pry|break|smash|pick|disarm|cast|conjure|persuade|convince|intimidate|threaten|bluff|deceive|sprint|swim|balance|dive|tackle|wrestle|duck|roll|aim|lunge|feint|disrupt|sabotage|check|save|examine|inspect|investigate|search|decipher|recall|study|appraise|identify|sense|perceive|track|disable|sabotage|haggle|sneak|steal|lockpick|strength|agility|wisdom|intelligence|charisma|constitution|endurance|prowess)\b/i;
export function looksLikeAction(text, inEncounter) {
  if (inEncounter) return true;
  return ACTION_CUES.test(String(text ?? ""));
}
