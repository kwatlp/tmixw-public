// Rest / recovery resolver (design doc 02 §5; Solterra §8). Restores resource
// pools toward max by the fractions in rules.rest.recoverFraction. Pure: emits
// path-based deltas for the touched pools' `.current`.

/**
 * @param {object} character
 * @param {object} rules - resolved rules (rules.rest.recoverFraction)
 * @returns {{ deltas, facts, summary }}
 */
export function resolveRest(character, rules) {
  const fractions = rules?.rest?.recoverFraction ?? { stamina: 1, vitality: 0.25 };
  const res = character.resources ?? {};
  const deltas = { character: [] };
  const facts = [];
  for (const [pool, frac] of Object.entries(fractions)) {
    const p = res[pool];
    if (!p || typeof p !== "object") continue;
    const max = Number(p.max) || 0;
    const cur = Number(p.current) || 0;
    const restored = Math.min(max, Math.floor(cur + max * Number(frac)));
    if (restored !== cur) {
      deltas.character.push({ path: ["resources", pool, "current"], value: restored });
      facts.push(`${cap(pool)} ${cur} → ${restored}`);
    }
  }
  return {
    deltas,
    facts: facts.length ? facts : ["Rested — already at full."],
    summary: "You rest and recover."
  };
}

function cap(s) {
  return String(s).charAt(0).toUpperCase() + String(s).slice(1);
}
