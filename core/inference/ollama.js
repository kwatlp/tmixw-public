/**
 * Ollama adapter (v0.8.0 plan D4) — native /api/generate with
 * newline-delimited JSON streaming ({ response: delta, done }).
 * Requires `inference.model` (the Ollama model tag, e.g. "mistral:7b").
 *
 * STUB-TESTED ONLY: no Ollama install exists on the dev machine as of
 * 2026-06-12 — live verification is a 0.8.x item. Built against the
 * documented stable API.
 */
import { postJsonWithRetry, findStopCut, estimateTokensFallback } from "./index.js";

function buildBody(model, prompt, g, stream) {
  return JSON.stringify({
    model,
    prompt,
    stream,
    // raw: the prompt is already fully templated by core/templates.js —
    // Ollama must not re-wrap it in the model's chat template.
    raw: true,
    options: {
      num_predict: g.max_length,
      temperature: g.temperature,
      top_p: g.top_p,
      ...(g.top_k ? { top_k: g.top_k } : {}),
      ...(g.rep_pen ? { repeat_penalty: g.rep_pen } : {}),
      stop: Array.isArray(g.stop_sequence) ? g.stop_sequence : [],
      ...(g.sampler_seed != null ? { seed: g.sampler_seed } : {})
    }
  });
}

/**
 * @param {{ url: string, model: string }} cfg
 * @param {typeof fetch} [fetchImpl] - injectable for tests
 */
export function createOllamaAdapter(cfg, fetchImpl = fetch) {
  const base = String(cfg.url ?? "").replace(/\/+$/, "");
  const model = String(cfg.model ?? "").trim();
  /** @type {AbortController | null} */
  let activeAbort = null;

  function requireModel() {
    if (!model) {
      throw new Error("Ollama backend needs inference.model (e.g. \"mistral:7b\").");
    }
  }

  async function generate(prompt, gen) {
    requireModel();
    const res = await postJsonWithRetry(`${base}/api/generate`, buildBody(model, prompt, gen, false), { fetchImpl });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama HTTP ${res.status}: ${text.slice(0, 200)}`.trim());
    }
    const json = await res.json();
    return String(json?.response ?? "").trim();
  }

  async function generateStream(prompt, gen, onText) {
    requireModel();
    activeAbort = new AbortController();
    try {
      const res = await fetchImpl(`${base}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: buildBody(model, prompt, gen, true),
        signal: activeAbort.signal
      });
      if (!res.ok || !res.body) {
        throw new Error(`Ollama stream HTTP ${res.status}`);
      }
      const stops = Array.isArray(gen.stop_sequence) ? gen.stop_sequence : [];
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      try {
        outer: for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let nl;
          while ((nl = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch {
              continue;
            }
            if (typeof evt.response === "string" && evt.response) {
              text += evt.response;
              const cutAt = findStopCut(text, stops);
              if (cutAt >= 0) {
                text = text.slice(0, cutAt);
                activeAbort.abort(); // Ollama cancels on disconnect
                break outer;
              }
              onText(text);
            }
            if (evt.done === true) break outer;
          }
        }
      } catch (e) {
        if (!activeAbort.signal.aborted) throw e;
      }
      return text.trim();
    } finally {
      activeAbort = null;
    }
  }

  async function abort() {
    if (activeAbort) activeAbort.abort();
  }

  async function modelInfo() {
    if (model) return { name: model };
    const res = await fetchImpl(`${base}/api/tags`);
    if (!res.ok) throw new Error(`Ollama tags HTTP ${res.status}`);
    const json = await res.json();
    return { name: String(json?.models?.[0]?.name ?? "") };
  }

  async function health() {
    try {
      const res = await fetchImpl(`${base}/api/tags`);
      if (!res.ok) throw new Error(`Ollama tags HTTP ${res.status}`);
      const json = await res.json();
      const names = (json?.models ?? []).map((m) => String(m?.name ?? ""));
      if (model && !names.includes(model)) {
        return {
          ok: false,
          error: `Model "${model}" not found on the Ollama server. Available: ${names.join(", ") || "(none)"}`
        };
      }
      return { ok: true, model: model || names[0] || "" };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async function countTokens(text) {
    return estimateTokensFallback(text);
  }

  return {
    id: "ollama",
    abortScope: "stream",
    generate,
    generateStream,
    abort,
    modelInfo,
    health,
    countTokens
  };
}
