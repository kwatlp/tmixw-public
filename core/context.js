// Deterministic narrator context assembly (roadmap v4, v0.5.0 item 3).
//
// Priority order (plan D5) under a fixed budget:
//   1. system prompt + style/length directives
//   2. pinned memories (always in context)
//   3. chapter summaries — the "story so far" spine
//   4. lorebook hits (existing keyword+vector merge, own char budget)
//   5. vector retrieval over beats and scene summaries
//   6. recency window of raw chat (message-count cap)
// Sections 2/3/5 share `cfg.context.memoryMaxChars`; overflow drops from the
// bottom of each section, never reorders. When the active inference adapter
// offers real tokenization (`tryCountTokens`, v0.8.0), the shared budget runs
// in real tokens (memoryMaxChars/4) and the report carries real counts; when
// no counter is wired in or the backend cannot tokenize, the original chars/4
// estimate path (plan D2) runs byte-identically.
//
// Every assembly produces a report (sections, sources, counts, drops) for the
// debug view — collection is cheap, so it is always on.
import { mergedLorebookMatches } from "./world_state.js";
import { getEmbedding, cosineSimilarity, hasValidStoredEmbedding } from "./embeddings.js";
import { memoryEntryText, findChapter, findScene } from "./memory.js";
import { renderTemplate } from "./templates.js";

/** chars/4 — conservative for English prose (plan D2). */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

export const CONTEXT_DEFAULTS = {
  /** Shared char budget for pinned + chapter summaries + retrieval. */
  memoryMaxChars: 6000,
  retrievalMaxEntries: 6,
  retrievalSimilarityThreshold: 0.35
};

/** @param {Record<string, unknown>} fileCfg - root of core/config.json */
export function buildContextRuntimeConfig(fileCfg) {
  const c = /** @type {Record<string, unknown>} */ (fileCfg?.context ?? {});
  return {
    memoryMaxChars: Math.max(0, Number(c.memoryMaxChars ?? CONTEXT_DEFAULTS.memoryMaxChars)),
    retrievalMaxEntries: Math.max(
      0,
      Math.min(20, Number(c.retrievalMaxEntries ?? CONTEXT_DEFAULTS.retrievalMaxEntries))
    ),
    retrievalSimilarityThreshold: Number(
      c.retrievalSimilarityThreshold ?? CONTEXT_DEFAULTS.retrievalSimilarityThreshold
    )
  };
}

export function buildWorldSummary(ws) {
  const lines = ["[World snapshot]"];
  if (ws.character && Object.keys(ws.character).length) {
    lines.push(`Character: ${JSON.stringify(ws.character)}`);
  }
  if (ws.npcs?.length) {
    // Status + notes, not just names: continuity facts ("dead", "Kael
    // returned the feather to him") live there, and a narrator that can't see
    // them replays settled events as if they were happening now (v0.6.0
    // consequence_recall finding).
    const npcs = ws.npcs
      .map((n) => {
        const name = String(n?.name ?? "").trim();
        if (!name) return "";
        const status = String(n?.status ?? "").trim();
        const notes = String(n?.notes ?? "").trim();
        let s = name;
        if (status) s += ` (${status})`;
        if (notes) s += ` — ${notes.length > 140 ? `${notes.slice(0, 140)}…` : notes}`;
        return s;
      })
      .filter(Boolean);
    lines.push(`NPCs: ${npcs.join("; ")}`);
  }
  if (ws.quests?.length) {
    lines.push(
      `Quests: ${ws.quests.map((q) => `${q.title} (${q.status})`).join("; ")}`
    );
  }
  if (ws.locations?.length) {
    lines.push(
      `Places: ${ws.locations.map((l) => l.name).filter(Boolean).join(", ")}`
    );
  }
  if (String(ws.current_location ?? "").trim()) {
    lines.push(`Currently at: ${String(ws.current_location).trim()}`);
  }
  if (lines.length === 1) lines.push("(no structured state yet)");
  return lines.join("\n");
}

