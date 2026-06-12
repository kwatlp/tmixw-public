/**
 * Model-aware prompt templates (roadmap v4, v0.6.0; plan D5).
 * A thin format layer between the assembler's sections and the request body:
 * given the system block, the context blocks (pinned/chapters/lorebook/
 * retrieval/world, already budgeted and ordered), and the chat history,
 * render the completion prompt per model family.
 *
 * - `plain` is today's format and the fallback — it must stay byte-identical
 *   to the pre-template assembler output (context tests assert this). It
 *   returns `stopSequences: null`, meaning "keep the configured stops".
 * - Chat templates return their own stop sequences, replacing the hardcoded
 *   "\nUser:" pair.
 * - Detection is by model-name heuristics from KoboldCPP `/api/v1/model`;
 *   anything uncertain falls back to `plain`. Manual override:
 *   `narrative.template: "auto" | "plain" | "chatml" | "llama3" | "mistral"`.
 */

/** @typedef {{ role: "user" | "assistant", content: string }} HistoryMessage */
/** @typedef {{ systemBlock: string, blocks: string[], history: HistoryMessage[] }} TemplateInput */

/** Pre-template assembler format: plain completion text, `User:`/`Assistant:` lines. */
function renderPlain({ systemBlock, blocks, history }) {
  const lines = [systemBlock, ""];
  for (const b of blocks) lines.push(b, "");
  for (const m of history) {
    lines.push(`${m.role === "user" ? "User" : "Assistant"}: ${m.content}`.trim());
  }
  lines.push("Assistant:");
  return { prompt: lines.join("\n"), stopSequences: null };
}

/** System + context blocks as one system message body (chat templates). */
function systemBody({ systemBlock, blocks }) {
  return [systemBlock, ...blocks].join("\n\n");
}

function renderChatml(input) {
  const parts = [`<|im_start|>system\n${systemBody(input)}<|im_end|>\n`];
  for (const m of input.history) {
    parts.push(`<|im_start|>${m.role}\n${m.content}<|im_end|>\n`);
  }
  parts.push("<|im_start|>assistant\n");
  return {
    prompt: parts.join(""),
    stopSequences: ["<|im_end|>", "<|im_start|>"]
  };
}

// No <|begin_of_text|>: KoboldCPP prepends the BOS token itself.
function renderLlama3(input) {
  const parts = [
    `<|start_header_id|>system<|end_header_id|>\n\n${systemBody(input)}<|eot_id|>`
  ];
  for (const m of input.history) {
    parts.push(`<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
  }
  parts.push("<|start_header_id|>assistant<|end_header_id|>\n\n");
  return { prompt: parts.join(""), stopSequences: ["<|eot_id|>"] };
}

// Mistral has no system role: the system body folds into the first user turn.
function renderMistral(input) {
  const sys = systemBody(input);
  const parts = [];
  let sysInjected = false;
  for (const m of input.history) {
    if (m.role === "user") {
      const lead = sysInjected ? "" : `${sys}\n\n`;
      sysInjected = true;
      parts.push(`[INST] ${lead}${m.content} [/INST]`);
    } else {
      parts.push(` ${m.content}</s>`);
    }
  }
  if (!sysInjected) parts.unshift(`[INST] ${sys} [/INST]`);
  return { prompt: parts.join(""), stopSequences: ["</s>", "[INST]"] };
}

export const TEMPLATES = {
  plain: renderPlain,
  chatml: renderChatml,
  llama3: renderLlama3,
  mistral: renderMistral
};

export const TEMPLATE_NAMES = ["plain", "chatml", "llama3", "mistral"];

/** Valid template name or "plain" for anything unknown ("auto" is resolved by the caller). */
export function normalizeTemplateName(name) {
  const n = String(name ?? "").trim().toLowerCase();
  return TEMPLATE_NAMES.includes(n) ? n : "plain";
}

/**
 * @param {string} name - resolved template name (not "auto")
 * @param {TemplateInput} input
 * @returns {{ prompt: string, stopSequences: string[] | null }}
 */
export function renderTemplate(name, input) {
  const fn = TEMPLATES[normalizeTemplateName(name)];
  return fn(input);
}

/**
 * Model-name heuristics for `narrative.template: "auto"`. Conservative by
 * design: uncertain → "plain" (risk register: a mis-detected template garbles
 * output; plain merely loses some instruction-following polish).
 * @param {string} modelName - e.g. "koboldcpp/Mistral-7B-Instruct-v0.3.Q4_K_M"
 */
export function detectTemplateFromModelName(modelName) {
  const n = String(modelName ?? "").toLowerCase();
  if (!n) return "plain";
  if (/llama-?3/.test(n)) return "llama3";
  // Fine-tune markers before base-model names: e.g. OpenHermes-2.5-Mistral-7B
  // is ChatML-tuned even though "mistral" appears in the name.
  if (/qwen|hermes|dolphin|chatml|internlm|airoboros|openchat/.test(n)) return "chatml";
  if (/mistral|mixtral/.test(n)) return "mistral";
  return "plain";
}
