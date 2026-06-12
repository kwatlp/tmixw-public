import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPipeline,
  resolvePipelineConfig,
  listDshowAudioDevices
} from "./pipeline.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "core", "config.json");
const NARRATIVE_SYSTEM_PATH = path.join(ROOT, "prompts", "narrative_system.txt");
const EXTRACTOR_SYSTEM_PATH = path.join(ROOT, "prompts", "extractor_system.txt");

function loadJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function loadTextIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function printBanner() {
  console.log("");
  console.log("tmixw — Phase 1 (Narrative + Extractor)");
  console.log("-----------------------------------------");
  console.log("Hold SPACE to talk. Release to send.");
  console.log("Ctrl+C to exit.");
  console.log("");
  if (fs.existsSync(CONFIG_PATH)) {
    console.log(`[config] loaded: ${CONFIG_PATH}`);
  } else {
    console.log("[config] none (using env vars / defaults)");
  }
  console.log("");
  console.log("Required env vars:");
  console.log("- WHISPER_BIN, WHISPER_MODEL");
  console.log("Required install:");
  console.log("- ffmpeg (must be on PATH, or set FFMPEG_BIN)");
  console.log("Optional env vars:");
  console.log("- FFMPEG_DSHOW_AUDIO (set if auto-mic selection fails)");
  console.log("");
  console.log("Tip: list mic devices with:");
  console.log("  npm run mic:list");
  console.log("");
}

function main() {
  const fileCfg = loadJsonIfExists(CONFIG_PATH) ?? {};
  const narrativeSystem =
    loadTextIfExists(NARRATIVE_SYSTEM_PATH)?.trim() ||
    "You are an in-world narrative roleplay assistant. Stay in character and respond naturally.";
  const extractorSystem =
    loadTextIfExists(EXTRACTOR_SYSTEM_PATH)?.trim() ||
    `You extract world state as JSON only. Keys: player_character, npcs, quests, locations, session_beat. player_character is ONLY the player's own sheet; everyone else goes in npcs.`;

  const resolved = resolvePipelineConfig(
    fileCfg,
    narrativeSystem,
    extractorSystem
  );

  printBanner();

  try {
    const devices = listDshowAudioDevices(resolved);
    if (devices.length) {
      console.log("[ffmpeg] detected audio devices (dshow):");
      for (const d of devices) console.log(`- ${d}`);
      console.log("");
    } else {
      console.log(
        "[ffmpeg] no audio devices detected via dshow. Run the list-devices command above and paste output."
      );
      console.log("");
    }
  } catch {
    // ignore; surfaced when attempting to record
  }

  const pipeline = createPipeline(resolved);

  pipeline.on("recording:start", ({ wavPath }) => {
    console.log(`[mic] recording... (${path.basename(wavPath)})`);
  });

  pipeline.on("recording:stop", ({ wavPath, durationMs }) => {
    if (
      typeof durationMs === "number" &&
      durationMs < resolved.minRecordMs
    ) {
      console.log(`[mic] ignored short recording (${durationMs}ms)`);
      return;
    }
    console.log(`\n[whisper] transcribing: ${path.basename(wavPath)}`);
  });

  pipeline.on("transcript", ({ text, beforeKobold }) => {
    if (beforeKobold) {
      console.log("\n[kobold] narrative + extractor (parallel)...");
      return;
    }
    if (!text) {
      console.log("[whisper] empty transcript (ignored)");
      return;
    }
    if (text === "[BLANK_AUDIO]") {
      console.log("[whisper] blank audio (ignored)");
      return;
    }
    console.log(`\nYou: ${text}`);
  });

  pipeline.on("narrative", ({ text }) => {
    console.log(`\nAssistant: ${text}\n`);
  });

  pipeline.on("extractor:ok", () => {
    console.log("[extractor] world_state.json updated (silent)");
  });

  pipeline.on("extractor:skip", ({ raw }) => {
    const s = String(raw ?? "");
    console.log(
      `[extractor] skipped (invalid JSON after retry). Snippet: ${s.slice(0, 160)}${s.length > 160 ? "..." : ""}`
    );
  });

  pipeline.on("error", ({ error, phase }) => {
    console.error(`\n[error]${phase ? ` (${phase})` : ""} ${error?.message ?? String(error)}`);
  });

  pipeline.on("stop", () => {
    process.exit(0);
  });

  process.once("SIGINT", () => {
    pipeline.stop();
  });

  pipeline.start();
}

main();
