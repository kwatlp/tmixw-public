import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  getEmbedding,
  cosineSimilarity,
  hasValidStoredEmbedding
} from "./embeddings.js";

import { getWorldStatePath } from "./app_paths.js";
import { ensureCodex, genEntryId, pruneCodex } from "./codex.js";

export { getWorldStatePath };

export const WORLD_STATE_SCHEMA_VERSION = 5;

export function defaultWorldState() {
  const ws = {
    schemaVersion: WORLD_STATE_SCHEMA_VERSION,
    character: {},
    npcs: [],
    quests: [],
    locations: [],
    session_beats: [],
    scenes: [],
    chapters: [],
    lorebook: [],
    /**
     * Discovered-creature field notes (schema v5, v0.9.0 D6). Player
     * knowledge ONLY — what they've seen or been told. GM-side stat blocks
     * (template `bestiary.gm.json`) never enter this section.
     * Entry: { id, name, rank, discovered, encounters, knownTraits[], notes, firstSeen }
     */
    bestiary: [],
    correction_history: [],
    /** Where the player currently is (v0.7.0 D4) — set by the extractor, drives the bg gallery. */
    current_location: ""
  };
  ensureCodex(ws);
  return ws;
}

let _nextBeatId = Date.now();
function genBeatId() {
  return `beat_${(_nextBeatId++).toString(36)}`;
}

/**
 * Structured session beat (schema v3). `ts: null` marks pre-v3 beats whose
 * time is unknown; `sceneId: null` means not yet rolled into a scene.
 * @param {string} text
 * @param {string | null} ts
 */
export function makeSessionBeat(text, ts = new Date().toISOString()) {
  return { id: genBeatId(), ts, text: String(text ?? "").trim(), sceneId: null };
}

/**
 * Append a structured beat to `ws.session_beats`. No-op on blank text.
 * @returns {object | null} the appended beat
 */
export function appendSessionBeat(ws, text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  const beat = makeSessionBeat(t);
  ws.session_beats.push(beat);
  return beat;
}

/** Beat text regardless of shape (string = pre-v3, object = v3). */
export function beatText(beat) {
  return typeof beat === "string" ? beat : String(beat?.text ?? "");
}

/**
 * Migrate a parsed world state to the current schema version. Pure and idempotent:
 * running it on an already-migrated state changes nothing.
 *
 * v1 → v2:
 *  - extractor diff key `character_updates` renamed to `player_character` inside
 *    stored `pending_extractions[].diff` (disk key `character` is unchanged)
 *  - `correction_history: []` added
 *
 * v2 → v3 (memory architecture, roadmap v4 v0.5.0):
 *  - string `session_beats` wrapped as `{ id, ts: null, text, sceneId: null }`
 *  - `scenes: []` and `chapters: []` added
 *
 * v3 → v4 (codex, v0.8.4):
 *  - the pending-review queue is retired: `pending_extractions` drains
 *    (auto-accept, oldest first) and the key is deleted with `lore_review_log`
 *  - stable entry ids stamped on npcs/quests/lorebook rows
 *  - `codex` metadata block added (groups/membership/order/prov/isNew/extraFields)
 * @param {object} parsed - normalized world state (post-defensive checks)
 * @returns {boolean} true if anything was changed
 */
