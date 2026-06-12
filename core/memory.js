// Hierarchical story memory (roadmap v4, v0.5.0 item 1).
//
// Three tiers: session beats (extractor output) roll up into scenes; scenes
// roll up into chapters. Beats/scenes/chapters live in world_state.json and
// share its save/backup/migration lifecycle. Embeddings for beats and scene
// summaries are a regenerable cache in memory_vectors.json (sibling file,
// never backed up or migrated).
//
// Staleness model (plan D6):
//  - a scene with `summary: ""` has never been summarized → auto-fill is fine
//  - `stale: true` on a non-empty summary means a player edit invalidated it →
//    regeneration only on explicit player confirmation
//  - `edited: true` marks a player-authored summary; regeneration clears it
//    only when explicitly requested
import fs from "node:fs";
import path from "node:path";
import { getPackageRoot, getMemoryVectorsPath } from "./app_paths.js";
import { beatText } from "./world_state.js";
import { getEmbedding, hasValidStoredEmbedding } from "./embeddings.js";

let _nextSceneId = Date.now();
function genSceneId() {
  return `scene_${(_nextSceneId++).toString(36)}`;
}

let _nextChapterId = Date.now();
function genChapterId() {
  return `chap_${(_nextChapterId++).toString(36)}`;
}

export const MEMORY_DEFAULTS = {
  /** Unassigned-beat count that triggers an automatic scene boundary. */
  sceneBeatThreshold: 12,
  /** A brand-new location name in the extractor diff ends the current scene. */
  autoSceneOnLocationChange: true,
  /** Background summarizer fills empty scene/chapter summaries after roll-up. */
  autoSummarize: true
};

/** @param {Record<string, unknown>} fileCfg - root of core/config.json */
export function buildMemoryRuntimeConfig(fileCfg) {
  const m = /** @type {Record<string, unknown>} */ (fileCfg?.memory ?? {});
  return {
    sceneBeatThreshold: Math.max(
      2,
      Number(m.sceneBeatThreshold ?? MEMORY_DEFAULTS.sceneBeatThreshold)
    ),
    autoSceneOnLocationChange:
      m.autoSceneOnLocationChange !== false,
    autoSummarize: m.autoSummarize !== false
  };
}

function nowIso() {
  return new Date().toISOString();
}

export function findBeat(ws, beatId) {
  return (ws.session_beats ?? []).find((b) => b?.id === beatId) ?? null;
}

export function findScene(ws, sceneId) {
  return (ws.scenes ?? []).find((s) => s?.id === sceneId) ?? null;
}

export function findChapter(ws, chapterId) {
  return (ws.chapters ?? []).find((c) => c?.id === chapterId) ?? null;
}

/** Beats not yet rolled into a scene, in story order. */
export function unassignedBeats(ws) {
  return (ws.session_beats ?? []).filter((b) => b && !b.sceneId);
}

/** The chapter open scenes currently roll into (last in story order). */
export function currentChapter(ws) {
  const ch = ws.chapters ?? [];
  return ch.length ? ch[ch.length - 1] : null;
}

/**
 * Start a new chapter. Scenes ended after this roll into it.
 * @returns {object} the new chapter
 */
export function startChapter(ws, title = "") {
  const n = (ws.chapters?.length ?? 0) + 1;
  const chapter = {
    id: genChapterId(),
    ts: nowIso(),
    title: String(title ?? "").trim() || `Chapter ${n}`,
    summary: "",
    stale: false,
    edited: false,
    pinned: false
  };
  ws.chapters.push(chapter);
  return chapter;
}

/**
 * End the current scene: roll all unassigned beats into a new scene under the
 * current chapter (created as "Chapter 1" if none exists yet). The scene's
 * summary starts empty — the background summarizer (or an explicit regenerate)
 * fills it.
 * @returns {object | null} the new scene, or null when there are no beats to roll up
 */
export function endScene(ws, title = "") {
  const beats = unassignedBeats(ws);
  if (beats.length === 0) return null;
  const chapter = currentChapter(ws) ?? startChapter(ws);
  const scene = {
    id: genSceneId(),
    ts: nowIso(),
    title: String(title ?? "").trim(),
    summary: "",
    parentId: chapter.id,
    beatIds: beats.map((b) => b.id),
    stale: false,
    edited: false,
    pinned: false
  };
  for (const b of beats) b.sceneId = scene.id;
  ws.scenes.push(scene);
  // The chapter's summary no longer covers all of its scenes.
  if (chapter.summary) chapter.stale = true;
  return scene;
}

