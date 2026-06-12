// Model-free tests for the inference adapters (v0.8.0 M2/M3).
// All HTTP is stubbed; the KoboldCPP adapter's wire behavior is additionally
// live-verified (it is the default backend), the OpenAI-completions adapter
// is live-verified against KoboldCPP's /v1 endpoints, Ollama is stub-only
// until an install exists (0.8.x).
//
// Usage: npm run inference:test
import assert from "node:assert/strict";
import {
  buildInferenceRuntimeConfig,
  createInferenceAdapter,
  toBaseUrl,
  findStopCut,
  estimateTokensFallback,
  createCachedTokenCounter
} from "../core/inference/index.js";
import { createOpenAiCompletionsAdapter } from "../core/inference/openai_completions.js";
import { createOllamaAdapter } from "../core/inference/ollama.js";
import { createCustomAdapter } from "../core/inference/custom.js";

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

/** Fake streaming Response whose body yields the given strings as chunks. */
function streamResponse(chunks) {
  return {
    ok: true,
    body: (async function* () {
      for (const c of chunks) yield Buffer.from(c);
    })()
  };
}

const GEN = {
  max_length: 64,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  rep_pen: 1.1,
  stop_sequence: ["\nUser:", "</s>"]
};

// --- runtime config ----------------------------------------------------------

await check("config: absent block = koboldcpp via legacy koboldGenerateUrl", () => {
  const c = buildInferenceRuntimeConfig({ koboldGenerateUrl: "http://10.0.0.5:5001/api/v1/generate" });
  assert.equal(c.backend, "koboldcpp");
  assert.equal(c.url, "http://10.0.0.5:5001");
});

await check("config: backend defaults + explicit url wins; unknown backend → koboldcpp", () => {
  assert.equal(buildInferenceRuntimeConfig({ inference: { backend: "llamacpp" } }).url, "http://127.0.0.1:8080");
  assert.equal(buildInferenceRuntimeConfig({ inference: { backend: "ollama" } }).url, "http://127.0.0.1:11434");
  const c = buildInferenceRuntimeConfig({ inference: { backend: "llamacpp", url: "http://box:9999/" } });
  assert.equal(c.url, "http://box:9999");
  assert.equal(buildInferenceRuntimeConfig({ inference: { backend: "wat" } }).backend, "koboldcpp");
});

await check("config: adapter ids route correctly", () => {
  assert.equal(createInferenceAdapter(buildInferenceRuntimeConfig({})).id, "koboldcpp");
  assert.equal(createInferenceAdapter(buildInferenceRuntimeConfig({ inference: { backend: "llamacpp" } })).id, "openai");
  assert.equal(createInferenceAdapter(buildInferenceRuntimeConfig({ inference: { backend: "ollama" } })).id, "ollama");
  assert.equal(createInferenceAdapter(buildInferenceRuntimeConfig({ inference: { backend: "custom" } })).id, "custom");
});

await check("abortScope: global on koboldcpp, stream on openai/ollama, none on custom", () => {
  assert.equal(createInferenceAdapter(buildInferenceRuntimeConfig({})).abortScope, "global");
  assert.equal(createOpenAiCompletionsAdapter({ url: "http://s" }).abortScope, "stream");
  assert.equal(createOllamaAdapter({ url: "http://o", model: "m" }).abortScope, "stream");
  assert.equal(createCustomAdapter({ custom: {} }).abortScope, "none");
});

await check("helpers: toBaseUrl + findStopCut + estimate fallback", () => {
  assert.equal(toBaseUrl("http://h:1/api/v1/generate/"), "http://h:1");
  assert.equal(findStopCut("abc\nUser: hi", ["\nUser:"]), 3);
  assert.equal(findStopCut("clean", ["\nUser:"]), -1);
  assert.equal(estimateTokensFallback("abcdefgh"), 2);
});

// --- OpenAI-completions adapter (llama.cpp server et al.) --------------------