export function migrateWorldState(parsed) {
  let changed = false;
  if (!Array.isArray(parsed.pending_extractions)) parsed.pending_extractions = [];
  if (parsed.schemaVersion < 2) {
    for (const entry of parsed.pending_extractions) {
      const d = entry?.diff;
      if (d && typeof d === "object" && !Array.isArray(d) && "character_updates" in d) {
        if (!("player_character" in d)) d.player_character = d.character_updates;
        delete d.character_updates;
        changed = true;
      }
    }
    if (!Array.isArray(parsed.correction_history)) {
      parsed.correction_history = [];
      changed = true;
    }
    parsed.schemaVersion = 2;
    changed = true;
  }
  if (parsed.schemaVersion < 3) {
    const beats = Array.isArray(parsed.session_beats) ? parsed.session_beats : [];
    parsed.session_beats = beats.map((b) =>
      typeof b === "string" ? { id: genBeatId(), ts: null, text: b, sceneId: null } : b
    );
    if (!Array.isArray(parsed.scenes)) parsed.scenes = [];
    if (!Array.isArray(parsed.chapters)) parsed.chapters = [];
    parsed.schemaVersion = 3;
    changed = true;
  }
  if (parsed.schemaVersion < 4) {
    // Direct-writes model: drain the review queue in arrival order. Stale
    // queued diffs may overwrite newer lore — that is why a backup is taken
    // before migration and the correction flow exists.
    const pending = [...parsed.pending_extractions].sort((a, b) =>
      String(a?.extractedAt ?? "").localeCompare(String(b?.extractedAt ?? ""))
    );
    for (const entry of pending) {
      if (entry?.diff && typeof entry.diff === "object") {
        applyExtractorDiff(parsed, entry.diff);
      }
    }
    delete parsed.pending_extractions;
    delete parsed.lore_review_log;
    for (const [list, prefix] of [
      [parsed.npcs, "npc"],
      [parsed.quests, "quest"],
      [parsed.lorebook, "lore"]
    ]) {
      for (const r of list ?? []) {
        if (r && typeof r === "object" && typeof r.id !== "string") {
          r.id = genEntryId(prefix);
        }
      }
    }
    ensureCodex(parsed);
    parsed.schemaVersion = 4;
    changed = true;
  } else {
    delete parsed.pending_extractions;
  }
  if (parsed.schemaVersion < 5) {
    // v5 (bestiary, v0.9.0 D6): add the section and stamp ids on any
    // hand-seeded entries. Deliberately tiny — lands before the template
    // loader so `seed.bestiary` has a home.
    if (!Array.isArray(parsed.bestiary)) parsed.bestiary = [];
    for (const r of parsed.bestiary) {
      if (r && typeof r === "object" && typeof r.id !== "string") {
        r.id = genEntryId("beast");
      }
    }
    parsed.schemaVersion = 5;
    changed = true;
  }
  return changed;
}

/**
 * Copy the on-disk world_state.json to a timestamped backup in the same writable dir.
 * Safe outside Electron (CLI tools). No-op if the file does not exist.
 * @param {string} label - e.g. "v1" (migration) or "reset"
 * @returns {string | null} backup path, or null if nothing to back up
 */
export function backupWorldStateFile(label) {
  const src = getWorldStatePath();
  if (!fs.existsSync(src)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(
    path.dirname(src),
    `world_state.backup-${label}-${ts}.json`
  );
  fs.copyFileSync(src, dest);
  return dest;
}

/**
 * Normalize lorebook entries from disk (player-authored; not extractor output).
 * Preserves `embedding` when it is a valid float array, and the codex entry
 * `id` (schema v4) when present.
 * @param {unknown} raw
 * @returns {{ id?: string, title: string, content: string, keywords: string[], embedding?: number[] }[]}
 */
export function normalizeLorebook(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const title = String(e.title ?? "").trim();
    const content = String(e.content ?? "").trim();
    const keywords = Array.isArray(e.keywords)
      ? e.keywords.map((k) => String(k ?? "").trim()).filter(Boolean)
      : [];
    /** @type {{ id?: string, title: string, content: string, keywords: string[], embedding?: number[] }} */
    const row = {
      title: title || "Untitled",
      content,
      keywords
    };
    if (typeof e.id === "string" && e.id.trim()) row.id = e.id;
    if (hasValidStoredEmbedding(e.embedding)) {
      row.embedding = e.embedding.map((x) => Number(x));
    }
    out.push(row);
  }
  return out;
}

export function loreEntryTitleKey(entry) {
  return String(entry?.title ?? "").trim();
}

/**
 * Lore merge options for CLI and IPC — keep in sync with `resolvePipelineConfig` lorebook defaults in `core/pipeline.js`.
 * @param {Record<string, unknown>} config - root of `core/config.json` or resolved pipeline config (both expose `lorebook`).
 */
export function buildLoreRuntimeConfig(config) {
  const lb = /** @type {Record<string, unknown>} */ (config?.lorebook ?? {});
  return {
    maxEntries: Math.min(20, Math.max(1, Number(lb.maxEntries ?? "5"))),
    maxInjectChars: Math.max(0, Number(lb.maxInjectChars ?? "3500")),
    maxMatchMessages:
      lb.maxMatchMessages != null && lb.maxMatchMessages !== ""
        ? Math.max(1, Number(lb.maxMatchMessages))
        : null,
    vectorSimilarityThreshold: Number(lb.vectorSimilarityThreshold ?? "0.35"),
    vectorEnabled: lb.vectorEnabled !== false
  };
}

