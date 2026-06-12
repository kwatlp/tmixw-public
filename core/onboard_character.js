import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadWorldState,
  saveWorldState,
  mergeCharacterCard,
  getWorldStatePath
} from "./world_state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "core", "config.json");
const ONBOARD_PROMPT_PATH = path.join(ROOT, "prompts", "character_onboard.txt");

function loadJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

const defaultOnboardGen = {
  max_length: 600,
  temperature: 0.25,
  top_p: 0.9,
  top_k: 0,
  rep_pen: 1.05,
  // No "```" stop — models that open with a ```json fence would return empty.
  stop_sequence: ["\nUser:", "\nAssistant:"]
};

function extractJsonObject(text) {
  const s = String(text).trim();
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function tryParseCard(raw) {
  const slice = extractJsonObject(raw) ?? String(raw).trim();
  try {
    const o = JSON.parse(slice);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    return o;
  } catch {
    return null;
  }
}

async function koboldGenerate(url, prompt, gen) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      max_length: gen.max_length,
      temperature: gen.temperature,
      top_p: gen.top_p,
      top_k: gen.top_k,
      rep_pen: gen.rep_pen,
      stop_sequence: gen.stop_sequence
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`KoboldCPP HTTP ${res.status}: ${text}`.trim());
  }
  const json = await res.json();
  const out =
    json?.results?.[0]?.text ??
    json?.result?.text ??
    json?.text ??
    "";
  return String(out).trim();
}

function readProse() {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf("--file");
  if (fileIdx >= 0 && argv[fileIdx + 1]) {
    return fs.readFileSync(path.resolve(argv[fileIdx + 1]), "utf8").trim();
  }
  const filtered = argv.filter((a) => a !== "--replace");
  if (filtered.length) return filtered.join(" ").trim();
  return fs.readFileSync(0, "utf8").trim();
}

async function main() {
  const fileCfg = loadJsonIfExists(CONFIG_PATH) ?? {};
  const url =
    process.env.KOBOLD_GENERATE_URL ??
    fileCfg.koboldGenerateUrl ??
    "http://127.0.0.1:5001/api/v1/generate";
  const onboardGen = { ...defaultOnboardGen, ...(fileCfg.characterOnboard ?? {}) };

  const system =
    fs.existsSync(ONBOARD_PROMPT_PATH) ?
      fs.readFileSync(ONBOARD_PROMPT_PATH, "utf8").trim()
    : "Return only JSON character key-value object.";

  const prose = readProse();
  if (!prose) {
    console.error(
      "Usage: npm run char:onboard -- \"Your character prose…\"\n   or: npm run char:onboard -- --file path\\to.txt\n   or: pipe prose into stdin."
    );
    process.exit(1);
  }

  const replace = process.argv.includes("--replace");
  const ws = loadWorldState();
  const existing = replace ? {} : { ...ws.character };

  const prompt = `${system}

Existing character JSON (merge; may be empty):
${JSON.stringify(existing, null, 2)}

Player describes their character:
${prose}

Return ONLY the JSON object.`;

  console.log("[char:onboard] calling KoboldCPP…");
  let raw = await koboldGenerate(url, prompt, onboardGen);
  let card = tryParseCard(raw);
  if (!card) {
    const repair = `${prompt}\n\nYour previous reply was not valid JSON. Return ONLY one valid JSON object. No markdown.`;
    raw = await koboldGenerate(url, repair, onboardGen);
    card = tryParseCard(raw);
  }
  if (!card) {
    console.error("[char:onboard] failed to parse JSON. Raw snippet:\n", raw.slice(0, 500));
    process.exit(1);
  }

  if (replace) {
    ws.character = {};
  }
  mergeCharacterCard(ws, card);
  saveWorldState(ws);
  console.log("[char:onboard] merged into", getWorldStatePath());
  console.log(JSON.stringify(ws.character, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