await check("openai: generate maps params (max_tokens, stop≤4, repeat_penalty)", async () => {
  let captured;
  const ad = createOpenAiCompletionsAdapter({ url: "http://s" }, async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ choices: [{ text: " Hello there. " }] }) };
  });
  const out = await ad.generate("P", { ...GEN, stop_sequence: ["a", "b", "c", "d", "e"] });
  assert.equal(out, "Hello there.");
  assert.equal(captured.url, "http://s/v1/completions");
  assert.equal(captured.body.max_tokens, 64);
  assert.equal(captured.body.repeat_penalty, 1.1);
  assert.equal(captured.body.stop.length, 4, "stop sliced to the OpenAI limit");
  assert.ok(!("stream" in captured.body));
});

await check("openai: stream accumulates deltas, ends on [DONE]", async () => {
  const ad = createOpenAiCompletionsAdapter({ url: "http://s" }, async () =>
    streamResponse([
      'data: {"choices":[{"text":"The ","finish_reason":null}]}\n\n',
      'data: {"choices":[{"text":"door","finish_reason":null}]}\n\ndata: {"choices":[{"text":" opens.","finish_reason":null}]}\n\n',
      "data: [DONE]\n\n"
    ])
  );
  const seen = [];
  const out = await ad.generateStream("P", GEN, (t) => seen.push(t));
  assert.equal(out, "The door opens.");
  assert.deepEqual(seen, ["The ", "The door", "The door opens."]);
});

await check("openai: client-side stop cut truncates and aborts", async () => {
  const ad = createOpenAiCompletionsAdapter({ url: "http://s" }, async () =>
    streamResponse([
      'data: {"choices":[{"text":"Reply.","finish_reason":null}]}\n\n',
      'data: {"choices":[{"text":"\\nUser: echo","finish_reason":null}]}\n\n',
      'data: {"choices":[{"text":"never seen","finish_reason":null}]}\n\n'
    ])
  );
  const out = await ad.generateStream("P", GEN, () => {});
  assert.equal(out, "Reply.");
});

await check("openai: modelInfo from /v1/models; health wraps it", async () => {
  const ad = createOpenAiCompletionsAdapter({ url: "http://s" }, async (url) => {
    assert.equal(url, "http://s/v1/models");
    return { ok: true, json: async () => ({ data: [{ id: "llama-3-8b" }] }) };
  });
  assert.deepEqual(await ad.modelInfo(), { name: "llama-3-8b" });
  assert.deepEqual(await ad.health(), { ok: true, model: "llama-3-8b" });
});

await check("openai: countTokens uses /tokenize when present, falls back otherwise", async () => {
  const withTokenize = createOpenAiCompletionsAdapter({ url: "http://s" }, async (url) =>
    url.endsWith("/tokenize")
      ? { ok: true, json: async () => ({ tokens: [1, 2, 3] }) }
      : { ok: false, status: 404 }
  );
  assert.equal(await withTokenize.countTokens("whatever"), 3);
  const without = createOpenAiCompletionsAdapter({ url: "http://s" }, async () => ({ ok: false, status: 404 }));
  assert.equal(await without.countTokens("abcdefgh"), 2);
});

await check("tryCountTokens: real count or null (never the estimate); shape per adapter", async () => {
  const withTokenize = createOpenAiCompletionsAdapter({ url: "http://s" }, async (url) =>
    url.endsWith("/tokenize")
      ? { ok: true, json: async () => ({ tokens: [1, 2, 3] }) }
      : { ok: false, status: 404 }
  );
  assert.equal(await withTokenize.tryCountTokens("whatever"), 3);
  const httpFail = createOpenAiCompletionsAdapter({ url: "http://s" }, async () => ({ ok: false, status: 404 }));
  assert.equal(await httpFail.tryCountTokens("abcdefgh"), null, "failure is null, not chars/4");
  const fetchFail = createOpenAiCompletionsAdapter({ url: "http://s" }, async () => {
    throw new Error("refused");
  });
  assert.equal(await fetchFail.tryCountTokens("abcdefgh"), null);

  // Backends with a tokenization endpoint expose it; the rest do not, which
  // is how the context assembler knows to keep the chars/4 budget.
  assert.equal(typeof createInferenceAdapter(buildInferenceRuntimeConfig({})).tryCountTokens, "function");
  assert.equal(createOllamaAdapter({ url: "http://o", model: "m" }).tryCountTokens, undefined);
  assert.equal(createCustomAdapter({ custom: {} }).tryCountTokens, undefined);
});

