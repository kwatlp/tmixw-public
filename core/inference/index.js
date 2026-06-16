/**
 * Inference backend abstraction (roadmap v4, v0.8.0; plan D1).
 * Mirrors the proven core/stt/ pattern: a config block selects an adapter,
 * the rest of the app talks to one interface. Adapters sit BELOW the
 * pipeline's `_generate` / `_generateStream` test seams — model-free tests
 * keep stubbing those and never construct adapters.
 *
 * Adapter interface (all async unless noted):
 *   id              - backend id string
 *   abortScope      - "stream" (abort() only cancels the adapter's own
 *                     in-flight stream), "global" (abort() kills whatever
 *                     the backend is generating — KoboldCPP's single slot),
 *                     or "none" (no abort support); sync property
 *   generate(prompt, gen)            → string (full completion)
 *   generateStream(prompt, gen, onText, onDone?) → string; onText(accumulated)
 *                     per chunk; throws on transport failure or when the
 *                     backend cannot stream — callers fall back to generate().
 *                     `onDone({ finishReason })` (optional) fires once when the
 *                     stream ends with a known reason — see normalizeFinishReason.
 *                     The return value stays the plain text; onDone is the
 *                     additive side channel for the message-fin indicator (doc 03).
 *   abort()         - stop the in-flight generation server-side (best effort)
 *   modelInfo()     → { name } (template detection, validate display)
 *   health()        → { ok, model?, error? } (validate-on-save)
 *   countTokens(text) → number (real count when the backend offers one,
 *                     chars/4 otherwise)
 *   tryCountTokens(text) → number | null (optional: real count or null when
 *                     the backend cannot tokenize — lets callers distinguish
 *                     a real count from the estimate; absent on adapters
 *                     without a tokenization endpoint)
 *
 * `gen` uses tmixw's internal shape ({ max_length, temperature, top_p,
 * top_k, rep_pen, stop_sequence, antiEos, sampler_seed? }); adapters map
 * what their wire format supports and silently drop the rest (plan risk:
 * never error on extra params).
 *
 * Config block (core/config.json):
 *   "inference": { "backend": "koboldcpp" | "llamacpp" | "openai" |
 *                  "ollama" | "custom", "url": "", "model": "",
 *                  "custom": { ... } }
 * Absent block = KoboldCPP with the legacy `koboldGenerateUrl` — existing
 * configs run untouched (plan D2).
 */
import { createKoboldCppAdapter } from "./koboldcpp.js";
import { createOpenAiCompletionsAdapter } from "./openai_completions.js";
import { createOllamaAdapter } from "./ollama.js";
import { createCustomAdapter } from "./custom.js";

export const INFERENCE_BACKENDS = ["koboldcpp", "llamacpp", "openai", "ollama", "custom"];

const DEFAULT_URLS = {
  koboldcpp: "http://127.0.0.1:5001",
  llamacpp: "http://127.0.0.1:8080",
  openai: "http://127.0.0.1:8080",
  ollama: "http://127.0.0.1:11434"
};

