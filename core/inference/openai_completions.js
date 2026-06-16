/**
 * OpenAI-compatible text-completions adapter (v0.8.0 plan D3).
 * Backend ids: "llamacpp" and "openai" — llama.cpp server's recommended API
 * is exactly this surface, and it also covers LM Studio, vLLM,
 * text-generation-webui, and KoboldCPP's own /v1 endpoints (which is what
 * this adapter was live-verified against: standard chunks with
 * choices[0].text deltas and a terminal `data: [DONE]`).
 *
 * Param mapping: max_length→max_tokens, stop_sequence→stop (sliced to 4 per
 * the strict OpenAI limit), sampler_seed→seed. top_k/rep_pen ride along as
 * top_k/repeat_penalty — llama.cpp honors them, strict servers ignore them
 * (plan risk: never error on extra params). antiEos has no equivalent and
 * is dropped.
 */
import {
  postJsonWithRetry,
  sseDataEvents,
  findStopCut,
  estimateTokensFallback,
  normalizeFinishReason
} from "./index.js";

function buildBody(prompt, g, stream) {
  return JSON.stringify({
    prompt,
    max_tokens: g.max_length,
    temperature: g.temperature,
    top_p: g.top_p,
    stop: (Array.isArray(g.stop_sequence) ? g.stop_sequence : []).slice(0, 4),
    ...(g.top_k ? { top_k: g.top_k } : {}),
    ...(g.rep_pen ? { repeat_penalty: g.rep_pen } : {}),
    ...(g.sampler_seed != null ? { seed: g.sampler_seed } : {}),
    ...(stream ? { stream: true } : {})
  });
}

/**
 * @param {{ url: string }} cfg - inference runtime config (url = server base)
 * @param {typeof fetch} [fetchImpl] - injectable for tests
 */
export function createOpenAiCompletionsAdapter(cfg, fetchImpl = fetch) {
  const base = String(cfg.url ?? "").replace(/\/+$/, "");
  /** @type {AbortController | null} one in-flight generation at a time */
  let activeAbort = null;

  async function generate(prompt, gen) {
    const res = await postJsonWithRetry(`${base}/v1/completions`, buildBody(prompt, gen, false), { fetchImpl });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Completions HTTP ${res.status}: ${text.slice(0, 200)}`.trim());
    }
    const json = await res.json();
    return String(json?.choices?.[0]?.text ?? "").trim();
  }

  async function generateStream(prompt, gen, onText, onDone) {
    const done = typeof onDone === "function" ? onDone : () => {};
    activeAbort = new AbortController();
    try {
      const res = await fetchImpl(`${base}/v1/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildBody(prompt, gen, true),
        signal: activeAbort.signal
      });
      if (!res.ok || !res.body) {
        throw new Error(`Completions stream HTTP ${res.status}`);
      }
      const stops = Array.isArray(gen.stop_sequence) ? gen.stop_sequence : [];
      let text = "";
      try {
        for await (const data of sseDataEvents(res)) {
          if (data === "[DONE]") break;
          let evt;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          const delta = evt?.choices?.[0]?.text;
          if (typeof delta === "string" && delta) {
            text += delta;
            const cutAt = findStopCut(text, stops);
            if (cutAt >= 0) {
              text = text.slice(0, cutAt);
              done({ finishReason: "stopSequence" });
              // These servers cancel generation when the client disconnects.
              activeAbort.abort();
              break;
            }
            onText(text);
          }
          if (evt?.choices?.[0]?.finish_reason != null) {
            done({ finishReason: normalizeFinishReason(evt.choices[0].finish_reason) });
            break;
          }
        }
      } catch (e) {
        // Disconnect-after-abort surfaces as a fetch error mid-iteration;
        // the accumulated partial is the result (matches Stop semantics).
        if (!activeAbort.signal.aborted) throw e;
        done({ finishReason: "aborted" });
      }
      return text.trim();
    } finally {
      activeAbort = null;
    }
  }

  async function abort() {
    // No server-side abort endpoint on this API: cancelling the request
    // disconnects the stream and the server stops generating.
    if (activeAbort) activeAbort.abort();
  }

  async function modelInfo() {
    const res = await fetchImpl(`${base}/v1/models`);
    if (!res.ok) throw new Error(`Models HTTP ${res.status}`);
    const json = await res.json();
    return { name: String(json?.data?.[0]?.id ?? "") };
  }

  async function health() {
    try {
      const { name } = await modelInfo();
      return { ok: true, model: name };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async function tryCountTokens(text) {
    // llama.cpp server exposes a native /tokenize beside the OpenAI surface;
    // servers without it report null and callers fall back to the estimate.
    try {
      const res = await fetchImpl(`${base}/tokenize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: String(text ?? "") })
      });
      if (!res.ok) return null;
      const json = await res.json();
      return Array.isArray(json?.tokens) ? json.tokens.length : null;
    } catch {
      return null;
    }
  }

  async function countTokens(text) {
    return (await tryCountTokens(text)) ?? estimateTokensFallback(text);
  }

  return {
    id: "openai",
    abortScope: "stream",
    generate,
    generateStream,
    abort,
    modelInfo,
    health,
    countTokens,
    tryCountTokens
  };
}