/**
 * Scene-boundary heuristics (plan D3), checked after a turn's extractor diff
 * has been applied. Explicit player action does not go through here.
 * @param {object} ws - post-apply world state
 * @param {object | null} diff - this turn's extractor diff
 * @param {ReturnType<typeof buildMemoryRuntimeConfig>} memCfg
 * @param {Set<string>} prevLocationNames - lowercased location names BEFORE the diff
 * @returns {string | null} boundary reason, or null for no boundary
 */
export function detectSceneBoundary(ws, diff, memCfg, prevLocationNames) {
  const pending = unassignedBeats(ws).length;
  if (pending === 0) return null;
  if (memCfg.autoSceneOnLocationChange && Array.isArray(diff?.locations)) {
    for (const loc of diff.locations) {
      const name = String(loc?.name ?? "").trim().toLowerCase();
      if (name && !prevLocationNames.has(name)) return "location-change";
    }
  }
  if (pending >= memCfg.sceneBeatThreshold) return "beat-threshold";
  return null;
}

/** Mark a beat's parent scene (and that scene's chapter) stale after an edit. */
function markParentsStale(ws, sceneId) {
  const scene = sceneId ? findScene(ws, sceneId) : null;
  if (!scene) return;
  if (scene.summary) scene.stale = true;
  const chapter = findChapter(ws, scene.parentId);
  if (chapter?.summary) chapter.stale = true;
}

/**
 * Edit a beat's text. Parent summaries are flagged stale (player-visible);
 * they are NOT regenerated here.
 * @returns {boolean} true if the beat existed
 */
export function editBeat(ws, beatId, text) {
  const beat = findBeat(ws, beatId);
  if (!beat) return false;
  const t = String(text ?? "").trim();
  if (!t || t === beat.text) return Boolean(t);
  beat.text = t;
  markParentsStale(ws, beat.sceneId);
  return true;
}

/** Delete a beat; parent summaries are flagged stale. */
export function deleteBeat(ws, beatId) {
  const idx = (ws.session_beats ?? []).findIndex((b) => b?.id === beatId);
  if (idx < 0) return false;
  const [beat] = ws.session_beats.splice(idx, 1);
  const scene = beat.sceneId ? findScene(ws, beat.sceneId) : null;
  if (scene) {
    scene.beatIds = (scene.beatIds ?? []).filter((id) => id !== beatId);
    markParentsStale(ws, scene.id);
  }
  return true;
}

/**
 * Player-authored scene summary: never silently overwritten by regeneration.
 */
export function editSceneSummary(ws, sceneId, summary) {
  const scene = findScene(ws, sceneId);
  if (!scene) return false;
  scene.summary = String(summary ?? "").trim();
  scene.edited = true;
  scene.stale = false;
  const chapter = findChapter(ws, scene.parentId);
  if (chapter?.summary) chapter.stale = true;
  return true;
}

export function editChapterSummary(ws, chapterId, summary) {
  const chapter = findChapter(ws, chapterId);
  if (!chapter) return false;
  chapter.summary = String(summary ?? "").trim();
  chapter.edited = true;
  chapter.stale = false;
  return true;
}

export function setSceneTitle(ws, sceneId, title) {
  const scene = findScene(ws, sceneId);
  if (!scene) return false;
  scene.title = String(title ?? "").trim();
  return true;
}

export function setChapterTitle(ws, chapterId, title) {
  const chapter = findChapter(ws, chapterId);
  if (!chapter) return false;
  chapter.title = String(title ?? "").trim();
  return true;
}

/**
 * Delete a scene AND its beats (removing a scene removes that stretch of the
 * story from memory; orphaning its beats back to "unassigned" would splice
 * them into the next scene out of order).
 */
export function deleteScene(ws, sceneId) {
  const idx = (ws.scenes ?? []).findIndex((s) => s?.id === sceneId);
  if (idx < 0) return false;
  const [scene] = ws.scenes.splice(idx, 1);
  const beatIds = new Set(scene.beatIds ?? []);
  ws.session_beats = (ws.session_beats ?? []).filter((b) => !beatIds.has(b?.id));
  const chapter = findChapter(ws, scene.parentId);
  if (chapter) {
    const remaining = (ws.scenes ?? []).some((s) => s.parentId === chapter.id);
    if (!remaining) {
      // Nothing left to summarize — a summary of deleted content is incoherent,
      // and the summarizer skips sceneless chapters (it could never regenerate).
      chapter.summary = "";
      chapter.stale = false;
      chapter.edited = false;
    } else if (chapter.summary) {
      chapter.stale = true;
    }
  }
  return true;
}