/** chars/4 — same estimate the context assembler uses. */
export function estimateTokensFallback(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/**
 * Memoize an adapter's `tryCountTokens` by exact text (token counts are
 * tokenizer-specific, so the cache must be rebuilt with the adapter).
 * Memory/context lines are stable across turns, which makes assembly-time
 * counting mostly cache hits after the first turn — that is what keeps real
 * tokenization inside the context-assembly latency budget. Failures (null)
 * are not cached so a backend that comes back starts answering again.
 * @param {(text: string) => Promise<number | null>} countFn
 * @returns {(text: string) => Promise<number | null>}
 */
export function createCachedTokenCounter(countFn, cap = 1024) {
  const cache = new Map();
  return async function cachedCount(text) {
    const key = String(text ?? "");
    if (cache.has(key)) return cache.get(key);
    let n = null;
    try {
      n = await countFn(key);
    } catch {
      n = null;
    }
    if (!Number.isFinite(n) || n < 0) return null;
    if (cache.size >= cap) cache.delete(cache.keys().next().value);
    cache.set(key, n);
    return n;
  };
}

/** Strip a legacy full generate URL down to the server base. */
export function toBaseUrl(url) {
  return String(url ?? "")
    .trim()
    .replace(/\/api\/v1\/generate\/?$/, "")
    .replace(/\/+$/, "");
}

/**
 * Resolve the `inference` runtime block from `core/config.json` content.
 * Back-compat (plan D2): when the backend is koboldcpp and no explicit
 * `inference.url` is set, the legacy `koboldGenerateUrl` (or its env
 * override) supplies the base URL.
 * @param {Record<string, unknown>} fileCfg
 */
export function buildInferenceRuntimeConfig(fileCfg) {
  const inf = /** @type {Record<string, unknown>} */ (fileCfg?.inference ?? {});
  const backend = INFERENCE_BACKENDS.includes(String(inf.backend ?? "").trim())
    ? String(inf.backend).trim()
    : "koboldcpp";
  const legacyKobold =
    process.env.KOBOLD_GENERATE_URL ??
    fileCfg?.koboldGenerateUrl ??
    `${DEFAULT_URLS.koboldcpp}/api/v1/generate`;
  const url = String(inf.url ?? "").trim()
    ? toBaseUrl(inf.url)
    : backend === "koboldcpp"
      ? toBaseUrl(legacyKobold)
      : DEFAULT_URLS[backend] ?? "";
  const custom = /** @type {Record<string, unknown>} */ (inf.custom ?? {});
  return {
    backend,
    url,
    model: String(inf.model ?? "").trim(),
    custom: {
      url: String(custom.url ?? "").trim(),
      headers: custom.headers && typeof custom.headers === "object" ? custom.headers : {},
      bodyTemplate: String(custom.bodyTemplate ?? ""),
      responsePath: String(custom.responsePath ?? "")
    }
  };
}

/**
 * POST JSON with the queue-pressure retry KoboldCPP needed (shared by all
 * HTTP adapters): transient connection drops retry a couple of times before
 * declaring the backend unreachable.
 */
export async function postJsonWithRetry(url, body, { retries = 2, signal, fetchImpl = fetch } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        ...(signal ? { signal } : {})
      });
    } catch (e) {
      if (signal?.aborted) throw e;
      const msg = e?.message ?? String(e);
      if (attempt < retries) {
        console.warn(
          `[inference] fetch failed (attempt ${attempt + 1}/${retries + 1}), retrying: ${msg}`
        );
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error(`Failed to reach inference backend at ${url}.\n${msg}`);
    }
  }
}

/**
 * Iterate `data:` payload strings from an SSE response body, handling
 * block buffering. Yields the raw data string per event.
 * @param {Response} res
 */
export async function* sseDataEvents(res) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
      const dataLine = block.split(/\r?\n/).find((l) => l.startsWith("data:"));
      if (dataLine) yield dataLine.slice(5).trim();
    }
  }
}

/**
 * Normalize a backend's raw finish/done reason into the fin indicator's
 * vocabulary (doc 03 §3.1). `"length"` (hit the token ceiling — truncated)
 * vs `"stop"` (natural EOS / a provider stop string — complete). Our own
 * client-side stop-sequence cut is reported separately as `"stopSequence"`,
 * and a user Stop as `"aborted"`; both are natural, not truncation.
 * @param {unknown} raw
 * @returns {"length" | "stop" | "unknown"}
 */
export function normalizeFinishReason(raw) {
  const s = String(raw ?? "").toLowerCase();
  if (s === "length" || s === "max_tokens") return "length";
  if (s === "stop" || s === "eos" || s === "stop_sequence" || s === "end_turn") return "stop";
  return "unknown";
}

/**
 * Earliest stop-string cut for client-side safety nets.
 * @returns {number} index to cut at, or -1
 */
export function findStopCut(text, stops) {
  let cutAt = -1;
  for (const s of Array.isArray(stops) ? stops : []) {
    if (!s) continue;
    const i = text.indexOf(s);
    if (i >= 0 && (cutAt < 0 || i < cutAt)) cutAt = i;
  }
  return cutAt;
}

/**
 * @param {ReturnType<typeof buildInferenceRuntimeConfig>} infCfg
 */
export function createInferenceAdapter(infCfg) {
  const cfg = infCfg ?? buildInferenceRuntimeConfig({});
  switch (cfg.backend) {
    case "llamacpp":
    case "openai":
      return createOpenAiCompletionsAdapter(cfg);
    case "ollama":
      return createOllamaAdapter(cfg);
    case "custom":
      return createCustomAdapter(cfg);
    case "koboldcpp":
    default:
      return createKoboldCppAdapter(cfg);
  }
}