/**
 * Keyword matches with normalized recency scores (later `lastIndex` → higher score).
 * @returns {{ entry: object, score: number, origIndex: number }[]}
 */
export function matchLorebookKeywordScored(textBlob, entries, cap) {
  if (!textBlob || cap <= 0 || !entries?.length) return [];
  const blob = String(textBlob).toLowerCase();
  const blobLen = blob.length;
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let best = -1;
    const kws = Array.isArray(e.keywords) ? e.keywords : [];
    for (const k of kws) {
      const needle = String(k).toLowerCase();
      if (!needle) continue;
      const idx = blob.lastIndexOf(needle);
      if (idx > best) best = idx;
    }
    if (best < 0) continue;
    const score = blobLen === 0 ? 0 : (best + 1) / blobLen;
    scored.push({ entry: e, score, origIndex: i });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.origIndex - b.origIndex;
  });
  return scored.slice(0, cap);
}

/**
 * @param {string} queryText
 * @param {object[]} entries
 * @param {number} cap
 * @param {number} similarityThreshold
 */
async function vectorMatchLorebookEntriesScored(
  queryText,
  entries,
  cap,
  similarityThreshold
) {
  const q = String(queryText ?? "").trim();
  if (!q || cap <= 0 || !entries?.length) return [];
  let anyEmb = false;
  for (const e of entries) {
    if (hasValidStoredEmbedding(e.embedding)) {
      anyEmb = true;
      break;
    }
  }
  if (!anyEmb) return [];
  const qVec = await getEmbedding(q);
  const scored = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!hasValidStoredEmbedding(e.embedding)) continue;
    const sim = cosineSimilarity(qVec, e.embedding);
    if (sim < similarityThreshold) continue;
    scored.push({ entry: e, score: sim, origIndex: i });
  }
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.origIndex - b.origIndex;
  });
  return scored.slice(0, cap);
}

/**
 * Vector-only retrieval: entries with stored embeddings, cosine similarity vs query embedding.
 * @param {string} queryText
 * @param {object[]} entries
 * @param {number} cap
 * @param {number} [similarityThreshold=0.35]
 */
export async function vectorMatchLorebookEntries(
  queryText,
  entries,
  cap,
  similarityThreshold = 0.35
) {
  const rows = await vectorMatchLorebookEntriesScored(
    queryText,
    entries,
    cap,
    similarityThreshold
  );
  return rows.map((r) => r.entry);
}

/**
 * Keyword + vector merge: keyword matches first, then vector-only (by similarity), deduped by title.
 * @param {object} loreConfig - maxEntries, vectorEnabled, vectorSimilarityThreshold
 */
export async function mergedLorebookMatches(textBlob, entries, loreConfig) {
  const d = await mergedLorebookMatchesDetailed(textBlob, entries, loreConfig);
  return d.merged;
}

/**
 * Same as {@link mergedLorebookMatches} plus scored rows for CLI / debugging.
 */
export async function mergedLorebookMatchesDetailed(textBlob, entries, loreConfig) {
  const maxEntries = Math.max(
    1,
    Math.min(20, Number(loreConfig?.maxEntries ?? 5))
  );
  const threshold = Number(
    loreConfig?.vectorSimilarityThreshold != null
      ? loreConfig.vectorSimilarityThreshold
      : 0.35
  );
  const vectorOn = loreConfig?.vectorEnabled !== false;

  const keywordScored = matchLorebookKeywordScored(
    textBlob,
    entries,
    maxEntries
  );
  const keywordTitleKeys = new Set(
    keywordScored.map((r) => loreEntryTitleKey(r.entry))
  );

  let vectorScored = [];
  if (vectorOn) {
    vectorScored = await vectorMatchLorebookEntriesScored(
      textBlob,
      entries,
      entries.length,
      threshold
    );
  }

  const merged = [];
  const seen = new Set();
  for (const r of keywordScored) {
    const k = loreEntryTitleKey(r.entry);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r.entry);
  }
  for (const r of vectorScored) {
    if (merged.length >= maxEntries) break;
    const k = loreEntryTitleKey(r.entry);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(r.entry);
  }

  const vectorOnlyDisplay = vectorScored.filter(
    (r) => !keywordTitleKeys.has(loreEntryTitleKey(r.entry))
  );

  return {
    merged,
    keywordScored,
    vectorScored,
    vectorOnlyDisplay
  };
}

