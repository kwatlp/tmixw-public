// Inventory resolvers (design doc 02 §5): equip/unequip (recompute Guard via the
// shared derived evaluator) and use/consume. Pure: each returns path-based deltas
// + human facts/sections; nothing is mutated until COMMIT (apply.js).

import { computeDerived } from "../character/derive.js";

/** Case-insensitive item match: exact name, else substring. */
function findItem(inventory, name) {
  const q = String(name ?? "").trim().toLowerCase();
  if (!q) return -1;
  const inv = Array.isArray(inventory) ? inventory : [];
  let idx = inv.findIndex((it) => String(it?.name ?? "").trim().toLowerCase() === q);
  if (idx < 0) idx = inv.findIndex((it) => String(it?.name ?? "").toLowerCase().includes(q));
  return idx;
}

/** Sum armor of equipped items (mirrors build.js). */
function equippedArmor(inventory) {
  return (inventory ?? [])
    .filter((it) => it.equipped)
    .reduce((sum, it) => sum + (Number(it.armor) || 0), 0);
}

/**
 * Equip or unequip an item. Recomputes `derived` (Guard ← armor) when the sheet
 * carries its formulas. Returns null when the item isn't found (caller degrades
 * to a freeform turn).
 * @returns {{ deltas, facts, sections, summary } | { notFound: true, item }}
 */
export function resolveEquip(character, itemName, equip) {
  const inv = (character.inventory ?? []).map((it) => ({ ...it }));
  const idx = findItem(inv, itemName);
  if (idx < 0) return { notFound: true, item: itemName };

  const item = inv[idx];
  const already = item.equipped === true;
  if (equip === already) {
    return {
      noop: true,
      item: item.name,
      summary: `${item.name} is already ${equip ? "equipped" : "unequipped"}.`
    };
  }
  inv[idx] = { ...item, equipped: equip };

  const deltas = { character: [{ path: ["inventory"], value: inv }] };
  const facts = [`${equip ? "Equipped" : "Unequipped"} ${item.name}`];

  // Recompute derived only if the sheet is self-describing (app-forge).
  if (character.derivedFormulas && character.stats) {
    const armor = equippedArmor(inv);
    const derived = computeDerived(character.derivedFormulas, { ...character.stats, armor });
    deltas.character.push({ path: ["derived"], value: derived });
    if (character.derived?.guard != null && derived.guard !== character.derived.guard) {
      facts.push(`Guard ${character.derived.guard} → ${derived.guard}`);
    }
  }
  return {
    deltas,
    facts,
    summary: `${item.name} ${equip ? "readied" : "stowed"}.`
  };
}

/**
 * Use/consume an item: decrement `qty` (or remove when it hits 0). Item effects
 * (heal, buff) are deferred — this is the deterministic consume + a fact the
 * narrator weaves in.
 */
export function resolveUse(character, itemName) {
  const inv = (character.inventory ?? []).map((it) => ({ ...it }));
  const idx = findItem(inv, itemName);
  if (idx < 0) return { notFound: true, item: itemName };
  const item = inv[idx];
  const qty = Number.isInteger(item.qty) ? item.qty : 1;
  if (qty <= 1) inv.splice(idx, 1);
  else inv[idx] = { ...item, qty: qty - 1 };
  return {
    deltas: { character: [{ path: ["inventory"], value: inv }] },
    facts: [`Used ${item.name}${qty > 1 ? ` (${qty - 1} left)` : ""}`],
    summary: `${item.name} used.`
  };
}
