// Temporary diagnostic: drive the pipeline's PTT path headlessly and print
// every event with timing, to find where the voice flow stalls.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPipeline, resolvePipelineConfig } from "../core/pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const fileCfg = JSON.parse(fs.readFileSync(path.join(ROOT, "core", "config.json"), "utf8"));
const narrative = fs.readFileSync(path.join(ROOT, "prompts", "narrative_system.txt"), "utf8");
const extractor = fs.readFileSync(path.join(ROOT, "prompts", "extractor_system.txt"), "utf8");

const cfg = resolvePipelineConfig({ ...fileCfg, stdinPtt: false }, narrative, extractor);
console.log("[probe] voiceAutoSend:", cfg.voiceAutoSend, "| spaceReleaseMs:", cfg.spaceReleaseMs, "| minRecordMs:", cfg.minRecordMs);

const p = createPipeline(cfg);
const t0 = Date.now();
const log = (name) => (payload) => {
  const p = payload?.error instanceof Error
    ? { ...payload, error: payload.error.message }
    : payload;
  console.log(`[+${String(Date.now() - t0).padStart(5)}ms] ${name}`, JSON.stringify(p ?? {}).slice(0, 300));
};

for (const ev of ["ready", "recording:start", "recording:stop", "transcript", "transcript:draft", "narrative", "extractor:ok", "extractor:skip", "world:updated", "error", "stop"]) {
  p.on(ev, log(ev));
}

p.start();

// Hold PTT for 1.5s (pulse repeatedly like key-repeat does), then release.
p.setPttState(true);
const pulse = setInterval(() => p.setPttState(true), 200);
setTimeout(() => {
  clearInterval(pulse);
  p.setPttState(false);
  console.log(`[+${Date.now() - t0}ms] (released PTT)`);
}, 1500);

// Give whisper time, then exit.
setTimeout(() => {
  console.log("[probe] done");
  p.stop();
  process.exit(0);
}, 25000);
