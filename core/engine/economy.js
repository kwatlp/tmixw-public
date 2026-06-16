// Coin arithmetic across denominations (design doc 02 §5). Built + tested now;
// wired to buy/sell once a shop catalog exists (loot/sell already use it). All
// math runs in the smallest base unit, then re-decomposes greedily so a sheet
// never shows 23 SS when it should read 1 GC 3 SS.

import { coinRatios } from "./rules.js";

/** Total value of a coin object in the base (smallest) unit. */
export function toBase(coin, rules) {
  const ratios = coinRatios(rules);
  let total = 0;
  for (const [unit, ratio] of Object.entries(ratios)) {
    total += (Number(coin?.[unit]) || 0) * Number(ratio);
  }
  return total;
}

/** Decompose a base amount back into the largest-first denominations. */
export function fromBase(amount, rules) {
  const ratios = coinRatios(rules);
  // largest ratio first
  const units = Object.entries(ratios).sort((a, b) => b[1] - a[1]);
  let rem = Math.max(0, Math.floor(amount));
  const out = {};
  for (const [unit, ratio] of units) {
    out[unit] = Math.floor(rem / ratio);
    rem -= out[unit] * ratio;
  }
  return out;
}

export function canAfford(coin, costBase, rules) {
  return toBase(coin, rules) >= Math.max(0, Math.floor(costBase));
}

/** Spend `costBase` → new normalized coin, or null when unaffordable. */
export function spend(coin, costBase, rules) {
  const have = toBase(coin, rules);
  const cost = Math.max(0, Math.floor(costBase));
  if (have < cost) return null;
  return fromBase(have - cost, rules);
}

/** Add `amountBase` → new normalized coin. */
export function gain(coin, amountBase, rules) {
  return fromBase(toBase(coin, rules) + Math.max(0, Math.floor(amountBase)), rules);
}
