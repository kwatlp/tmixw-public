// Delta application + shared section builders for the interaction engine
// (design doc 02 §5–§6). Resolvers compute ABSOLUTE values at resolve time and
// emit path-based deltas; applyDeltas writes only those mechanical fields onto
// the live world state at COMMIT, leaving non-mechanical fields (extractor
// territory) untouched. The engine is the sole writer of the fields it touches,
// so absolute values never race the extractor.

const SAFE = (k) => k !== "__proto__" && k !== "constructor" && k !== "prototype";

/** Set `value` at `path` (array of keys) on `obj`, creating intermediate objects. */
export function setPath(obj, path, value) {
  if (!obj || !Array.isArray(path) || path.length === 0) return;
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = String(path[i]);
    if (!SAFE(k)) return;
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  const last = String(path[path.length - 1]);
  if (SAFE(last)) cur[last] = value;
}

/**
 * Apply a ResolutionResult's deltas to world state (the single COMMIT writer).
 * `deltas.character` / `deltas.encounter` are arrays of { path, value }.
 * @param {object} ws - live world state
 * @param {object} deltas - result.deltas
 */
export function applyDeltas(ws, deltas) {
  if (!ws || !deltas || typeof deltas !== "object") return;
  for (const d of deltas.character ?? []) setPath(ws.character, d.path, d.value);
  // Combat (doc 02 §4) replaces the whole encounter — it changes too much per
  // round for path deltas. Path-based encounter deltas still supported.
  if (deltas.encounterReplace !== undefined) {
    ws.encounter = deltas.encounterReplace;
  }
  if (deltas.encounter) {
    if (!ws.encounter || typeof ws.encounter !== "object") ws.encounter = { active: false };
    for (const d of deltas.encounter) setPath(ws.encounter, d.path, d.value);
  }
}

/** Compact status snapshot the app renders under the prose (design §6.2). */
export function buildStatusSection(character) {
  const c = character ?? {};
  const res = c.resources ?? {};
  const snapshot = {};
  const pool = (k, label) => {
    const p = res[k];
    if (p && typeof p === "object") snapshot[label] = `${p.current}/${p.max}`;
  };
  pool("vitality", "VIT");
  pool("stamina", "STA");
  pool("aether", "AET");
  if (c.derived?.guard != null) snapshot.GUARD = String(c.derived.guard);
  if (c.xp) snapshot.XP = `${c.xp.current ?? 0}/${c.xp.max ?? 0}`;
  return { type: "status", title: "Status", snapshot };
}
