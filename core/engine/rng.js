// Seedable PRNG for the interaction engine (design doc 02 §5). Every random
// draw in a turn goes through one of these so that, given the same proposal +
// state + seed, resolve() is a pure function — replayable and golden-testable.
// mulberry32: tiny, fast, good-enough distribution for dice; NOT cryptographic.

/**
 * @param {number} [seed] - 32-bit seed; omit for a time-based one (logged on the result).
 * @returns {{ seed: number, next: () => number, int: (n: number) => number }}
 *   next() → float in [0,1); int(n) → integer in [0,n).
 */
export function makeRng(seed) {
  const s0 = (Number.isFinite(seed) ? seed >>> 0 : (Date.now() ^ (Math.random() * 0x100000000)) >>> 0);
  let a = s0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed: s0,
    next,
    int: (n) => Math.floor(next() * Math.max(1, Math.floor(n)))
  };
}

/** Roll one die with `sides` faces → 1..sides. */
export function rollDie(rng, sides) {
  const n = Math.max(1, Math.floor(sides));
  return rng.int(n) + 1;
}

/** Roll `count` dice of `sides` → { total, dice[] }. */
export function rollDice(rng, count, sides) {
  const dice = [];
  let total = 0;
  for (let i = 0; i < Math.max(0, Math.floor(count)); i++) {
    const r = rollDie(rng, sides);
    dice.push(r);
    total += r;
  }
  return { total, dice };
}

/** "d8", "2d6", "d20" → { count, sides }. Defaults to 1dN; null on garbage. */
export function parseDice(expr) {
  const m = /^\s*(\d*)d(\d+)\s*$/i.exec(String(expr ?? ""));
  if (!m) return null;
  return { count: m[1] ? Math.max(1, parseInt(m[1], 10)) : 1, sides: parseInt(m[2], 10) };
}

/** Roll a dice expression string ("2d6", "d20"). Returns 0 on a bad expr. */
export function rollExpr(rng, expr) {
  const p = parseDice(expr);
  if (!p) return { total: 0, dice: [] };
  return rollDice(rng, p.count, p.sides);
}

/**
 * Roll a damage expression with an optional flat modifier ("1d6+3", "2d8-1",
 * "d4"). The plain `parseDice` drops the +K; combat needs it.
 * @returns {{ total: number, dice: number[], flat: number }}
 */
export function rollDamageExpr(rng, expr, { doubleDice = false } = {}) {
  const m = /^\s*(\d*)d(\d+)\s*([+\-]\s*\d+)?\s*$/i.exec(String(expr ?? ""));
  if (!m) {
    // A bare number is flat damage; anything else is zero.
    const n = Number(String(expr ?? "").trim());
    return Number.isFinite(n) ? { total: Math.max(0, Math.floor(n)), dice: [], flat: Math.floor(n) } : { total: 0, dice: [], flat: 0 };
  }
  let count = m[1] ? Math.max(1, parseInt(m[1], 10)) : 1;
  if (doubleDice) count *= 2; // crit
  const sides = parseInt(m[2], 10);
  const flat = m[3] ? parseInt(m[3].replace(/\s+/g, ""), 10) : 0;
  const { total: rolled, dice } = rollDice(rng, count, sides);
  return { total: Math.max(0, rolled + flat), dice, flat };
}

/**
 * 2d20, keeping the higher (advantage) or lower (disadvantage) die.
 * @returns {{ kept: number, dice: [number, number], mode: "advantage"|"disadvantage" }}
 */
export function rollD20WithMode(rng, mode) {
  const a = rollDie(rng, 20);
  const b = rollDie(rng, 20);
  const kept = mode === "disadvantage" ? Math.min(a, b) : Math.max(a, b);
  return { kept, dice: [a, b], mode };
}
