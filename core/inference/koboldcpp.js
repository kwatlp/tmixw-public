/**
 * KoboldCPP adapter (v0.8.0 plan D2) — the default backend, and a verbatim
 * move of the generation code that lived in core/pipeline.js through v0.7.0:
 * behavior must be identical (same endpoints, same retry, same stop-cut
 * safety net). Verified against KoboldCPP 1.112.2.
 *
 * License boundary note: KoboldCPP is AGPL-3.0 and is invoked strictly as a
 * separate, user-supplied binary over local HTTP — see docs/LICENSE_BOUNDARY.md.
 */
import {
  postJsonWithRetry,
  sseDataEvents,
  findStopCut,
  estimateTokensFallback
} from "./index.js";

function buildBody(prompt, g) {
  return JSON.stringify({
    prompt,
    max_length: g.max_length,
    temperature: g.temperature,
    top_p: g.top_p,
    top_k: g.top_k,
    rep_pen: g.rep_pen,
    stop_sequence: g.stop_sequence,
    // Bans the EOS token (sprawling preset). Older KoboldCPP builds ignore
    // unknown params; stop_sequence/max_length still terminate generation.
    ...(g.antiEos ? { use_default_badwordsids: true } : {}),
    // Seeded sampling (A/B harness reproducibility).
    ...(g.sampler_seed != null ? { sampler_seed: g.sampler_seed } : {})
  });
}

/** @param {{ url: string }} cfg - inference runtime config (url = server base) */
export function createKoboldCppAdapter(cfg) {
  const base = String(cfg.url ?? "").replace(/\/+$/, "");

  async function generate(prompt, gen) {
    const res = await postJsonWithRetry(`${base}/api/v1/generate`, buildBody(prompt, gen));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`KoboldCPP HTTP ${res.status}: ${text}`.trim());
    }
    const json = await res.json();
    const out = json?.results?.[0]?.text ?? json?.result?.text ?? json?.text ?? "";
    return String(out).trim();
  }

  async function generateStream(prompt, gen, onText) {
    const res = await fetch(`${base}/api/extra/generate/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: buildBody(prompt, gen)
    });
    if (!res.ok || !res.body) {
      throw new Error(`KoboldCPP stream HTTP ${res.status}`);
    }
    const stops = Array.isArray(gen.stop_sequence) ? gen.stop_sequence : [];
    let text = "";
    for await (const data of sseDataEvents(res)) {
      let evt;
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (typeof evt.token === "string" && evt.token) {
        text += evt.token;
        // Safety net: cut on the earliest stop string if the server missed it.
        const cutAt = findStopCut(text, stops);
        if (cutAt >= 0) {
          text = text.slice(0, cutAt);
          abort().catch(() => {});
          break;
        }
        onText(text);
      }
      if (evt.finish_reason != null) break;
    }
    return text.trim();
  }

  async function abort() {
    const res = await fetch(`${base}/api/extra/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}"
    });
    if (!res.ok) throw new Error(`KoboldCPP abort HTTP ${res.status}`);
  }

  async function modelInfo() {
    const res = await fetch(`${base}/api/v1/model`);
    if (!res.ok) throw new Error(`KoboldCPP model HTTP ${res.status}`);
    const json = await res.json();
    return { name: String(json?.result ?? "") };
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
    try {
      const res = await fetch(`${base}/api/extra/tokencount`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: String(text ?? "") })
      });
      if (!res.ok) return null;
      const json = await res.json();
      const n = Number(json?.value);
      return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  async function countTokens(text) {
    return (await tryCountTokens(text)) ?? estimateTokensFallback(text);
  }

  return {
    id: "koboldcpp",
    abortScope: "global",
    generate,
    generateStream,
    abort,
    modelInfo,
    health,
    countTokens,
    tryCountTokens
  };
}
