import fs from "node:fs";
import path from "node:path";
import { getPackageRoot } from "./app_paths.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const MAX_EMBED_CHARS = 8000;
const MIN_EMBED_DIM = 32;

/** @type {Promise<unknown> | null} */
let embedderPromise = null;

/**
 * Bundled MiniLM model dir (tech-debt session item 6 / FEATURE_CREEP #3):
 * `resources/models/` ships the four model files as a first-class resource so
 * embeddings never fetch from HuggingFace at boot (local-first, survives
 * reinstall). Mirrors bin_paths' bundled-resource resolution: packaged
 * Electron exposes `process.resourcesPath/models`, dev runs use the repo's
 * `resources/models`. Returns "" when the files aren't there (e.g. a fresh
 * clone before they're copied in) — transformers then keeps its default
 * cache-or-fetch behavior, so nothing breaks, it just isn't offline-safe.
 */
function bundledModelsDir() {
  const candidates = [];
  const rp = process.resourcesPath;
  if (rp && String(rp).trim()) candidates.push(path.join(rp, "models"));
  candidates.push(path.join(getPackageRoot(), "resources", "models"));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, MODEL_ID, "tokenizer_config.json"))) return dir;
  }
  return "";
}

function getEmbedPipeline() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      const modelsDir = bundledModelsDir();
      if (modelsDir) {
        env.localModelPath = modelsDir;
        env.allowRemoteModels = false;
      }
      return pipeline("feature-extraction", MODEL_ID);
    })();
  }
  return embedderPromise;
}
/**
 * @param {unknown} embedding
 */
export function hasValidStoredEmbedding(embedding) {
  if (!Array.isArray(embedding) || embedding.length < MIN_EMBED_DIM) return false;
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(Number(embedding[i]))) return false;
  }
  return true;
}

/** @returns {Promise<Float32Array>} */
export async function getEmbedding(text) {
  const raw = String(text ?? "").slice(0, MAX_EMBED_CHARS);
  const input = raw.trim().length ? raw : " ";
  const p = await getEmbedPipeline();
  const out = await p(input, { pooling: "mean", normalize: true });
  const data = out?.data;
  if (data instanceof Float32Array) return data;
  return new Float32Array(data ?? []);
}

/**
 * Cosine similarity in [-1, 1]; inputs may be TypedArray or number arrays.
 */
export function cosineSimilarity(a, b) {
  const n = a.length;
  if (n !== b.length || n === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function loreTextForEmbedding(entry) {
  const title = String(entry?.title ?? "").trim();
  const content = String(entry?.content ?? "").trim();
  const block = content ? `${title}\n\n${content}` : title;
  return block.slice(0, MAX_EMBED_CHARS);
}

/**
 * Computes and stores `embedding` on the entry (plain number[] for JSON).
 * @param {{ title?: string, content?: string, embedding?: unknown }} entry
 */
export async function embedLorebookEntry(entry) {
  const text = loreTextForEmbedding(entry);
  const vec = await getEmbedding(text);
  entry.embedding = Array.from(vec);
  return entry;
}

/**
 * Fills embeddings for lorebook entries that lack a valid `embedding`.
 * @param {{ lorebook?: unknown[] }} worldState
 */
export async function embedAllMissing(worldState) {
  const book = worldState?.lorebook;
  if (!Array.isArray(book)) return worldState;
  for (const e of book) {
    if (!e || typeof e !== "object") continue;
    if (hasValidStoredEmbedding(e.embedding)) continue;
    await embedLorebookEntry(e);
  }
  return worldState;
}