export function buildLorebookMatchBlob(session, maxMessages) {
  const n = Math.max(1, maxMessages);
  return session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-n)
    .map((m) => m.content)
    .join("\n");
}

export function formatLorebookInjection(entries, maxChars) {
  if (!entries.length || maxChars <= 0) return "";
  const parts = [];
  let used = 0;
  for (const e of entries) {
    const title = String(e.title ?? "Untitled").trim() || "Untitled";
    const body = String(e.content ?? "");
    const header = `<< ${title} >>\n`;
    const block = `${header}${body}\n\n`;
    if (used + block.length <= maxChars) {
      parts.push(block.trimEnd());
      used += block.length;
      continue;
    }
    const overhead = header.length + 8;
    const room = maxChars - used - overhead;
    if (room < 24) break;
    parts.push(`${header}${body.slice(0, room)}…`);
    break;
  }
  return parts.join("\n\n");
}

/** One memory entry rendered as a context line. */
function memoryLine(ws, kind, entry) {
  if (kind === "beat") {
    const scene = entry.sceneId ? findScene(ws, entry.sceneId) : null;
    const chapter = scene ? findChapter(ws, scene.parentId) : null;
    const where = chapter?.title ? ` (${chapter.title})` : "";
    return `- ${memoryEntryText(entry, "beat")}${where}`;
  }
  if (kind === "scene") {
    const title = String(entry.title ?? "").trim();
    return `- ${title ? `${title}: ` : ""}${String(entry.summary ?? "").trim()}`;
  }
  const title = String(entry.title ?? "").trim();
  return `${title}: ${String(entry.summary ?? "").trim()}`;
}

/**
 * Greedy fill: append whole lines until the char budget runs out. Returns the
 * kept lines and how many were dropped (drop from the bottom, never reorder).
 */
function fillBudget(lines, maxChars) {
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > maxChars) {
      dropped++;
      continue;
    }
    kept.push(line);
    used += cost;
  }
  return { kept, used, dropped };
}

/** Same greedy fill with precomputed per-line costs (real token counts). */
function fillBudgetWithCosts(lines, costs, maxCost) {
  const kept = [];
  let used = 0;
  let dropped = 0;
  for (let i = 0; i < lines.length; i++) {
    if (used + costs[i] > maxCost) {
      dropped++;
      continue;
    }
    kept.push(lines[i]);
    used += costs[i];
  }
  return { kept, used, dropped };
}

/**
 * Cosine retrieval over beats + scene summaries using the memory-vector cache.
 * Pinned entries are excluded (already in context unconditionally).
 * @returns {{ kind: string, entry: object, score: number }[]} best-first
 */
export function retrieveMemories(ws, vectorStore, queryVec, opts) {
  const cap = opts.retrievalMaxEntries;
  if (!queryVec || cap <= 0) return [];
  const threshold = opts.retrievalSimilarityThreshold;
  const vectors = vectorStore?.vectors ?? {};
  const scored = [];
  const consider = (kind, entry) => {
    if (!entry?.id || entry.pinned) return;
    const rec = vectors[entry.id];
    if (!rec || !hasValidStoredEmbedding(rec.v)) return;
    const sim = cosineSimilarity(queryVec, rec.v);
    if (sim < threshold) return;
    scored.push({ kind, entry, score: sim });
  };
  for (const b of ws.session_beats ?? []) consider("beat", b);
  for (const s of ws.scenes ?? []) {
    if (s.summary) consider("scene", s);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap);
}

function pinnedEntries(ws) {
  const out = [];
  for (const c of ws.chapters ?? []) if (c.pinned) out.push({ kind: "chapter", entry: c });
  for (const s of ws.scenes ?? []) if (s.pinned) out.push({ kind: "scene", entry: s });
  for (const b of ws.session_beats ?? []) if (b.pinned) out.push({ kind: "beat", entry: b });
  return out;
}