/** Delete a chapter, its scenes, and their beats. */
export function deleteChapter(ws, chapterId) {
  const idx = (ws.chapters ?? []).findIndex((c) => c?.id === chapterId);
  if (idx < 0) return false;
  ws.chapters.splice(idx, 1);
  const doomedScenes = (ws.scenes ?? []).filter((s) => s.parentId === chapterId);
  const doomedBeats = new Set();
  for (const s of doomedScenes) for (const id of s.beatIds ?? []) doomedBeats.add(id);
  ws.scenes = (ws.scenes ?? []).filter((s) => s.parentId !== chapterId);
  ws.session_beats = (ws.session_beats ?? []).filter((b) => !doomedBeats.has(b?.id));
  return true;
}

/**
 * Pin/unpin a memory entry (pinned entries are always in narrator context).
 * @param {"beat" | "scene" | "chapter"} kind
 */
export function setPinned(ws, kind, id, pinned) {
  const entry =
    kind === "beat" ? findBeat(ws, id)
    : kind === "scene" ? findScene(ws, id)
    : kind === "chapter" ? findChapter(ws, id)
    : null;
  if (!entry) return false;
  entry.pinned = Boolean(pinned);
  return true;
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

const SCENE_PROMPT_FALLBACK = `You summarize roleplay story events. Write a compact summary of the scene below in 2-4 sentences, past tense, third person. Keep named characters, places, decisions, and consequences. Summarize ONLY events that already happened — never predict or foreshadow. No commentary, no headings — output only the summary text.`;

const CHAPTER_PROMPT_FALLBACK = `You summarize roleplay story chapters. Combine the scene summaries below into one chapter summary, past tense, third person, 1-2 sentences per scene. Summarize ONLY events that already happened — never predict, plan, or foreshadow future events. Keep the through-line: goals, turning points, and where things stand at the end. No commentary, no headings — output only the summary text.`;

function loadPromptFile(name, fallback) {
  try {
    const p = path.join(getPackageRoot(), "prompts", name);
    const text = fs.readFileSync(p, "utf8").trim();
    if (text) return text;
  } catch {
    // fall through
  }
  return fallback;
}

export function loadSceneSummaryPrompt() {
  return loadPromptFile("scene_summary.txt", SCENE_PROMPT_FALLBACK);
}

export function loadChapterSummaryPrompt() {
  return loadPromptFile("chapter_summary.txt", CHAPTER_PROMPT_FALLBACK);
}

export function buildSceneSummaryPrompt(ws, scene, systemText) {
  const ids = new Set(scene.beatIds ?? []);
  const beats = (ws.session_beats ?? []).filter((b) => ids.has(b?.id));
  const lines = [systemText, ""];
  if (scene.title) lines.push(`Scene title: ${scene.title}`, "");
  lines.push("Scene events, in order:");
  for (const b of beats) lines.push(`- ${beatText(b)}`);
  lines.push("", "Summary:");
  return lines.join("\n");
}

export function buildChapterSummaryPrompt(ws, chapter, systemText) {
  const scenes = (ws.scenes ?? []).filter((s) => s.parentId === chapter.id);
  const lines = [systemText, ""];
  if (chapter.title) lines.push(`Chapter title: ${chapter.title}`, "");
  lines.push("Scene summaries, in order:");
  for (const s of scenes) {
    const label = s.title ? `${s.title}: ` : "";
    lines.push(`- ${label}${s.summary || "(not yet summarized)"}`);
  }
  lines.push("", "Chapter summary:");
  return lines.join("\n");
}

/**
 * Fill or refresh summaries.
 *
 * Auto mode (`force: false`, background tick): only never-summarized entries
 * (summary === "") are filled — player-edit staleness waits for explicit
 * confirmation. Forced mode (`force: true`, the UI "Regenerate" button) also
 * rewrites stale and edited entries for the given ids.
 *
 * @param {object} ws
 * @param {(prompt: string) => Promise<string>} generate - model call
 * @param {{ force?: boolean, sceneIds?: string[], chapterIds?: string[] }} [opts]
 * @returns {Promise<{ scenes: string[], chapters: string[] }>} ids actually summarized
 */
export async function runSummarization(ws, generate, opts = {}) {
  const force = opts.force === true;
  const sceneFilter = opts.sceneIds ? new Set(opts.sceneIds) : null;
  const chapterFilter = opts.chapterIds ? new Set(opts.chapterIds) : null;
  const scenePrompt = loadSceneSummaryPrompt();
  const chapterPrompt = loadChapterSummaryPrompt();
  const done = { scenes: [], chapters: [] };

  for (const scene of ws.scenes ?? []) {
    if (sceneFilter && !sceneFilter.has(scene.id)) continue;
    const never = !scene.summary;
    // Forced with explicit ids regenerates those scenes unconditionally.
    const eligible = force ? never || scene.stale || sceneFilter !== null : never;
    if (!eligible) continue;
    // Player-authored summaries are only rewritten when explicitly targeted.
    if (scene.edited && !(force && sceneFilter?.has(scene.id))) continue;
    const text = (await generate(buildSceneSummaryPrompt(ws, scene, scenePrompt))).trim();
    if (!text) continue;
    scene.summary = text;
    scene.stale = false;
    if (force) scene.edited = false;
    done.scenes.push(scene.id);
    const chapter = findChapter(ws, scene.parentId);
    if (chapter?.summary) chapter.stale = true;
  }

  for (const chapter of ws.chapters ?? []) {
    if (chapterFilter && !chapterFilter.has(chapter.id)) continue;
    const scenes = (ws.scenes ?? []).filter((s) => s.parentId === chapter.id);
    if (scenes.length === 0) {
      // No scenes → nothing to summarize from. An explicit regenerate clears
      // the leftover summary instead of silently doing nothing.
      if (force && chapterFilter?.has(chapter.id) && (chapter.summary || chapter.stale)) {
        chapter.summary = "";
        chapter.stale = false;
        chapter.edited = false;
        done.chapters.push(chapter.id);
      }
      continue;
    }
    const allSummarized = scenes.every((s) => s.summary);
    const never = !chapter.summary;
    const eligible = force
      ? never || chapter.stale || chapterFilter !== null
      : never && allSummarized;
    if (!eligible) continue;
    if (chapter.edited && !(force && chapterFilter?.has(chapter.id))) continue;
    const text = (await generate(buildChapterSummaryPrompt(ws, chapter, chapterPrompt))).trim();
    if (!text) continue;
    chapter.summary = text;
    chapter.stale = false;
    if (force) chapter.edited = false;
    done.chapters.push(chapter.id);
  }

  return done;
}

// ---------------------------------------------------------------------------
// Embedding cache (memory_vectors.json)
// ---------------------------------------------------------------------------

const VECTORS_VERSION = 1;

/** djb2 — cheap change detection so edited texts re-embed. */
function textHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

export function loadMemoryVectors() {
  try {
    const raw = fs.readFileSync(getMemoryVectorsPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version === VECTORS_VERSION && parsed.vectors && typeof parsed.vectors === "object") {
      return parsed;
    }
  } catch {
    // regenerable cache — start fresh on any problem
  }
  return { version: VECTORS_VERSION, vectors: {} };
}

export function saveMemoryVectors(store) {
  fs.writeFileSync(
    getMemoryVectorsPath(),
    JSON.stringify(store) + "\n",
    "utf8"
  );
}

/** Text that represents an entry for retrieval purposes. */
export function memoryEntryText(entry, kind) {
  if (kind === "beat") return beatText(entry);
  const title = String(entry?.title ?? "").trim();
  const summary = String(entry?.summary ?? "").trim();
  return title && summary ? `${title}\n${summary}` : summary || title;
}

/**
 * Embed beats and scene summaries missing (or with out-of-date) vectors, and
 * prune vectors whose entries no longer exist. Mutates and returns the store.
 * Chapters are not embedded: their summaries are always in context (plan D5).
 * @returns {Promise<{ store: object, changed: boolean }>}
 */
export async function refreshMemoryVectors(ws, store) {
  let changed = false;
  const live = new Map();
  for (const b of ws.session_beats ?? []) {
    const t = memoryEntryText(b, "beat");
    if (b?.id && t) live.set(b.id, t);
  }
  for (const s of ws.scenes ?? []) {
    const t = memoryEntryText(s, "scene");
    if (s?.id && s.summary && t) live.set(s.id, t);
  }

  for (const id of Object.keys(store.vectors)) {
    if (!live.has(id)) {
      delete store.vectors[id];
      changed = true;
    }
  }

  for (const [id, text] of live) {
    const cur = store.vectors[id];
    const h = textHash(text);
    if (cur && cur.h === h && hasValidStoredEmbedding(cur.v)) continue;
    const vec = await getEmbedding(text);
    store.vectors[id] = { h, v: Array.from(vec) };
    changed = true;
  }

  return { store, changed };
}
