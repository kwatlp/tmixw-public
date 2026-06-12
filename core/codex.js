/**
 * Codex metadata (schema v4, v0.8.4) — the persisted overlay that turns the
 * existing world-state collections into the three-tab Entry/Group/Field view.
 * The collections (character/npcs/quests/lorebook/scenes/chapters/beats)
 * remain the storage of record; this module only manages the `ws.codex`
 * block (groups, membership, order, provenance, isNew, extraFields) and the
 * by-id write paths the renderer uses.
 *
 * Pure data ops on a loaded world state — callers save and emit.
 */

export const CODEX_TABS = ["story", "cast", "world"];

/** Built-in group ids are fixed strings; they are not stored in `codex.groups`. */
export const BUILTIN_GROUP_IDS = {
  story: ["story:threads", "story:chronicle"],
  cast: ["cast:you", "cast:ungrouped"],
  world: ["world:ungrouped"]
};

let _nextEntryId = Date.now();

/** @param {string} prefix - "npc" | "quest" | "lore" | "grp" */
export function genEntryId(prefix) {
  return `${prefix}_${(_nextEntryId++).toString(36)}`;
}

/** Normalize/initialize `ws.codex` in place and return it. */
export function ensureCodex(ws) {
  if (!ws.codex || typeof ws.codex !== "object" || Array.isArray(ws.codex)) {
    ws.codex = {};
  }
  const cx = ws.codex;
  if (!Array.isArray(cx.groups)) cx.groups = [];
  cx.groups = cx.groups.filter(
    (g) =>
      g &&
      typeof g === "object" &&
      typeof g.id === "string" &&
      CODEX_TABS.includes(g.tab)
  );
  for (const key of ["membership", "groupOrder", "prov", "isNew", "extraFields"]) {
    if (!cx[key] || typeof cx[key] !== "object" || Array.isArray(cx[key])) {
      cx[key] = {};
    }
  }
  return cx;
}

/** Stamp who last wrote a field. Deleting a field should delete its stamp instead. */
export function stampProv(ws, entryId, fieldKey, prov) {
  if (prov !== "ai" && prov !== "you") return;
  const cx = ensureCodex(ws);
  if (!cx.prov[entryId]) cx.prov[entryId] = {};
  cx.prov[entryId][fieldKey] = prov;
}

/** Which tab an entry belongs to, from its id shape. */
export function entryTab(entryId) {
  const id = String(entryId ?? "");
  if (id === "pc" || id.startsWith("npc_")) return "cast";
  if (id.startsWith("quest_")) return "story";
  if (id.startsWith("lore_")) return "world";
  if (id.startsWith("beat_") || id.startsWith("scene_") || id.startsWith("chap_")) {
    return "story";
  }
  return null;
}

/** True for chronicle records (chapters/scenes/beats) — edits route through core/memory.js semantics. */
export function isChronicleEntryId(entryId) {
  const id = String(entryId ?? "");
  return id.startsWith("beat_") || id.startsWith("scene_") || id.startsWith("chap_");
}

/**
 * Resolve an entry id to its backing record.
 * @returns {{ kind: "character"|"npc"|"quest"|"lore"|"chronicle", record: object|null } | null}
 */
export function codexResolveEntry(ws, entryId) {
  const id = String(entryId ?? "");
  if (id === "pc") return { kind: "character", record: ws.character };
  if (id.startsWith("npc_")) {
    return { kind: "npc", record: (ws.npcs ?? []).find((r) => r?.id === id) ?? null };
  }
  if (id.startsWith("quest_")) {
    return { kind: "quest", record: (ws.quests ?? []).find((r) => r?.id === id) ?? null };
  }
  if (id.startsWith("lore_")) {
    return { kind: "lore", record: (ws.lorebook ?? []).find((r) => r?.id === id) ?? null };
  }
  if (isChronicleEntryId(id)) {
    const record =
      (ws.chapters ?? []).find((r) => r?.id === id) ??
      (ws.scenes ?? []).find((r) => r?.id === id) ??
      (ws.session_beats ?? []).find((r) => r?.id === id) ??
      null;
    return { kind: "chronicle", record };
  }
  return null;
}

