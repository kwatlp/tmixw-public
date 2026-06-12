/**
 * Custom-endpoint escape hatch (v0.8.0 plan D5) — for backends none of the
 * first-party adapters speak. The player supplies the URL, a JSON body
 * template, and a dot-path to the completion text in the response.
 *
 * Config (inference.custom):
 *   url          - full endpoint URL (POST)
 *   headers      - extra request headers (e.g. Authorization)
 *   bodyTemplate - JSON text with placeholders:
 *                    {{prompt}}      → JSON string literal of the prompt
 *                    {{max_length}}  {{temperature}}  {{top_p}}
 *                    {{stop_json}}   → JSON array of stop strings
 *   responsePath - dot path to the text, e.g. "choices.0.text" or "response"
 *
 * Non-streaming only: the pipeline falls back to generate() when
 * generateStream throws, so streaming simply degrades.
 */
import { postJsonWithRetry, estimateTokensFallback } from "./index.js";

function renderTemplate(template, prompt, g) {
  return template
    .replaceAll("{{prompt}}", JSON.stringify(String(prompt)))
    .replaceAll("{{max_length}}", String(g.max_length ?? 220))
    .replaceAll("{{temperature}}", String(g.temperature ?? 0.8))
    .replaceAll("{{top_p}}", String(g.top_p ?? 0.95))
    .replaceAll("{{stop_json}}", JSON.stringify(g.stop_sequence ?? []));
}

function walkPath(obj, dotPath) {
  let cur = obj;
  for (const seg of String(dotPath).split(".")) {
    if (cur == null) return undefined;
    cur = cur[/^\d+$/.test(seg) ? Number(seg) : seg];
  }
  return cur;
}

/**
 * @param {{ custom: { url: string, headers: object, bodyTemplate: string, responsePath: string } }} cfg
 * @param {typeof fetch} [fetchImpl]
 */
export function createCustomAdapter(cfg, fetchImpl = fetch) {
  const c = cfg.custom ?? {};
  const url = String(c.url ?? "").trim();
  const headers = c.headers && typeof c.headers === "object" ? c.headers : {};
  const bodyTemplate = String(c.bodyTemplate ?? "");
  const responsePath = String(c.responsePath ?? "").trim();

  function requireConfig() {
    if (!url || !bodyTemplate || !responsePath) {
      throw new Error(
        "Custom backend needs inference.custom.url, .bodyTemplate, and .responsePath."
      );
    }
  }

  async function generate(prompt, gen) {
    requireConfig();
    const body = renderTemplate(bodyTemplate, prompt, gen);
    try {
      JSON.parse(body);
    } catch {
      throw new Error("Custom bodyTemplate does not render to valid JSON — check the placeholders.");
    }
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Custom endpoint HTTP ${res.status}: ${text.slice(0, 200)}`.trim());
    }
    const json = await res.json();
    const out = walkPath(json, responsePath);
    if (typeof out !== "string") {
      throw new Error(`Custom responsePath "${responsePath}" did not resolve to a string.`);
    }
    return out.trim();
  }

  async function generateStream() {
    throw new Error("Custom backend does not stream — falling back to non-streaming.");
  }

  async function abort() {
    // No generic abort; non-streaming requests just complete.
  }

  async function modelInfo() {
    return { name: "custom endpoint" };
  }

  /** Validate-on-save: one tiny real completion proves the whole chain. */
  async function health() {
    try {
      requireConfig();
      const out = await generate("ping", {
        max_length: 1,
        temperature: 0,
        top_p: 1,
        stop_sequence: []
      });
      return { ok: true, model: `custom endpoint (replied ${out.length} chars)` };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async function countTokens(text) {
    return estimateTokensFallback(text);
  }

  return {
    id: "custom",
    abortScope: "none",
    generate,
    generateStream,
    abort,
    modelInfo,
    health,
    countTokens
  };
}