/**
 * Assemble the narrator prompt and its debug report.
 *
 * @param {object} args
 * @param {{ messages: object[] }} args.session
 * @param {object} args.worldState
 * @param {object} args.cfg - resolved pipeline config (narrativeSystem, lorebook, context, maxContextMessages, narrativeLengthDirective)
 * @param {object | null} args.vectorStore - memory_vectors.json content (null = no retrieval)
 * @param {(text: string) => Promise<Float32Array>} [args.embedQuery] - injectable for tests
 * @param {(text: string) => Promise<number | null>} [args.countTokens] - real token counter (adapter `tryCountTokens`, ideally cached); null result = backend cannot tokenize. Omitted = chars/4 budget, byte-identical to pre-v0.8.x behavior.
 * @param {string} [args.extraDirective] - one-shot directive appended to the system block (v0.6.0 rewrite-with-instruction); empty = byte-identical output
 * @param {string} [args.template] - resolved template name (plan D5); "plain" = byte-identical pre-template output
 * @returns {Promise<{ prompt: string, report: object, stopSequences: string[] | null }>}
 */
export async function assembleNarrativeContext({
  session,
  worldState,
  cfg,
  vectorStore,
  embedQuery = getEmbedding,
  countTokens = null,
  extraDirective = "",
  template = "plain"
}) {
  const ws = worldState;
  const report = { ts: new Date().toISOString(), sections: [] };
  const bodies = [];
  const note = (label, body, extra = {}) => {
    report.sections.push({
      label,
      chars: body.length,
      estTokens: estimateTokens(body),
      ...extra
    });
    bodies.push(body);
  };
  const safeCount = (text) =>
    Promise.resolve()
      .then(() => countTokens(text))
      .then((n) => (Number.isFinite(n) && n >= 0 ? n : null))
      .catch(() => null);

  // 1. system + directives
  const systemParts = [cfg.narrativeSystem];
  if (cfg.narrativeLengthDirective) systemParts.push(cfg.narrativeLengthDirective);
  for (const d of cfg.narrativeStyleDirectives ?? []) systemParts.push(d);
  if (extraDirective) systemParts.push(extraDirective);
  const systemBlock = systemParts.join("\n");
  note("system", systemBlock);

  // Shared memory budget for sections 2/3/5, spent in priority order. Char
  // units by default; the first section that actually has candidate lines
  // decides — once, for the whole assembly — whether real token counting is
  // available. If it is, the budget switches to token units (memoryMaxChars/4,
  // floor: never spends more than the char-era intent) before anything is
  // spent. If not (no counter wired in, or the backend cannot tokenize), the
  // original char path runs untouched.
  let memoryBudget = cfg.context.memoryMaxChars;
  /** null = undecided, false = chars (estimate), true = real tokens */
  let tokenMode = countTokens ? null : false;
  const fillSection = async (lines) => {
    if (tokenMode !== false && lines.length) {
      const counts = await Promise.all(lines.map(safeCount));
      if (tokenMode === null) {
        tokenMode = counts.some((n) => n !== null);
        if (tokenMode) memoryBudget = Math.floor(cfg.context.memoryMaxChars / 4);
      }
      if (tokenMode) {
        const costs = lines.map((l, i) => counts[i] ?? estimateTokens(l));
        return fillBudgetWithCosts(lines, costs, memoryBudget);
      }
    }
    return fillBudget(lines, memoryBudget);
  };

  // 2. pinned memories
  const pinned = pinnedEntries(ws);
  let pinnedBlock = "";
  {
    const lines = pinned.map((p) => memoryLine(ws, p.kind, p.entry));
    const { kept, used, dropped } = await fillSection(lines);
    if (kept.length) pinnedBlock = ["[Pinned memories]", ...kept].join("\n");
    memoryBudget -= used;
    note("pinned", pinnedBlock, { count: kept.length, dropped });
  }

  // 3. chapter summaries — story so far
  let chaptersBlock = "";
  {
    const lines = (ws.chapters ?? [])
      .filter((c) => c.summary && !c.pinned)
      .map((c) => memoryLine(ws, "chapter", c));
    const { kept, used, dropped } = await fillSection(lines);
    if (kept.length) chaptersBlock = ["[Story so far]", ...kept].join("\n");
    memoryBudget -= used;
    note("chapters", chaptersBlock, { count: kept.length, dropped });
  }

  // 4. lorebook (existing merge logic, its own char budget)
  const matchWindow = cfg.lorebook.maxMatchMessages ?? cfg.maxContextMessages;
  const matchBlob = buildLorebookMatchBlob(session, matchWindow);
  const loreEntries = await mergedLorebookMatches(matchBlob, ws.lorebook ?? [], {
    maxEntries: cfg.lorebook.maxEntries,
    vectorSimilarityThreshold: cfg.lorebook.vectorSimilarityThreshold,
    vectorEnabled: cfg.lorebook.vectorEnabled
  });
  const loreBlock = formatLorebookInjection(loreEntries, cfg.lorebook.maxInjectChars);
  note("lorebook", loreBlock, {
    count: loreEntries.length,
    titles: loreEntries.map((e) => e.title)
  });

  // 5. vector retrieval over beats + scenes
  let retrievalBlock = "";
  let retrieved = [];
  if (vectorStore && cfg.context.retrievalMaxEntries > 0 && memoryBudget > 0 && matchBlob) {
    let queryVec = null;
    try {
      queryVec = await embedQuery(matchBlob);
    } catch {
      // embedding backend unavailable — retrieval silently degrades
    }
    retrieved = retrieveMemories(ws, vectorStore, queryVec, cfg.context);
    const lines = retrieved.map((r) => memoryLine(ws, r.kind, r.entry));
    const { kept, dropped } = await fillSection(lines);
    if (kept.length) retrievalBlock = ["[Recalled story events]", ...kept].join("\n");
    note("retrieval", retrievalBlock, {
      count: kept.length,
      dropped,
      matches: retrieved.map((r) => ({
        kind: r.kind,
        id: r.entry.id,
        score: Number(r.score.toFixed(4))
      }))
    });
  } else {
    note("retrieval", "", { count: 0, dropped: 0, matches: [] });
  }

  // 6. world snapshot + recency window
  const worldBlock = buildWorldSummary(ws);
  note("world", worldBlock);

  const history = session.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-cfg.maxContextMessages);
  const historyLines = history.map(
    (m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`.trim()
  );
  note("history", historyLines.join("\n"), { count: history.length });

  const blocks = [];
  if (pinnedBlock) blocks.push(pinnedBlock);
  if (chaptersBlock) blocks.push(chaptersBlock);
  if (loreBlock) {
    blocks.push(
      "[Lorebook — keyword + optional semantic retrieval from recent speech (see core/config lorebook)]\n" +
        loreBlock
    );
  }
  if (retrievalBlock) blocks.push(retrievalBlock);
  blocks.push(worldBlock);

  const { prompt, stopSequences } = renderTemplate(template, {
    systemBlock,
    blocks,
    history: history.map((m) => ({ role: m.role, content: m.content }))
  });

  report.template = template;
  report.totalChars = prompt.length;
  report.totalEstTokens = estimateTokens(prompt);

  // Real token counts in the report (token mode only): one count per section
  // body plus the final prompt. With a cached counter these are mostly cache
  // hits after the first turn; nulls (backend hiccup) simply omit the field —
  // estTokens stays as the honest approximation either way.
  if (tokenMode === true) {
    const counts = await Promise.all([...bodies, prompt].map(safeCount));
    const promptTokens = counts.pop();
    counts.forEach((n, i) => {
      if (n !== null) report.sections[i].tokens = n;
    });
    if (promptTokens !== null) report.totalTokens = promptTokens;
  }
  return { prompt, report, stopSequences };
}