await check("createCachedTokenCounter: one call per unique text; failures not cached", async () => {
  let calls = 0;
  let fail = true;
  const cached = createCachedTokenCounter(async (t) => {
    calls++;
    if (fail) throw new Error("down");
    return t.length;
  });
  assert.equal(await cached("abc"), null);
  assert.equal(await cached("abc"), null);
  assert.equal(calls, 2, "null results are retried, not cached");
  fail = false;
  assert.equal(await cached("abc"), 3);
  assert.equal(await cached("abc"), 3);
  assert.equal(await cached("abc"), 3);
  assert.equal(calls, 3, "successful count cached after the first hit");
});

// --- Ollama adapter -----------------------------------------------------------

await check("ollama: generate requires model; maps options; raw mode set", async () => {
  const noModel = createOllamaAdapter({ url: "http://o", model: "" });
  await assert.rejects(() => noModel.generate("P", GEN), /inference\.model/);

  let captured;
  const ad = createOllamaAdapter({ url: "http://o", model: "mistral:7b" }, async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ response: " hi " }) };
  });
  assert.equal(await ad.generate("P", GEN), "hi");
  assert.equal(captured.url, "http://o/api/generate");
  assert.equal(captured.body.model, "mistral:7b");
  assert.equal(captured.body.raw, true, "templated prompt must not be re-wrapped");
  assert.equal(captured.body.options.num_predict, 64);
  assert.equal(captured.body.options.repeat_penalty, 1.1);
});

await check("ollama: stream parses JSON lines until done", async () => {
  const ad = createOllamaAdapter({ url: "http://o", model: "m" }, async () =>
    streamResponse([
      '{"response":"A","done":false}\n{"response":" tale","done":false}\n',
      '{"response":" begins.","done":false}\n{"response":"","done":true}\n'
    ])
  );
  const seen = [];
  const out = await ad.generateStream("P", GEN, (t) => seen.push(t));
  assert.equal(out, "A tale begins.");
  assert.equal(seen.length, 3);
});

await check("ollama: health flags a missing model with the available list", async () => {
  const ad = createOllamaAdapter({ url: "http://o", model: "absent:7b" }, async () => ({
    ok: true,
    json: async () => ({ models: [{ name: "mistral:7b" }, { name: "llama3:8b" }] })
  }));
  const h = await ad.health();
  assert.equal(h.ok, false);
  assert.ok(h.error.includes("absent:7b"));
  assert.ok(h.error.includes("mistral:7b"));
});

// --- Custom adapter -----------------------------------------------------------

await check("custom: template renders JSON-safely; responsePath walks arrays", async () => {
  let captured;
  const ad = createCustomAdapter(
    {
      custom: {
        url: "http://c/gen",
        headers: { Authorization: "Bearer x" },
        bodyTemplate: '{"prompt": {{prompt}}, "n": {{max_length}}, "stop": {{stop_json}}}',
        responsePath: "choices.0.text"
      }
    },
    async (url, init) => {
      captured = { url, headers: init.headers, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ choices: [{ text: " out " }] }) };
    }
  );
  const out = await ad.generate('He said "go"\nnow', GEN);
  assert.equal(out, "out");
  assert.equal(captured.body.prompt, 'He said "go"\nnow', "quotes/newlines survive");
  assert.equal(captured.body.n, 64);
  assert.deepEqual(captured.body.stop, ["\nUser:", "</s>"]);
  assert.equal(captured.headers.Authorization, "Bearer x");
});

await check("custom: missing config / bad path / no streaming all fail loudly", async () => {
  const empty = createCustomAdapter({ custom: {} });
  await assert.rejects(() => empty.generate("P", GEN), /custom\.url/);
  const badPath = createCustomAdapter(
    { custom: { url: "http://c", bodyTemplate: "{}", responsePath: "nope.deep" } },
    async () => ({ ok: true, json: async () => ({ other: 1 }) })
  );
  await assert.rejects(() => badPath.generate("P", GEN), /did not resolve/);
  await assert.rejects(() => badPath.generateStream("P", GEN, () => {}), /does not stream/);
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll inference tests passed");
process.exit(failures ? 1 : 0);