function badKey(key) {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function keywordsFromValue(value) {
  if (Array.isArray(value)) {
    return value.map((k) => String(k ?? "").trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

function upsertExtraField(cx, entryId, fieldKey, value) {
  if (!Array.isArray(cx.extraFields[entryId])) cx.extraFields[entryId] = [];
  const list = cx.extraFields[entryId];
  const existing = list.find((f) => f.key === fieldKey);
  if (existing) existing.value = String(value ?? "");
  else list.push({ key: fieldKey, label: fieldKey, value: String(value ?? "") });
}

/**
 * Player edit of one field, routed by entry id. Chronicle ids are NOT handled
 * here — the IPC layer routes them through the memory-edit path (which owns
 * stale-marking) and stamps provenance via {@link stampProv}.
 *
 * `$name` is the sentinel field key for the entry's display name
 * (character.name / npc.name / quest.title / lore.title).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function codexEditField(ws, entryId, fieldKey, value) {
  const key = String(fieldKey ?? "").trim();
  if (!key || badKey(key)) return { ok: false, reason: "bad field key" };
  const resolved = codexResolveEntry(ws, entryId);
  if (!resolved) return { ok: false, reason: "unknown entry id" };
  if (resolved.kind === "chronicle") {
    return { ok: false, reason: "chronicle edits route through memory:edit" };
  }
  if (resolved.kind !== "character" && !resolved.record) {
    return { ok: false, reason: "entry not found" };
  }
  const cx = ensureCodex(ws);

  if (resolved.kind === "character") {
    const k = key === "$name" ? "name" : key;
    if (badKey(k)) return { ok: false, reason: "bad field key" };
    ws.character[k] = typeof value === "string" ? value : value ?? "";
    stampProv(ws, "pc", k, "you");
  } else if (resolved.kind === "npc" || resolved.kind === "quest") {
    const record = resolved.record;
    const nameKey = resolved.kind === "npc" ? "name" : "title";
    const k = key === "$name" ? nameKey : key;
    if (badKey(k)) return { ok: false, reason: "bad field key" };
    if (k === nameKey) {
      const name = String(value ?? "").trim();
      if (!name) return { ok: false, reason: "name cannot be empty" };
      record[nameKey] = name;
    } else {
      record[k] = typeof value === "string" ? value : value ?? "";
      stampProv(ws, entryId, k, "you");
    }
  } else if (resolved.kind === "lore") {
    const record = resolved.record;
    if (key === "$name" || key === "title") {
      const title = String(value ?? "").trim();
      if (!title) return { ok: false, reason: "title cannot be empty" };
      record.title = title;
    } else if (key === "content") {
      record.content = String(value ?? "");
      stampProv(ws, entryId, "content", "you");
    } else if (key === "keywords") {
      record.keywords = keywordsFromValue(value);
      stampProv(ws, entryId, "keywords", "you");
    } else {
      // Fixed-shape record (normalizeLorebook strips extras) — display-only overlay.
      upsertExtraField(cx, entryId, key, value);
      stampProv(ws, entryId, key, "you");
    }
  }

  // Touching an entry is a decision — the draft marker clears.
  delete cx.isNew[entryId];
  return { ok: true };
}

/**
 * `+ Add field`: append an empty player-authored field and return its key so
 * the UI can open it in edit mode. Character/npc/quest records tolerate
 * arbitrary keys (and stay visible to the narrator/extractor); lore uses the
 * extraFields overlay.
 * @returns {{ ok: boolean, fieldKey?: string, reason?: string }}
 */
export function codexAddField(ws, entryId, label = "note") {
  const resolved = codexResolveEntry(ws, entryId);
  if (!resolved) return { ok: false, reason: "unknown entry id" };
  if (resolved.kind === "chronicle") {
    return { ok: false, reason: "chronicle cards do not take custom fields" };
  }
  if (resolved.kind !== "character" && !resolved.record) {
    return { ok: false, reason: "entry not found" };
  }
  const cx = ensureCodex(ws);
  const base =
    String(label ?? "note")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9 _-]/g, "")
      .replace(/\s+/g, "_") || "note";
  if (badKey(base)) return { ok: false, reason: "bad field key" };

  const record = resolved.kind === "character" ? ws.character : resolved.record;
  const taken = (k) => {
    if (resolved.kind === "lore") {
      if (k === "title" || k === "content" || k === "keywords") return true;
      return (cx.extraFields[entryId] ?? []).some((f) => f.key === k);
    }
    return k in record;
  };
  let fieldKey = base;
  for (let i = 2; taken(fieldKey); i++) fieldKey = `${base}_${i}`;

  if (resolved.kind === "lore") {
    upsertExtraField(cx, entryId, fieldKey, "");
  } else {
    record[fieldKey] = "";
  }
  stampProv(ws, resolved.kind === "character" ? "pc" : entryId, fieldKey, "you");
  delete cx.isNew[entryId];
  return { ok: true, fieldKey };
}

/** Keep a co-author draft: accept silently, clear the marker. */
export function codexKeepEntry(ws, entryId) {
  const cx = ensureCodex(ws);
  delete cx.isNew[entryId];
  return { ok: true };
}

function findGroup(cx, groupId) {
  return cx.groups.find((g) => g.id === groupId) ?? null;
}

function groupTab(groupId, cx) {
  for (const tab of CODEX_TABS) {
    if (BUILTIN_GROUP_IDS[tab].includes(groupId)) return tab;
  }
  return findGroup(cx, groupId)?.tab ?? null;
}

function removeFromAllOrders(cx, entryId) {
  for (const gid of Object.keys(cx.groupOrder)) {
    const order = cx.groupOrder[gid];
    const idx = order.indexOf(entryId);
    if (idx >= 0) order.splice(idx, 1);
    if (order.length === 0) delete cx.groupOrder[gid];
  }
}

/**
 * Move an entry to a group (membership override + optional insertion index).
 * Constraints (also enforced in the UI): within-tab only; the player
 * character never leaves "cast:you"; chronicle records never leave
 * "story:chronicle" (reorder via `toGroupId === "story:chronicle"` is allowed).
 * @returns {{ ok: boolean, reason?: string }}
 */
export function codexMoveEntry(ws, entryId, toGroupId, index = null) {
  const cx = ensureCodex(ws);
  const tab = entryTab(entryId);
  if (!tab) return { ok: false, reason: "unknown entry id" };
  const targetTab = groupTab(toGroupId, cx);
  if (!targetTab) return { ok: false, reason: "unknown group" };
  if (targetTab !== tab) return { ok: false, reason: "cross-tab move" };
  if (entryId === "pc" && toGroupId !== "cast:you") {
    return { ok: false, reason: "the player character stays in You" };
  }
  if (isChronicleEntryId(entryId) && toGroupId !== "story:chronicle") {
    return { ok: false, reason: "chronicle entries stay in Chronicle" };
  }

  removeFromAllOrders(cx, entryId);
  cx.membership[entryId] = toGroupId;

  if (Number.isInteger(index) && index >= 0) {
    if (!Array.isArray(cx.groupOrder[toGroupId])) cx.groupOrder[toGroupId] = [];
    const order = cx.groupOrder[toGroupId];
    order.splice(Math.min(index, order.length), 0, entryId);
  } else if (Array.isArray(cx.groupOrder[toGroupId])) {
    cx.groupOrder[toGroupId].push(entryId);
  }
  return { ok: true };
}

/** @returns {{ ok: boolean, group?: object, reason?: string }} */
export function codexGroupCreate(ws, tab, name = "New group") {
  if (!CODEX_TABS.includes(tab)) return { ok: false, reason: "unknown tab" };
  const cx = ensureCodex(ws);
  const group = {
    id: genEntryId("grp"),
    tab,
    name: String(name ?? "").trim() || "New group",
    custom: true
  };
  cx.groups.push(group);
  return { ok: true, group };
}

export function codexGroupRename(ws, groupId, name) {
  const cx = ensureCodex(ws);
  const group = findGroup(cx, groupId);
  if (!group) return { ok: false, reason: "unknown group" };
  const next = String(name ?? "").trim();
  if (!next) return { ok: false, reason: "name cannot be empty" };
  group.name = next;
  return { ok: true };
}

/** Only empty custom groups may be deleted (a non-empty group must be drained first). */
export function codexGroupDelete(ws, groupId) {
  const cx = ensureCodex(ws);
  const group = findGroup(cx, groupId);
  if (!group) return { ok: false, reason: "unknown group" };
  const occupied = Object.values(cx.membership).includes(groupId);
  if (occupied) return { ok: false, reason: "group is not empty" };
  cx.groups = cx.groups.filter((g) => g.id !== groupId);
  delete cx.groupOrder[groupId];
  return { ok: true };
}

/**
 * Drop codex metadata that points at entries or groups that no longer exist
 * (section resets, hand-edited saves). Self-healing — safe to run on load.
 */
export function pruneCodex(ws) {
  const cx = ensureCodex(ws);
  const valid = new Set(["pc"]);
  for (const list of [ws.npcs, ws.quests, ws.lorebook, ws.chapters, ws.scenes, ws.session_beats]) {
    for (const r of list ?? []) {
      if (r && typeof r === "object" && typeof r.id === "string") valid.add(r.id);
    }
  }
  const validGroups = new Set(cx.groups.map((g) => g.id));
  for (const tab of CODEX_TABS) {
    for (const gid of BUILTIN_GROUP_IDS[tab]) validGroups.add(gid);
  }

  for (const map of [cx.prov, cx.isNew, cx.extraFields]) {
    for (const id of Object.keys(map)) {
      if (!valid.has(id)) delete map[id];
    }
  }
  for (const id of Object.keys(cx.membership)) {
    if (!valid.has(id) || !validGroups.has(cx.membership[id])) {
      delete cx.membership[id];
    }
  }
  for (const gid of Object.keys(cx.groupOrder)) {
    if (!validGroups.has(gid)) {
      delete cx.groupOrder[gid];
      continue;
    }
    cx.groupOrder[gid] = cx.groupOrder[gid].filter((id) => valid.has(id));
    if (cx.groupOrder[gid].length === 0) delete cx.groupOrder[gid];
  }
}