/**
 * Case-insensitive substring match; prioritize entries whose keywords appear
 * latest in textBlob (lastIndexOf in the lowered blob — later in chat = larger index).
 *
 * @param {string} textBlob - scanned text (e.g. recent chat lines, oldest→newest)
 * @param {{ title?: string, content?: string, keywords?: string[] }[]} entries
 * @param {number} cap - max entries to return (e.g. 3–5)
 * @returns {{ title: string, content: string, keywords: string[] }[]}
 */
export function matchLorebookEntries(textBlob, entries, cap) {
  return matchLorebookKeywordScored(textBlob, entries, cap).map((r) => r.entry);
}

export function loadWorldState() {
  try {
    const raw = fs.readFileSync(getWorldStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultWorldState();
    if (!parsed.character || typeof parsed.character !== "object") parsed.character = {};
    if (!Array.isArray(parsed.npcs)) parsed.npcs = [];
    if (!Array.isArray(parsed.quests)) parsed.quests = [];
    if (!Array.isArray(parsed.locations)) parsed.locations = [];
    if (!Array.isArray(parsed.session_beats)) parsed.session_beats = [];
    if (!Array.isArray(parsed.scenes)) parsed.scenes = [];
    if (!Array.isArray(parsed.chapters)) parsed.chapters = [];
    // Hand-edited v3 files may reintroduce bare-string beats; wrap them so
    // downstream code can rely on the structured shape.
    for (let i = 0; i < parsed.session_beats.length; i++) {
      const b = parsed.session_beats[i];
      if (typeof b === "string") {
        parsed.session_beats[i] = { id: genBeatId(), ts: null, text: b, sceneId: null };
      }
    }
    parsed.lorebook = normalizeLorebook(parsed.lorebook);
    if (!Array.isArray(parsed.bestiary)) parsed.bestiary = [];
    if (!Array.isArray(parsed.correction_history)) parsed.correction_history = [];
    if (typeof parsed.current_location !== "string") parsed.current_location = "";
    if (typeof parsed.schemaVersion !== "number") parsed.schemaVersion = 1;
    const fromVersion = parsed.schemaVersion;
    if (fromVersion < WORLD_STATE_SCHEMA_VERSION) {
      backupWorldStateFile(`v${fromVersion}`);
      migrateWorldState(parsed);
    }
    // Self-heal: rows added outside the apply path (lore CLI, hand edits)
    // get their codex entry id here, persisted so the id stays stable.
    let stampedIds = false;
    for (const [list, prefix] of [
      [parsed.npcs, "npc"],
      [parsed.quests, "quest"],
      [parsed.lorebook, "lore"],
      [parsed.bestiary, "beast"]
    ]) {
      for (const r of list) {
        if (r && typeof r === "object" && typeof r.id !== "string") {
          r.id = genEntryId(prefix);
          stampedIds = true;
        }
      }
    }
    ensureCodex(parsed);
    pruneCodex(parsed);
    if (fromVersion < WORLD_STATE_SCHEMA_VERSION || stampedIds) {
      saveWorldState(parsed);
    }
    return parsed;
  } catch {
    return defaultWorldState();
  }
}

export function saveWorldState(ws) {
  fs.writeFileSync(
    getWorldStatePath(),
    JSON.stringify(ws, null, 2) + os.EOL,
    "utf8"
  );
}

/**
 * Merge onboarding or editor patch into ws.character (freeform key/value card).
 * Shallow merge per top-level key; values may be nested objects/arrays.
 * @param {object} ws
 * @param {object} patch
 */
export function mergeCharacterCard(ws, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
  for (const key of Object.keys(patch)) {
    if (key === "__proto__" || key === "constructor") continue;
    ws.character[key] = patch[key];
  }
}

/**
 * Caps for extractor prompt payload (Phase 2+). Tune when world state grows.
 * Full state still lives on disk — this is only what we send to the model.
 */
export const EXTRACTOR_SNAPSHOT_LIMITS = {
  maxNpcs: 40,
  maxLocations: 30,
  maxQuests: 30,
  maxSessionBeats: 10,
  maxLorebookTitles: 50,
  maxBestiary: 25,
  maxCharacterJsonChars: 4000
};

/**
 * Fit freeform character object into a max JSON string length for extractor prompts.
 */
export function characterForExtractorPrompt(character, maxChars) {
  const src =
    character && typeof character === "object" && !Array.isArray(character)
      ? character
      : {};
  const out = {};
  for (const k of Object.keys(src)) {
    if (k === "__proto__" || k === "constructor") continue;
    const next = { ...out, [k]: src[k] };
    try {
      const s = JSON.stringify(next);
      if (s.length > maxChars) {
        if (Object.keys(out).length > 0) out._card_truncated = true;
        break;
      }
      out[k] = src[k];
    } catch {
      break;
    }
  }
  return out;
}

/**
 * Build a bounded snapshot for the Extractor prompt (reduces context blow-up as world grows).
 * @param {object} worldState - loaded world state
 */
export function buildExtractorSnapshot(worldState) {
  const lim = EXTRACTOR_SNAPSHOT_LIMITS;
  const player_character = characterForExtractorPrompt(
    worldState.character ?? {},
    lim.maxCharacterJsonChars
  );
  // Codex entry ids (schema v4) are renderer plumbing — never spend prompt
  // tokens on them or the model may echo them back into the diff.
  const stripId = ({ id, ...rest }) => rest;
  const npcs = (worldState.npcs ?? []).slice(0, lim.maxNpcs).map(stripId);
  const locations = (worldState.locations ?? [])
    .slice(0, lim.maxLocations)
    .map(stripId);
  const quests = (worldState.quests ?? []).slice(0, lim.maxQuests).map(stripId);
  // The extractor prompt keeps the pre-v3 shape (plain strings) — beat
  // metadata is for the memory tiers, not the model.
  const session_beats = (worldState.session_beats ?? [])
    .slice(-lim.maxSessionBeats)
    .map((b) => beatText(b))
    .filter(Boolean);
  const lorebook = (worldState.lorebook ?? [])
    .slice(0, lim.maxLorebookTitles)
    .map((e) => ({ title: e.title, keywords: e.keywords }));
  // Known-creature digest: enough for the model to dedupe and to add only
  // NEW observations; notes/firstSeen stay out of the prompt budget.
  const bestiary = (worldState.bestiary ?? [])
    .slice(0, lim.maxBestiary)
    .map((b) => ({
      name: b.name,
      rank: b.rank ?? "",
      knownTraits: b.knownTraits ?? []
    }));
  return {
    player_character,
    npcs,
    quests,
    locations,
    current_location: String(worldState.current_location ?? ""),
    lorebook,
    bestiary,
    session_beats
  };
}

function upsertByKey(arr, item, keyFn) {
  const k = keyFn(item);
  const idx = arr.findIndex((x) => keyFn(x) === k);
  if (idx >= 0) {
    arr[idx] = { ...arr[idx], ...item };
  } else {
    arr.push(item);
  }
}

/**
 * True when a player_character value looks like a misrouted NPC entry
 * ({ name, status/notes } object) rather than a character-sheet field.
 */
function isNpcShapedValue(val) {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const hasName = typeof val.name === "string" && val.name.trim() !== "";
  return hasName && ("status" in val || "notes" in val);
}

/**
 * Apply an extractor diff to world state (schema v4: also maintains codex
 * provenance/draft metadata).
 *
 * @param {object} ws - mutable world state from loadWorldState()
 * @param {object} diff - extractor output matching roadmap schema
 * @param {object} [opts]
 * @param {"ai"|"you"} [opts.prov] - stamp who wrote each field; omit to leave
 *   provenance untouched (migration drain, fixtures)
 * @param {boolean} [opts.autoKeepPrevious] - clear all existing `isNew` flags
 *   first (a new turn's writes auto-keep last turn's untouched drafts)
 * @returns {{ created: { entryId: string, name: string, tab: string }[] }}
 *   entries newly created by this diff (for the narrative marker chips)
 */
export function applyExtractorDiff(ws, diff, opts = {}) {
  const created = [];
  if (!diff || typeof diff !== "object") return { created };
  const prov = opts.prov === "ai" || opts.prov === "you" ? opts.prov : null;
  const cx = ensureCodex(ws);
  if (prov === "ai" && opts.autoKeepPrevious) {
    // Untouched drafts from earlier turns are auto-kept — never nag.
    cx.isNew = {};
  }
  const stamp = (entryId, fieldKey) => {
    if (!prov) return;
    if (!cx.prov[entryId]) cx.prov[entryId] = {};
    cx.prov[entryId][fieldKey] = prov;
  };
  const markCreated = (entryId, name, tab) => {
    if (prov === "ai") cx.isNew[entryId] = true;
    created.push({ entryId, name, tab });
  };

  // `character_updates` is the pre-v2 key; accept it for old pending diffs
  // and user-customized extractor prompts.
  const pc = diff.player_character ?? diff.character_updates;
  if (pc && typeof pc === "object" && !Array.isArray(pc)) {
    const npcNames = new Set(
      (ws.npcs ?? [])
        .map((n) => String(n?.name ?? "").trim().toLowerCase())
        .filter(Boolean)
    );
    for (const [key, val] of Object.entries(pc)) {
      if (key === "__proto__" || key === "constructor") continue;
      // Guard: NPC data must never land on the player character, even if the
      // model misroutes it. Dropped, not rerouted — the NPC list stays authoritative.
      if (npcNames.has(key.trim().toLowerCase())) continue;
      if (isNpcShapedValue(val)) continue;
      if (val === null) {
        delete ws.character[key];
        if (cx.prov.pc) delete cx.prov.pc[key];
      } else {
        ws.character[key] = val;
        stamp("pc", key);
      }
    }
  }

  if (Array.isArray(diff.npcs)) {
    for (const n of diff.npcs) {
      if (!n || typeof n !== "object") continue;
      const name = String(n.name ?? "").trim();
      if (!name) continue;
      const item = {
        name,
        status: String(n.status ?? "").trim(),
        notes: String(n.notes ?? "").trim()
      };
      const idx = ws.npcs.findIndex(
        (x) => String(x?.name ?? "").trim() === name
      );
      let entryId;
      if (idx >= 0) {
        if (typeof ws.npcs[idx].id !== "string") {
          ws.npcs[idx].id = genEntryId("npc");
        }
        entryId = ws.npcs[idx].id;
        ws.npcs[idx] = { ...ws.npcs[idx], ...item };
      } else {
        entryId = genEntryId("npc");
        ws.npcs.push({ id: entryId, ...item });
        markCreated(entryId, name, "cast");
      }
      stamp(entryId, "status");
      stamp(entryId, "notes");
    }
  }

  if (Array.isArray(diff.quests)) {
    for (const q of diff.quests) {
      if (!q || typeof q !== "object") continue;
      const title = String(q.title ?? "").trim();
      if (!title) continue;
      const entry = { title, status: String(q.status ?? "active").trim() };
      for (const [k, v] of Object.entries(q)) {
        if (k === "title" || k === "status" || k === "id" || k === "__proto__" || k === "constructor") continue;
        entry[k] = v;
      }
      const keyFn = (x) => String(x.title ?? "").trim();
      const idx = ws.quests.findIndex((x) => keyFn(x) === title);
      let entryId;
      if (idx >= 0) {
        if (typeof ws.quests[idx].id !== "string") {
          ws.quests[idx].id = genEntryId("quest");
        }
        entryId = ws.quests[idx].id;
        const merged = { ...ws.quests[idx] };
        for (const [k, v] of Object.entries(entry)) {
          if (v === null) {
            delete merged[k];
            if (cx.prov[entryId]) delete cx.prov[entryId][k];
          } else {
            merged[k] = v;
            if (k !== "title") stamp(entryId, k);
          }
        }
        ws.quests[idx] = merged;
      } else {
        entryId = genEntryId("quest");
        ws.quests.push({ id: entryId, ...entry });
        markCreated(entryId, title, "story");
        for (const k of Object.keys(entry)) {
          if (k !== "title") stamp(entryId, k);
        }
      }
    }
  }

  if (Array.isArray(diff.locations)) {
    for (const loc of diff.locations) {
      if (!loc || typeof loc !== "object") continue;
      const name = String(loc.name ?? "").trim();
      if (!name) continue;
      upsertByKey(
        ws.locations,
        {
          name,
          description: String(loc.description ?? "").trim()
        },
        (x) => String(x.name ?? "").trim()
      );
    }
  }

  if (Array.isArray(diff.lorebook)) {
    for (const entry of diff.lorebook) {
      if (!entry || typeof entry !== "object") continue;
      const title = String(entry.title ?? "").trim();
      if (!title) continue;
      const content = String(entry.content ?? "").trim();
      if (!content) continue;
      const keywords = Array.isArray(entry.keywords)
        ? entry.keywords.map((k) => String(k).trim()).filter(Boolean)
        : [];
      if (keywords.length === 0) keywords.push(title.toLowerCase());
      const keyFn = (x) => String(x.title ?? "").trim().toLowerCase();
      const idx = ws.lorebook.findIndex((x) => keyFn(x) === title.toLowerCase());
      let entryId;
      if (idx >= 0) {
        if (typeof ws.lorebook[idx].id !== "string") {
          ws.lorebook[idx].id = genEntryId("lore");
        }
        entryId = ws.lorebook[idx].id;
        ws.lorebook[idx] = { ...ws.lorebook[idx], title, content, keywords };
      } else {
        entryId = genEntryId("lore");
        ws.lorebook.push({ id: entryId, title, content, keywords });
        markCreated(entryId, title, "world");
      }
      stamp(entryId, "content");
      stamp(entryId, "keywords");
    }
  }

  // Bestiary (schema v5, v0.9.0 D6): player-observed creature notes only.
  // Case-insensitive name match (lorebook precedent — models down-case
  // creature names); merge fields; a re-sighting increments `encounters`
  // (the model's own count is ignored — echoes would compound).
  if (Array.isArray(diff.bestiary)) {
    for (const b of diff.bestiary) {
      if (!b || typeof b !== "object") continue;
      const name = String(b.name ?? "").trim();
      if (!name) continue;
      const rank = String(b.rank ?? "").trim();
      const notes = String(b.notes ?? "").trim();
      const firstSeen = String(b.firstSeen ?? "").trim();
      const traits = Array.isArray(b.knownTraits)
        ? b.knownTraits.map((t) => String(t ?? "").trim()).filter(Boolean)
        : [];
      const keyFn = (x) => String(x?.name ?? "").trim().toLowerCase();
      const idx = ws.bestiary.findIndex((x) => keyFn(x) === name.toLowerCase());
      let entryId;
      if (idx >= 0) {
        const cur = ws.bestiary[idx];
        if (typeof cur.id !== "string") cur.id = genEntryId("beast");
        entryId = cur.id;
        cur.discovered = true;
        cur.encounters = (Number.isInteger(cur.encounters) ? cur.encounters : 0) + 1;
        if (rank) {
          cur.rank = rank;
          stamp(entryId, "rank");
        }
        if (notes) {
          cur.notes = notes;
          stamp(entryId, "notes");
        }
        if (traits.length > 0) {
          const seen = new Set((cur.knownTraits ?? []).map((t) => t.toLowerCase()));
          for (const t of traits) {
            if (!seen.has(t.toLowerCase())) {
              cur.knownTraits = [...(cur.knownTraits ?? []), t];
              seen.add(t.toLowerCase());
            }
          }
          stamp(entryId, "knownTraits");
        }
      } else {
        entryId = genEntryId("beast");
        ws.bestiary.push({
          id: entryId,
          name,
          rank,
          discovered: true,
          encounters: 1,
          knownTraits: traits,
          notes,
          // First sighting wins; default to where the player is right now.
          firstSeen: firstSeen || String(ws.current_location ?? "")
        });
        markCreated(entryId, name, "bestiary");
        stamp(entryId, "rank");
        stamp(entryId, "notes");
        stamp(entryId, "knownTraits");
      }
    }
  }

  // Where the player is now (v0.7.0 D4). Also added to the visited locations
  // list (without touching an existing entry's description) so the gallery
  // and scene logic share one name set.
  if (typeof diff.current_location === "string" && diff.current_location.trim()) {
    const name = diff.current_location.trim();
    ws.current_location = name;
    const known = ws.locations.some(
      (l) => String(l?.name ?? "").trim().toLowerCase() === name.toLowerCase()
    );
    if (!known) ws.locations.push({ name, description: "" });
  }

  const beatStr = diff.session_beat;
  if (typeof beatStr === "string" && beatStr.trim()) {
    const beat = appendSessionBeat(ws, beatStr);
    if (beat) stamp(beat.id, "text");
  }

  return { created };
}

const CORRECTION_HISTORY_CAP = 5;

/** Extractor diff keys → the world-state sections they mutate. */
const DIFF_SECTION_MAP = {
  player_character: "character",
  character_updates: "character",
  npcs: "npcs",
  quests: "quests",
  locations: "locations",
  lorebook: "lorebook",
  bestiary: "bestiary",
  session_beat: "session_beats"
};

let _nextCorrId = Date.now();
function genCorrectionId() {
  return `corr_${(_nextCorrId++).toString(36)}`;
}

/**
 * Record a lore correction BEFORE applying its diff. `before` holds deep
 * copies of only the sections the diff touches — applyExtractorDiff merges
 * are lossy, so undo restores these snapshots wholesale. Cap 5, oldest
 * dropped; only the newest entry is undoable (LIFO).
 * @param {object} ws - world state the diff is about to be applied to
 * @param {string} correctionText - the player's natural-language correction
 * @param {object} diff - parsed corrector output
 */
export function recordCorrection(ws, correctionText, diff) {
  const before = {};
  for (const [diffKey, section] of Object.entries(DIFF_SECTION_MAP)) {
    if (diff && typeof diff === "object" && diffKey in diff && !(section in before)) {
      const cur = ws[section] ?? (section === "character" ? {} : []);
      before[section] = JSON.parse(JSON.stringify(cur));
    }
  }
  // Applying the diff also stamps codex provenance/ids — snapshot the codex
  // block alongside the touched sections so undo restores them in lockstep.
  if (Object.keys(before).length > 0) {
    before.codex = JSON.parse(JSON.stringify(ensureCodex(ws)));
  }
  const entry = {
    id: genCorrectionId(),
    ts: new Date().toISOString(),
    correctionText: String(correctionText ?? ""),
    diff,
    before
  };
  ws.correction_history.push(entry);
  while (ws.correction_history.length > CORRECTION_HISTORY_CAP) {
    ws.correction_history.shift();
  }
  return entry;
}

/**
 * Undo the newest correction: restore its `before` section snapshots
 * wholesale and pop it from the history.
 * @returns {object | null} the undone entry, or null if history is empty
 */
export function undoLastCorrection(ws) {
  const entry = ws.correction_history.pop();
  if (!entry) return null;
  for (const [section, snapshot] of Object.entries(entry.before ?? {})) {
    ws[section] = snapshot;
  }
  return entry;
}

export const RESETTABLE_SECTIONS = [
  "character",
  "npcs",
  "quests",
  "locations",
  "lorebook",
  "bestiary",
  "session_beats"
];

/**
 * Clear the given world-state sections in place (settings reset controls).
 * `session_beats` also clears `scenes` and `chapters` — summaries without
 * their beats are incoherent (the caller is responsible for deleting the
 * sibling memory-vector cache). Any reset clears `correction_history` —
 * undoing a correction across a wipe is incoherent. Codex metadata for the
 * cleared entries is pruned.
 * @param {object} ws
 * @param {string[]} sections - subset of {@link RESETTABLE_SECTIONS}
 * @returns {string[]} the sections actually cleared
 */
export function resetWorldSections(ws, sections) {
  const wanted = (Array.isArray(sections) ? sections : [])
    .map((s) => String(s ?? "").trim())
    .filter((s) => RESETTABLE_SECTIONS.includes(s));
  if (wanted.length === 0) return [];
  for (const s of wanted) {
    if (s === "character") {
      ws.character = {};
    } else if (s === "lorebook") {
      ws.lorebook = [];
    } else if (s === "session_beats") {
      ws.session_beats = [];
      ws.scenes = [];
      ws.chapters = [];
    } else if (s === "locations") {
      ws.locations = [];
      ws.current_location = "";
    } else {
      ws[s] = [];
    }
  }
  ws.correction_history = [];
  if (wanted.includes("character")) {
    const cx = ensureCodex(ws);
    delete cx.prov.pc;
    delete cx.isNew.pc;
    delete cx.extraFields.pc;
  }
  pruneCodex(ws);
  return wanted;
}

