// Model-free tests for the prompt-template layer (v0.6.0 M5, plan D5).
// The hard guarantee: `plain` is byte-identical to the pre-template assembler
// output — context_test.js asserts the assembled prompt; here we assert the
// renderers and detection directly.
//
// Usage: npm run templates:test
import assert from "node:assert/strict";
import {
  renderTemplate,
  detectTemplateFromModelName,
  normalizeTemplateName,
  TEMPLATE_NAMES
} from "../core/templates.js";
import { assembleNarrativeContext, buildContextRuntimeConfig } from "../core/context.js";
import { defaultWorldState } from "../core/world_state.js";

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

const input = {
  systemBlock: "SYSTEM",
  blocks: ["[World snapshot]\n(no structured state yet)"],
  history: [
    { role: "user", content: "Hello." },
    { role: "assistant", content: "Hi there." },
    { role: "user", content: "What now?" }
  ]
};

await check("plain: User:/Assistant: lines, trailing Assistant:, null stops (keep config)", () => {
  const { prompt, stopSequences } = renderTemplate("plain", input);
  assert.equal(
    prompt,
    "SYSTEM\n\n[World snapshot]\n(no structured state yet)\n\nUser: Hello.\nAssistant: Hi there.\nUser: What now?\nAssistant:"
  );
  assert.equal(stopSequences, null);
});

await check("chatml: system message carries context blocks; ends with assistant header", () => {
  const { prompt, stopSequences } = renderTemplate("chatml", input);
  assert.ok(prompt.startsWith("<|im_start|>system\nSYSTEM\n\n[World snapshot]"));
  assert.ok(prompt.includes("<|im_start|>user\nHello.<|im_end|>"));
  assert.ok(prompt.includes("<|im_start|>assistant\nHi there.<|im_end|>"));
  assert.ok(prompt.endsWith("<|im_start|>assistant\n"));
  assert.deepEqual(stopSequences, ["<|im_end|>", "<|im_start|>"]);
});

await check("llama3: header/eot framing, no literal BOS (KoboldCPP adds it)", () => {
  const { prompt, stopSequences } = renderTemplate("llama3", input);
  assert.ok(!prompt.includes("<|begin_of_text|>"));
  assert.ok(prompt.startsWith("<|start_header_id|>system<|end_header_id|>\n\nSYSTEM"));
  assert.ok(prompt.includes("<|start_header_id|>user<|end_header_id|>\n\nHello.<|eot_id|>"));
  assert.ok(prompt.endsWith("<|start_header_id|>assistant<|end_header_id|>\n\n"));
  assert.deepEqual(stopSequences, ["<|eot_id|>"]);
});

await check("mistral: system folds into first user turn; pairs close with </s>", () => {
  const { prompt, stopSequences } = renderTemplate("mistral", input);
  assert.ok(prompt.startsWith("[INST] SYSTEM\n\n[World snapshot]"));
  assert.ok(prompt.includes("Hello. [/INST] Hi there.</s>"));
  assert.ok(prompt.endsWith("[INST] What now? [/INST]"));
  // System body appears exactly once.
  assert.equal(prompt.split("SYSTEM").length, 2);
  assert.deepEqual(stopSequences, ["</s>", "[INST]"]);
});

await check("mistral: empty history still produces a single [INST] with the system body", () => {
  const { prompt } = renderTemplate("mistral", { ...input, history: [] });
  assert.equal(prompt, "[INST] SYSTEM\n\n[World snapshot]\n(no structured state yet) [/INST]");
});

await check("detection: conservative heuristics, plain on uncertainty", () => {
  assert.equal(detectTemplateFromModelName("koboldcpp/Mistral-7B-Instruct-v0.3.Q4_K_M"), "mistral");
  assert.equal(detectTemplateFromModelName("Mixtral-8x7B-Instruct"), "mistral");
  assert.equal(detectTemplateFromModelName("Meta-Llama-3-8B-Instruct"), "llama3");
  assert.equal(detectTemplateFromModelName("llama3.1-70b"), "llama3");
  assert.equal(detectTemplateFromModelName("Qwen2.5-7B-Instruct"), "chatml");
  // Fine-tune marker (hermes → chatml) wins over the base-model name (mistral).
  assert.equal(detectTemplateFromModelName("OpenHermes-2.5-Mistral-7B"), "chatml");
  assert.equal(detectTemplateFromModelName("gpt2"), "plain");
  assert.equal(detectTemplateFromModelName(""), "plain");
});

await check("normalizeTemplateName: unknown → plain; all names round-trip", () => {
  assert.equal(normalizeTemplateName("alpaca"), "plain");
  assert.equal(normalizeTemplateName(" ChatML "), "chatml");
  for (const n of TEMPLATE_NAMES) assert.equal(normalizeTemplateName(n), n);
});

await check("assembler: template arg routes rendering; plain default unchanged", async () => {
  const cfg = {
    narrativeSystem: "SYS",
    narrativeLengthDirective: "",
    maxContextMessages: 4,
    lorebook: { maxEntries: 5, maxInjectChars: 3500, maxMatchMessages: null, vectorSimilarityThreshold: 0.35, vectorEnabled: false },
    context: buildContextRuntimeConfig({})
  };
  const session = { messages: [{ role: "user", content: "Hi." }] };
  const ws = defaultWorldState();
  const plain = await assembleNarrativeContext({
    session, worldState: ws, cfg, vectorStore: null, embedQuery: async () => null
  });
  assert.ok(plain.prompt.endsWith("User: Hi.\nAssistant:"));
  assert.equal(plain.stopSequences, null);
  assert.equal(plain.report.template, "plain");

  const chatml = await assembleNarrativeContext({
    session, worldState: ws, cfg, vectorStore: null, embedQuery: async () => null, template: "chatml"
  });
  assert.ok(chatml.prompt.endsWith("<|im_start|>assistant\n"));
  assert.deepEqual(chatml.stopSequences, ["<|im_end|>", "<|im_start|>"]);
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll template tests passed");
process.exit(failures ? 1 : 0);
