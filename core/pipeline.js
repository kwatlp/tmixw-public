import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import {
  loadWorldState,
  saveWorldState,
  applyExtractorDiff,
  buildExtractorSnapshot,
  buildLoreRuntimeConfig,
  resetWorldSections,
  backupWorldStateFile,
  RESETTABLE_SECTIONS,
  recordCorrection,
  undoLastCorrection
} from "./world_state.js";
import { appendEvent } from "./events.js";
import {
  getWritableCoreDir,
  getActiveWorldDir,
  getSessionPath,
  getRecordingsDir,
  getMemoryVectorsPath
} from "./app_paths.js";
import { loadGmBestiary } from "./story_templates.js";
import {
  resolveFfmpegBin,
  resolveWhisperBin,
  resolveWhisperModel
} from "./bin_paths.js";
import { createSttAdapter } from "./stt/index.js";
import { LENGTH_PRESETS, normalizeLengthPreset, deriveCeiling } from "./length_presets.js";
import { normalizeStyle, buildStyleDirectives, buildLengthDirective } from "./style_presets.js";
import { detectTemplateFromModelName, normalizeTemplateName } from "./templates.js";
import {
  buildMemoryRuntimeConfig,
  detectSceneBoundary,
  endScene,
  startChapter,
  editBeat,
  deleteBeat,
  deleteScene,
  deleteChapter,
  editSceneSummary,
  editChapterSummary,
  setSceneTitle,
  setChapterTitle,
  setPinned,
  runSummarization,
  loadMemoryVectors,
  saveMemoryVectors,
  refreshMemoryVectors
} from "./memory.js";
import {
  assembleNarrativeContext,
  buildContextRuntimeConfig
} from "./context.js";
import {
  createInferenceAdapter,
  buildInferenceRuntimeConfig,
  createCachedTokenCounter,
  estimateTokensFallback
} from "./inference/index.js";
import { buildConfirmOpeningDirective } from "./character/opening.js";
import { DEFAULT_RULES } from "./engine/rules.js";
import { classifyIntent } from "./engine/intent.js";
import { runReferee, looksLikeAction } from "./engine/referee.js";
import { resolve as resolveMechanics, renderMechanicsDirective } from "./engine/resolve.js";
import { sanitizeNarration } from "./engine/sanitize.js";
import { applyDeltas } from "./engine/apply.js";
import { makeRng } from "./engine/rng.js";

/** Re-export for callers that previously imported `SESSION_PATH` from this module. */
export { getSessionPath };

/**
 * Build runtime pipeline options from `config.json` content + resolved system prompts + `process.env`.
 * Caller reads `core/config.json` and prompt files; this merges defaults and env overrides.
 * @param {Record<string, unknown>} fileCfg
 * @param {string} narrativeSystem
 * @param {string} extractorSystem
 */
export function resolvePipelineConfig(fileCfg, narrativeSystem, extractorSystem, loreCorrectionSystem = "") {
  const pttCfg = /** @type {Record<string, unknown>} */ (
    fileCfg.pushToTalk ?? {}
  );

  const defaultNarrativeGen = {
    max_length: 220,
    temperature: 0.8,
    top_p: 0.95,
    top_k: 0,
    rep_pen: 1.08,
    stop_sequence: ["\nUser:", "\nAssistant:"]
  };
  const defaultExtractorGen = {
    max_length: 512,
    temperature: 0.2,
    top_p: 0.9,
    top_k: 0,
    rep_pen: 1.05,
    // No "```" stop: models that open with a ```json fence would stop at the
    // fence and return empty (found via the eval harness on Mistral 7B).
    // extractJsonObject() brace-matches, so fences and trailing text are harmless.
    stop_sequence: ["\nUser:", "\nAssistant:"],
    // D2 (v0.6.0): the accepted narrator reply is part of the extractor input
    // (NPC names, locations, and outcomes mostly appear there, not in the
    // player's words). `extractor.includeNarrative: false` is the escape hatch.
    includeNarrative: true
  };
  const narrativeGen = {
    ...defaultNarrativeGen,
    ...(/** @type {object} */ (fileCfg.narrative ?? {}))
  };
  const lengthPreset = normalizeLengthPreset(
    /** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {}).lengthPreset
  );
  const preset = lengthPreset !== "custom" ? LENGTH_PRESETS[lengthPreset] : null;
  const style = normalizeStyle(
    /** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {}).style
  );
  // Length is a soft target (design doc 06): the preset's `target` drives the
  // directive, while the backend cap (`max_length`) is a *ceiling* derived as
  // target × headroom — a backstop, not the aimed size. `custom` keeps the
  // player's manual slider value as the literal ceiling (back-compat).
  const lengthTarget = preset ? preset.target : null;
  if (preset) {
    narrativeGen.max_length = deriveCeiling(preset.target);
  }
  const lengthCeiling = Number(narrativeGen.max_length) || null;
  const narrativeLengthDirective = buildLengthDirective({
    lengthPreset,
    customMaxLength: lengthCeiling
  });
  const extractorGen = {
    ...defaultExtractorGen,
    ...(/** @type {object} */ (fileCfg.extractor ?? {}))
  };
  const loreCorrectionGen = {
    ...defaultExtractorGen,
    ...(/** @type {object} */ (fileCfg.loreCorrection ?? {}))
  };
  // Scene/chapter summary roll-ups (v0.5.0): low temperature, prose stops.
  const defaultSummarizerGen = {
    max_length: 200,
    temperature: 0.3,
    top_p: 0.9,
    top_k: 0,
    rep_pen: 1.05,
    stop_sequence: ["\nUser:", "\nAssistant:"]
  };
  const summarizerGen = {
    ...defaultSummarizerGen,
    ...(/** @type {object} */ (fileCfg.summarizer ?? {}))
  };
  const loreDefaults = buildLoreRuntimeConfig(fileCfg);
  const uiBlock = /** @type {Record<string, unknown>} */ (fileCfg.ui ?? {});

  return {
    /** When false, skip raw stdin PTT; use {@link LocalPipeline#setPttState} from Electron or programmatic PTT. Default true. */
    stdinPtt: fileCfg.stdinPtt !== false,
    /** UI-only block from `core/config.json` (background, border). */
    ui: uiBlock,
    narrativeSystem,
    extractorSystem,
    loreCorrectionSystem,
    /** One-shot system directive for a world's very first narrator turn (story-template onboarding, v0.9.0 D5). Electron main resolves it from the active world's world.json. In "app-forge" mode this carries the post-creation opening hint instead of the legacy forge prose. */
    narrativeFirstTurnDirective: String(fileCfg.narrativeFirstTurnDirective ?? ""),
    /** Onboarding handoff (design doc 01 §10): "app-forge" defers the opening until the app writes a structured sheet, then confirms it; anything else runs the legacy narrator forge. */
    narrativeOnboardingMode:
      String(fileCfg.narrativeOnboardingMode ?? "") === "app-forge" ? "app-forge" : "narrator-forge",
    /** Interaction-engine rules (design doc 02), resolved from the active template at boot; null ⇒ engine defaults. */
    rules: fileCfg.rules ?? null,
    koboldGenerateUrl:
      process.env.KOBOLD_GENERATE_URL ??
      fileCfg.koboldGenerateUrl ??
      "http://127.0.0.1:5001/api/v1/generate",
    /** Inference backend selection (v0.8.0 D1/D7). Default: KoboldCPP via the legacy URL. */
    inference: buildInferenceRuntimeConfig(fileCfg),
    sttBackend: fileCfg.sttBackend ?? "whisper-cpp",
    sttCustomBin: fileCfg.sttCustomBin ?? "",
    sttCustomArgs: fileCfg.sttCustomArgs ?? "",
    whisperBin:
      process.env.WHISPER_BIN ?? resolveWhisperBin(fileCfg) ?? "",
    whisperModel:
      process.env.WHISPER_MODEL ?? resolveWhisperModel(fileCfg) ?? "",
    whisperLanguage: process.env.WHISPER_LANGUAGE ?? "en",
    whisperThreads: Number(process.env.WHISPER_THREADS ?? "6"),
    maxContextMessages: Number(process.env.MAX_CONTEXT_MESSAGES ?? "16"),
    lorebook: {
      maxEntries: loreDefaults.maxEntries,
      maxInjectChars: loreDefaults.maxInjectChars,
      maxMatchMessages: loreDefaults.maxMatchMessages,
      vectorSimilarityThreshold: loreDefaults.vectorSimilarityThreshold,
      vectorEnabled: loreDefaults.vectorEnabled
    },
    spaceReleaseMs: Number(
      process.env.SPACE_RELEASE_MS ?? pttCfg.spaceReleaseMs ?? "750"
    ),
    restartDebounceMs: Number(
      process.env.RESTART_DEBOUNCE_MS ?? pttCfg.restartDebounceMs ?? "400"
    ),
    minRecordMs: Number(process.env.MIN_RECORD_MS ?? pttCfg.minRecordMs ?? "350"),
    /** When true, voice transcription runs the turn immediately (pre-v0.4 behavior). Default: draft into the input field. */
    voiceAutoSend: pttCfg.autoSend === true,
    sampleRateHz: Number(process.env.SAMPLE_RATE_HZ ?? "16000"),
    ffmpegBin: process.env.FFMPEG_BIN ?? resolveFfmpegBin(fileCfg) ?? "ffmpeg",
    ffmpegBackend: process.env.FFMPEG_BACKEND ?? defaultFfmpegBackend(),
    ffmpegDshowAudioDevice:
      process.env.FFMPEG_DSHOW_AUDIO ?? fileCfg.ffmpegDshowAudioDevice ?? "",
    narrative: narrativeGen,
    extractor: extractorGen,
    loreCorrection: loreCorrectionGen,
    summarizer: summarizerGen,
    /** Memory roll-up behavior (scene boundaries, auto-summarize). */
    memory: buildMemoryRuntimeConfig(fileCfg),
    /** Narrator context budget (memory sections + retrieval). */
    context: buildContextRuntimeConfig(fileCfg),
    narrativeLengthPreset: lengthPreset,
    /** Soft-target size the narration aims for (doc 06); null for the custom slider. */
    narrativeLengthTarget: lengthTarget,
    /** Derived backend ceiling (target × headroom, clamped); the cap, not the aim. */
    narrativeLengthCeiling: lengthCeiling,
    narrativeLengthDirective,
    /**
     * Token budget for the unprompted story-template opening turn (welcome +
     * full Character Forge in one message). The opening is far longer than any
     * per-turn length preset (Brief=120 … Sprawling=700), so it gets its own
     * generous budget — otherwise it truncates mid-forge and the player must
     * hit Continue. Override via `narrative.openingMaxLength`; default 1024.
     */
    narrativeOpeningMaxLength:
      Number((/** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {})).openingMaxLength) || 1024,
    /** Style & voice presets (v0.6.0 D4): normalized ids + the directive lines they emit. */
    narrativeStyle: style,
    narrativeStyleDirectives: buildStyleDirectives(style),
    /**
     * Prompt template (v0.6.0 D5): "auto" resolves to the boot-time detection
     * from /api/v1/model; anything else is a manual override.
     * Config: `narrative.template`.
     */
    narrativeTemplate: (() => {
      const t = String(
        /** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {}).template ?? "auto"
      ).trim().toLowerCase();
      return t === "auto" ? "auto" : normalizeTemplateName(t);
    })(),
    /**
     * Token streaming for narrator output (v0.7.0 D1). Default ON; transport
     * failures fall back to the non-streaming endpoint silently.
     * Config: `narrative.stream`.
     */
    narrativeStream:
      /** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {}).stream !== false,
    /**
     * Acceptance grace window (v0.6.0 D1): ms before a pending narrator
     * response auto-commits (extractor + memory fire then). 0 = commit
     * immediately (pre-v0.6.0 feel). Config: `narrative.acceptGraceMs`.
     */
    acceptGraceMs: Math.max(
      0,
      Number(
        /** @type {Record<string, unknown>} */ (fileCfg.narrative ?? {})
          .acceptGraceMs ?? 8000
      ) || 0
    ),
    /** Player agent config block — scaffolding only; nothing reads this yet (see core/agent/). */
    agent: /** @type {Record<string, unknown>} */ (fileCfg.agent ?? {})
  };
}

function defaultFfmpegBackend() {
  switch (process.platform) {
    case "darwin": return "avfoundation";
    case "linux": return "alsa";
    default: return "dshow";
  }
}

/**
 * List audio input devices. Platform-aware.
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 */
export function listDshowAudioDevices(cfg) {
  if (process.platform === "darwin") {
    const proc = spawnSync(
      cfg.ffmpegBin,
      ["-hide_banner", "-list_devices", "true", "-f", "avfoundation", "-i", ""],
      { encoding: "utf8" }
    );
    const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
    const lines = out.split(/\r?\n/);
    const devices = [];
    let inAudio = false;
    for (const line of lines) {
      if (/audio devices/i.test(line)) { inAudio = true; continue; }
      if (/video devices/i.test(line)) { inAudio = false; continue; }
      if (inAudio) {
        const m = line.match(/\[(\d+)]\s+(.+)/);
        if (m?.[2]) devices.push(m[2].trim());
      }
    }
    return devices.length > 0 ? devices : ["default"];
  }

  if (process.platform === "linux") {
    const proc = spawnSync(
      "arecord", ["-l"],
      { encoding: "utf8" }
    );
    const out = String(proc.stdout ?? "");
    const devices = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^card\s+(\d+).*:\s+(.+?)\s*\[/);
      if (m) devices.push(m[2].trim());
    }
    return devices.length > 0 ? devices : ["default"];
  }

  const proc = spawnSync(
    cfg.ffmpegBin,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8" }
  );

  const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  const lines = out.split(/\r?\n/);
  const devices = [];
  for (const line of lines) {
    const m = line.match(/"([^"]+)"\s+\(audio\)/i);
    if (m?.[1]) devices.push(m[1]);
  }
  return devices;
}

function ensureDirs() {
  fs.mkdirSync(getWritableCoreDir(), { recursive: true });
  fs.mkdirSync(getRecordingsDir(), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function loadSession() {
  try {
    const raw = fs.readFileSync(getSessionPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { messages: [] };
    if (!Array.isArray(parsed.messages)) parsed.messages = [];
    if (typeof parsed.createdAt !== "string") parsed.createdAt = nowIso();
    if (typeof parsed.schemaVersion !== "number") parsed.schemaVersion = 1;
    return parsed;
  } catch {
    return { schemaVersion: 1, createdAt: nowIso(), messages: [] };
  }
}

function saveSession(session) {
  fs.writeFileSync(
    getSessionPath(),
    JSON.stringify(session, null, 2) + os.EOL,
    "utf8"
  );
}

function addMessage(session, role, content) {
  session.messages.push({ ts: nowIso(), role, content });
  saveSession(session);
}

/**
 * Exported for the eval harness (scripts/run_evals.js) — evals must exercise
 * the exact prompt the live pipeline sends.
 *
 * `narrativeReply` (D2, v0.6.0): the accepted narrator response for this turn.
 * NPC names, locations, and outcomes mostly appear there, not in the player's
 * own words. Included only when `extractor.includeNarrative` is on.
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 */
export function buildExtractorPrompt(worldState, transcript, cfg, narrativeReply = "") {
  const snapshot = buildExtractorSnapshot(worldState);
  const lines = [];
  lines.push(cfg.extractorSystem);
  lines.push("");
  lines.push(JSON.stringify(snapshot, null, 2));
  lines.push("");
  lines.push(`User said (this turn): ${transcript}`);
  const reply = String(narrativeReply ?? "").trim();
  if (reply && cfg.extractor.includeNarrative !== false) {
    lines.push("");
    lines.push(`Narrator replied (this turn): ${reply}`);
  }
  lines.push("");
  lines.push("Return ONLY the JSON object.");
  return lines.join("\n");
}

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

function tryParseExtractor(raw) {
  const slice = extractJsonObject(raw) ?? String(raw).trim();
  try {
    const o = JSON.parse(slice);
    if (!o || typeof o !== "object" || Array.isArray(o)) return null;
    return o;
  } catch {
    return null;
  }
}

/**
 * Exported for the eval harness — same generate + JSON-repair retry as live turns.
 * `generate` is injectable so the pipeline can route through its stubbed
 * generate in model-free tests; evals and live turns use the default.
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 */
export async function runExtractorWithRetry(extractorPrompt, gen, cfg, generate = koboldGenerate) {
  let raw = await generate(extractorPrompt, gen, cfg);
  let diff = tryParseExtractor(raw);
  if (diff) return { ok: true, diff, raw };
  const repair = `${extractorPrompt}\n\nYour previous reply was not valid JSON. Reply with ONLY one JSON object matching the schema. No markdown, no code fences, no other text.`;
  raw = await generate(repair, gen, cfg);
  diff = tryParseExtractor(raw);
  if (diff) return { ok: true, diff, raw };
  return { ok: false, diff: null, raw };
}

/**
 * Generation through the configured inference adapter (v0.8.0). The
 * backend-specific HTTP (KoboldCPP endpoints, retries, SSE parsing) lives in
 * core/inference/. This module-level wrapper exists for callers that hold a
 * resolved cfg rather than a pipeline instance (eval harness, retry default).
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 */
async function koboldGenerate(prompt, gen, cfg) {
  return createInferenceAdapter(
    cfg.inference ?? buildInferenceRuntimeConfig(cfg)
  ).generate(prompt, gen ?? cfg.narrative);
}

/** @param {ReturnType<typeof resolvePipelineConfig>} cfg */
function runWhisper(wavPath, cfg) {
  return new Promise((resolve, reject) => {
    if (!cfg.whisperBin || !cfg.whisperModel) {
      reject(
        new Error(
          "Missing Whisper binary and/or model. Set `whisperBin` / `whisperModel` in core/config.json, WHISPER_BIN / WHISPER_MODEL env vars, or place bundled files under resources/bin (see resources/bin/README.md)."
        )
      );
      return;
    }

    const args = [
      "-m",
      cfg.whisperModel,
      "-f",
      wavPath,
      "-l",
      cfg.whisperLanguage,
      "-t",
      String(cfg.whisperThreads)
    ];

    const child = spawn(cfg.whisperBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Whisper exited ${code}: ${stderr || stdout}`.trim()));
        return;
      }

      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      const last = lines.at(-1) ?? "";
      const cleaned = last.replace(/^\[[^\]]+\]\s*/, "").trim();
      resolve(cleaned);
    });
  });
}

/** @param {ReturnType<typeof resolvePipelineConfig>} cfg */
function pickDefaultDshowAudioDevice(cfg) {
  const devices = listDshowAudioDevices(cfg);
  if (devices.length === 0) return "";
  return devices.find((d) => /microphone|mic/i.test(d)) ?? devices[0];
}

/**
 * Build platform-specific FFmpeg input args for audio capture.
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 * @returns {string[]}
 */
function buildAudioInputArgs(cfg) {
  const backend = cfg.ffmpegBackend.toLowerCase();

  if (backend === "avfoundation" || process.platform === "darwin") {
    const device = cfg.ffmpegDshowAudioDevice || ":default";
    const inputSpec = device.startsWith(":") ? device : `:${device}`;
    return ["-f", "avfoundation", "-i", inputSpec];
  }

  if (backend === "alsa" || backend === "pulse" || process.platform === "linux") {
    const fmt = backend === "pulse" ? "pulse" : "alsa";
    const device = cfg.ffmpegDshowAudioDevice || "default";
    return ["-f", fmt, "-i", device];
  }

  const device = cfg.ffmpegDshowAudioDevice || pickDefaultDshowAudioDevice(cfg);
  if (!device) {
    throw new Error(
      "No DirectShow audio device found. Set FFMPEG_DSHOW_AUDIO to your microphone name."
    );
  }
  // Small capture buffer (ms): with the dshow default, ffmpeg blocks in long
  // device reads and misses the interactive "q" quit, so recordings died on
  // SIGKILL with their output discarded (FFmpeg 8.x).
  return ["-f", "dshow", "-audio_buffer_size", "64", "-i", `audio=${device}`];
}

/** Wrap raw 16-bit mono PCM in a minimal RIFF/WAVE header. */
function wrapPcmAsWav(pcmPath, wavPath, sampleRateHz) {
  const pcm = fs.readFileSync(pcmPath);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28); // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([header, pcm]));
  try {
    fs.unlinkSync(pcmPath);
  } catch {
    // ignore
  }
  return pcm.length;
}

/**
 * Record to raw s16le PCM with per-packet flushing, then wrap as WAV on stop.
 * FFmpeg cannot be stopped gracefully here: on Windows it polls the console
 * (not piped stdin) for the interactive "q", so newer builds ignore it and a
 * hard kill discards their buffered WAV output (observed 0-byte files on
 * FFmpeg 8.x). Raw PCM + `-flush_packets 1` puts every packet on disk as it
 * arrives, so a hard kill loses at most the final packet, and the WAV header
 * is written by us with correct sizes.
 * @param {ReturnType<typeof resolvePipelineConfig>} cfg
 */
function recordToWav(wavPath, cfg) {
  const inputArgs = buildAudioInputArgs(cfg);
  const pcmPath = `${wavPath}.pcm`;

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...inputArgs,
    "-ac",
    "1",
    "-ar",
    String(cfg.sampleRateHz),
    "-f",
    "s16le",
    "-flush_packets",
    "1",
    "-avioflags",
    "direct",
    pcmPath
  ];

  const child = spawn(cfg.ffmpegBin, args, { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        const finalize = () => {
          try {
            if (fs.existsSync(pcmPath) && fs.statSync(pcmPath).size > 0) {
              wrapPcmAsWav(pcmPath, wavPath, cfg.sampleRateHz);
              resolve();
              return;
            }
          } catch (e) {
            reject(new Error(`failed to finalize recording: ${e?.message ?? e}`));
            return;
          }
          reject(
            new Error(
              `ffmpeg captured no audio${stderr ? `: ${stderr.trim()}` : " (no stderr)"}`
            )
          );
        };

        if (child.exitCode !== null) {
          finalize();
          return;
        }

        // Graceful quit first (responsive thanks to the small capture
        // buffer), hard kill as fallback — unbuffered writes mean the kill
        // only loses audio that never reached ffmpeg.
        try {
          child.stdin.write("q");
          child.stdin.end();
        } catch {
          // ignore
        }

        const timeout = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 1200);

        child.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        child.on("close", () => {
          clearTimeout(timeout);
          finalize();
        });
      })
  };
}

function makeWavPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(getRecordingsDir(), `ptt-${stamp}.wav`);
}

/**
 * @param {ReturnType<typeof resolvePipelineConfig>} resolvedConfig
 */
class LocalPipeline extends EventEmitter {
  /**
   * @param {ReturnType<typeof resolvePipelineConfig>} resolvedConfig
   */
  constructor(resolvedConfig) {
    super();
    this.cfg = resolvedConfig;
    this._started = false;
    /** @type {ReturnType<typeof setInterval> | null} */
    this._tick = null;
    /** @type {((chunk: Buffer | string) => void) | null} */
    this._stdinDataHandler = null;
    /** @type {Promise<void>} */
    this._gate = Promise.resolve();
    this.session = null;
    /** @type {Awaited<ReturnType<typeof loadWorldState>>} */
    this.worldState = null;
    /** @type {null | ReturnType<typeof recordToWav>} */
    this.recording = null;
    this.recordStartedAt = 0;
    this.lastStoppedAt = 0;
    this.wavPath = "";
    this.lastSpaceAt = 0;
    /**
     * Toggle-mode PTT latch (v0.9.0 D7, mac/linux): while true, a recording
     * stays open until an explicit second press instead of finalizing on the
     * release timeout. Hold mode never sets this.
     */
    this._pttLatched = false;
    /** Re-entrancy guard for the background memory tick. */
    this._memoryBusy = false;
    /** Cached memory_vectors.json content (lazy; refreshed by the memory tick). */
    this._memoryVectors = null;
    /** Debug report for the last assembled narrator context (IPC: context:lastReport). */
    this.lastContextReport = null;
    /**
     * Pending narrator response (v0.6.0 D1): emitted and shown, but not yet in
     * session.json; extractor + memory fire on acceptance.
     * @type {null | { id: number, text: string, transcript: string, mode: string, createdAt: number, timer: ReturnType<typeof setTimeout> | null }}
     */
    this._pending = null;
    this._pendingSeq = 0;
    /** Interaction-engine rules (design doc 02); defaults keep the engine running templateless. */
    this.rules = resolvedConfig.rules ?? DEFAULT_RULES;
    /** Monotonic per-turn seed source so each resolution is replayable/loggable. */
    this._turnSeq = (Date.now() ^ (Math.random() * 0x100000000)) >>> 0;
    /** Post-acceptance extractor/memory work for the most recent accept (awaitable in tests). */
    this._postAcceptPromise = Promise.resolve();
    /**
     * One-deep undo record for the most recent accepted turn's extraction
     * (tech-debt session item 3). Serialized world-state strings, captured
     * around `applyExtractorDiff`; a regenerate-after-grace restores
     * `serializedBefore` only when the current world state still matches
     * `serializedAfter` byte-for-byte.
     * @type {null | { serializedBefore: string, serializedAfter: string, assistantText: string }}
     */
    this._lastTurnRevert = null;
    /** Boot-time template detection result for `narrative.template: "auto"` (D5). */
    this._detectedTemplate = "plain";
    /** Once a turn has generated, late detection results no longer apply (never switch mid-session). */
    this._templateLocked = false;
    /** Guards the one-shot story-template opening turn (v0.9.0 D5) so it fires at most once per pipeline instance. */
    this._openingKicked = false;
    /** True while a narrator SSE stream is in flight (v0.7.0; gates stopGeneration). */
    this._streamActive = false;
    /**
     * The in-flight background extraction generation, when there is one
     * (tech-debt session item 5): lets stopGeneration defer a global-scope
     * abort instead of killing the extraction that holds the backend's slot.
     * @type {Promise<unknown> | null}
     */
    this._extractionPromise = null;
    /** Set by stopGeneration; suppresses the empty-stream retry for a generation the player just stopped. */
    this._stopRequested = false;
    /** Active inference backend adapter (v0.8.0); rebuilt on config change. */
    this.inference = createInferenceAdapter(resolvedConfig.inference);
    /**
     * Cached real-token counter for context assembly (null when the backend
     * has no tokenization endpoint). Counts are tokenizer-specific, so this
     * is rebuilt whenever the adapter is.
     * @type {null | ((text: string) => Promise<number | null>)}
     */
    this._countTokensCached = this._buildTokenCounter();
    this.sttAdapter = createSttAdapter({
      backend: resolvedConfig.sttBackend,
      whisperBin: resolvedConfig.whisperBin,
      whisperModel: resolvedConfig.whisperModel,
      whisperLanguage: resolvedConfig.whisperLanguage,
      whisperThreads: resolvedConfig.whisperThreads,
      customBin: resolvedConfig.sttCustomBin,
      customArgs: resolvedConfig.sttCustomArgs
    });
  }

  /** Cached `tryCountTokens` bound to the current adapter (null = no real tokenization). */
  _buildTokenCounter() {
    const adapter = this.inference;
    return typeof adapter?.tryCountTokens === "function"
      ? createCachedTokenCounter((text) => adapter.tryCountTokens(text))
      : null;
  }

  /**
   * Push-to-talk when resolved `stdinPtt` is false.
   * Same timing as SPACE in raw stdin mode: down refreshes hold window; up forces release on next tick.
   * @param {boolean} down
   */
  setPttState(down) {
    if (down) {
      console.log("[pipeline] setPttState(true)", {
        started: this._started,
        recording: Boolean(this.recording)
      });
    }
    if (!this._started) {
      if (down) {
        console.warn(
          "[pipeline] setPttState(true) no-op: pipeline.start() has not run yet (_started=false)"
        );
      }
      return;
    }
    if (down) this._pttPulse();
    else this._pttRelease();
  }

  /**
   * Toggle-mode PTT (v0.9.0 D7): latch a recording on or off. Used where no
   * key-release event exists (mac/linux global shortcut, and the focused
   * keyboard path under `pushToTalk.mode: "toggle"`). The first press latches
   * on and starts recording; the second unlatches and lets it finalize.
   * @param {boolean} latched
   */
  setPttLatched(latched) {
    if (!this._started) return;
    if (latched) {
      this._pttLatched = true;
      this._pttPulse();
    } else {
      this._pttLatched = false;
      this._pttRelease();
    }
  }

  /** True while a toggle-mode recording is latched open. */
  isPttLatched() {
    return this._pttLatched === true;
  }

  /**
   * Process typed user input like a Whisper transcript (no recording).
   * @param {string} text
   */
  submitText(text) {
    if (!this._started) return;
    const t = String(text ?? "").trim();
    if (!t) return;
    this._gate = this._gate
      .then(async () => {
        await this._runTurnFromTranscript(t);
      })
      .catch((error) => {
        this.emit("error", { error, phase: "pipeline" });
      });
  }

  _pttPulse() {
    const cfg = this.cfg;
    this.lastSpaceAt = Date.now();
    if (!this.recording) {
      if (Date.now() - this.lastStoppedAt < cfg.restartDebounceMs) return;
      this.wavPath = makeWavPath();
      this.emit("recording:start", { wavPath: this.wavPath });
      try {
        this.recording = recordToWav(this.wavPath, cfg);
        this.recordStartedAt = Date.now();
      } catch (error) {
        this.emit("error", { error, phase: "recording" });
        this.recording = null;
        this.wavPath = "";
      }
    }
  }

  _pttRelease() {
    this.lastSpaceAt = 0;
  }

  /** Instance-level generate wrapper — overridable in model-free tests. */
  _generate(prompt, gen, cfg) {
    return this.inference.generate(prompt, gen ?? (cfg ?? this.cfg).narrative);
  }

  /** Instance-level streaming wrapper — overridable in model-free tests. */
  _generateStream(prompt, gen, cfg, onText, onDone) {
    return this.inference.generateStream(prompt, gen ?? (cfg ?? this.cfg).narrative, onText, onDone);
  }

  /**
   * Build the per-message "fin" metadata (design doc 03): did this reply end
   * naturally or hit the token ceiling? `finishReason` from the adapter is the
   * primary signal; a token-budget heuristic (chars/4 vs max_length) is the
   * backend-agnostic fallback for non-stream/custom. A user Stop wins as
   * `"aborted"`. Computed against the freshly generated text + that call's
   * budget, so a continue chunk is judged on the continue budget.
   * @param {string} text - the text generated by THIS call (not the combined display text)
   * @param {string|null} finishReason - normalized reason from the adapter, or null
   */
  _buildGenMeta(text, finishReason, gen, cfg) {
    const g = gen ?? (cfg ?? this.cfg).narrative ?? {};
    const maxTokens = Number(g.max_length) || null;
    const tokenCount = estimateTokensFallback(text);
    const reason = this._stopRequested ? "aborted" : (finishReason || "unknown");
    const truncated =
      reason === "length" ||
      (reason === "unknown" && maxTokens != null && tokenCount >= maxTokens * 0.98);
    return {
      finishReason: reason,
      maxTokens,
      tokenCount,
      truncated,
      lengthPreset: (cfg ?? this.cfg)?.narrativeLengthPreset ?? null
    };
  }

  /**
   * Narrator generation with token streaming (v0.7.0 D1). Emits
   * `narrative:token { text }` with the accumulated text as chunks land;
   * transport failures fall back to the non-streaming endpoint silently.
   * `mapText` lets continue-mode prefix the existing response so the
   * renderer always sees the full display text.
   * @param {(generated: string) => string} [mapText]
   */
  async _generateNarrative(prompt, gen, cfg, mapText = (t) => t) {
    // Latency numbers for the context report / budget doc (v0.7.0 D7).
    const startedAt = Date.now();
    this._stopRequested = false;
    this._lastGenTiming = { ttftMs: null, generateMs: null, streamed: false };
    // Message-fin signal (doc 03): the adapter reports the reason via onDone;
    // unknown until then, so the non-stream/custom paths fall back to the
    // token-budget heuristic in _buildGenMeta.
    let finishReason = null;
    const onDone = (d) => {
      if (d?.finishReason) finishReason = d.finishReason;
    };
    const finish = (result) => {
      this._lastGenTiming.generateMs = Date.now() - startedAt;
      this._lastGenMeta = this._buildGenMeta(result, finishReason, gen, cfg);
      return result;
    };
    if (!cfg.narrativeStream) {
      return finish(await this._generate(prompt, gen, cfg));
    }
    this._streamActive = true;
    try {
      this._lastGenTiming.streamed = true;
      const text = await this._generateStream(prompt, gen, cfg, (accum) => {
        if (this._lastGenTiming.ttftMs == null) {
          this._lastGenTiming.ttftMs = Date.now() - startedAt;
        }
        this.emit("narrative:token", { text: mapText(accum) });
      }, onDone);
      if (text) return finish(text);
      if (this._stopRequested) {
        // Stop landed before the first token — do not relaunch the
        // generation the player just cancelled; the empty result parks per
        // the normal stop flow.
        return finish(text);
      }
      // Empty stream (immediate EOS sample — observed live ~1 in 6 on
      // identical re-prompts): one non-streaming retry beats parking an
      // empty pending response.
      console.warn("[pipeline] stream returned empty text, retrying non-streaming");
      this._lastGenTiming.streamed = false;
      return finish(await this._generate(prompt, gen, cfg));
    } catch (error) {
      console.warn(
        `[pipeline] stream failed, falling back to non-streaming: ${error?.message ?? error}`
      );
      this._lastGenTiming.streamed = false;
      return finish(await this._generate(prompt, gen, cfg));
    } finally {
      this._streamActive = false;
    }
  }

  /**
   * Player-facing "Stop" while narration is streaming (v0.7.0 D2): aborts
   * the server-side generation; the stream then ends normally and the
   * partial text parks as pending, where the per-response controls apply.
   *
   * Decision of record (tech-debt session item 5): on backends whose abort is
   * global (KoboldCPP's /api/extra/abort hits whatever holds the single
   * slot), a stop issued while a background extraction is in flight is
   * deferred until that extraction lands — the narration request is queued
   * behind the slot and has produced nothing yet, so the stop takes effect
   * the moment the slot frees, and the extraction completes instead of
   * burning its JSON-repair retry. Stream-scoped backends (OpenAI/Ollama)
   * cannot hit a background generation and abort immediately, as before.
   */
  stopGeneration() {
    if (!this._streamActive) return { ok: false };
    this._stopRequested = true;
    const fireAbort = () => {
      if (!this._streamActive) return;
      this.inference.abort().catch((error) => {
        console.warn(`[pipeline] abort failed: ${error?.message ?? error}`);
      });
    };
    if (this._extractionPromise && this.inference.abortScope === "global") {
      this._extractionPromise.then(fireAbort, fireAbort);
      return { ok: true, deferred: true };
    }
    fireAbort();
    return { ok: true };
  }

  /** Resolved template for this turn: manual override wins; "auto" uses boot detection. */
  _activeTemplateName() {
    const t = this.cfg.narrativeTemplate;
    return t && t !== "auto" ? t : this._detectedTemplate;
  }

  /**
   * Story-template onboarding directive (v0.9.0 D5), applied while the world
   * has no committed narrator reply yet. No pending flag to clear: once the
   * first reply is accepted into the session, the condition is false forever
   * (and a regenerate of that first reply correctly re-applies it).
   */
  _firstTurnDirective() {
    const hasReply = (this.session?.messages ?? []).some((m) => m.role === "assistant");
    if (hasReply) return "";
    // App-forge worlds (design doc 01 §10): the opening confirms the finished
    // sheet rather than running a prose forge. Defer (return "") until the app
    // has written a structured character — characterCreate then re-kicks the
    // opening via kickoffOpening(). The template's openingHint rides in
    // narrativeFirstTurnDirective here.
    if (this.cfg.narrativeOnboardingMode === "app-forge") {
      const character = this.worldState?.character;
      if (!character || character.createdBy !== "app-forge") return "";
      return buildConfirmOpeningDirective(character, this.cfg.narrativeFirstTurnDirective);
    }
    return this.cfg.narrativeFirstTurnDirective || "";
  }

  /**
   * Public re-trigger for the unprompted opening (design doc 01 §10). In
   * app-forge mode the opening is deferred at start() — the directive is empty
   * until the player finishes the forge — so the character:create handler calls
   * this once the sheet is written. A no-op if the opening already fired or a
   * reply exists. Safe to call when not booted.
   */
  kickoffOpening() {
    if (!this._started) return;
    this._kickoffOpening();
  }

  /**
   * Story-template opening (v0.9.0 D5): on a templated world's first session
   * the narrator speaks first. This runs the onboarding directive
   * (`firstMessageHint`, e.g. the welcome + Character Forge) as an unprompted
   * turn, so the opening message gives the player everything they need to make
   * a character before they've said a word. Fires at most once per pipeline
   * instance and only while the world has no committed narrator reply — so a
   * later launch (the accepted opening is now in the session) skips it, and a
   * blank world (no directive) never triggers it. Unprompted generation needs
   * the backend up, which may still be loading at start(), so it waits for the
   * model to answer before generating, then runs through the turn gate so it
   * can't race a player turn.
   */
  async _kickoffOpening() {
    if (this._openingKicked) return;
    if (!this._firstTurnDirective()) return; // no directive, or a reply already exists
    this._openingKicked = true;

    let ready = false;
    for (let attempt = 0; attempt < 20 && this._started; attempt++) {
      try {
        await this.inference.modelInfo();
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!ready || !this._started) return;

    this._gate = this._gate
      .then(() => this._runOpeningTurn())
      .catch((error) => this.emit("error", { error, phase: "pipeline" }));
  }

  /**
   * Generate and park the unprompted opening narration. Mirrors the narrative
   * half of {@link _runTurnFromTranscript} but with no player message: an empty
   * transcript and the onboarding directive injected. Parked as a normal "new"
   * pending so accept / regenerate / restore all behave identically (a
   * regenerate re-applies the directive via {@link _firstTurnDirective} since
   * no assistant reply is committed yet).
   */
  async _runOpeningTurn() {
    // Re-check under the gate: a player turn may have raced in first, or the
    // reply may already exist (e.g. a restored pending).
    if (this._pending) return;
    const directive = this._firstTurnDirective();
    if (!directive) return;

    const cfg = this.cfg;
    const turnStartedAt = Date.now();
    this._templateLocked = true;

    let narrativePrompt;
    // The opening delivers the welcome + the entire Character Forge in one
    // message, so it needs far more room than a normal turn's length preset
    // (which would truncate it mid-forge and force a Continue). Use the
    // dedicated opening budget and let it terminate naturally on the stop
    // sequence / EOS rather than inheriting an antiEos cap.
    const openingGen = { ...cfg.narrative, max_length: cfg.narrativeOpeningMaxLength };
    delete openingGen.antiEos;
    let narrativeGen = openingGen;
    try {
      const { prompt, report, stopSequences } = await assembleNarrativeContext({
        session: this.session,
        worldState: this.worldState,
        cfg,
        vectorStore: this._getMemoryVectors(),
        countTokens: this._countTokensCached,
        template: this._activeTemplateName(),
        gmBestiary: this.gmBestiary ?? null,
        extraDirective: directive
      });
      narrativePrompt = prompt;
      this.lastContextReport = report;
      report.timing = { assembleMs: Date.now() - turnStartedAt };
      if (stopSequences) narrativeGen = { ...openingGen, stop_sequence: stopSequences };
    } catch (error) {
      this.emit("error", { error, phase: "narrative_prompt" });
      return;
    }

    // Empty-but-beforeKobold transcript drives the renderer's "thinking"
    // indicator during the unprompted generation (onTranscript ignores it).
    this.emit("transcript", { text: "", beforeKobold: true });

    let reply;
    try {
      reply = await this._generateNarrative(narrativePrompt, narrativeGen, cfg);
    } catch (error) {
      this.emit("error", { error, phase: "kobold" });
      return;
    }

    if (this.lastContextReport) {
      Object.assign(this.lastContextReport.timing ?? (this.lastContextReport.timing = {}), this._lastGenTiming, {
        turnMs: Date.now() - turnStartedAt
      });
    }

    this.emit("narrative", { text: reply, meta: this._lastGenMeta ?? null });
    this._enterPending(reply, "", "new");
  }

  /**
   * One-shot template detection from KoboldCPP /api/v1/model (D5). The
   * backend may still be loading when the pipeline starts, so retry briefly;
   * a result that arrives after the first turn is ignored (no mid-session
   * template switches).
   */
  async _detectTemplate() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { name } = await this.inference.modelInfo();
        const detected = detectTemplateFromModelName(name);
        if (this._templateLocked) {
          if (detected !== this._detectedTemplate) {
            console.log(
              `[pipeline] template detection (${detected}) arrived after first turn; keeping ${this._detectedTemplate}`
            );
          }
        } else {
          this._detectedTemplate = detected;
          if (detected !== "plain") {
            console.log(`[pipeline] template auto-detected: ${detected} (model: ${name})`);
          }
        }
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    // Backend never answered — stay on "plain".
  }

  /**
   * @param {string} transcript
   */
  async _runTurnFromTranscript(transcript) {
    const cfg = this.cfg;
    const text = String(transcript ?? "").trim();
    if (!text) {
      this.emit("transcript", { text: "" });
      return;
    }
    if (text === "[BLANK_AUDIO]") {
      this.emit("transcript", { text });
      return;
    }

    // Sending the next message accepts the previous pending response (D1).
    // The commit is synchronous; its extractor runs in the background, in
    // parallel with this turn's narrative generation — same parallelism the
    // pre-v0.6.0 Promise.all had.
    this.acceptPending("next-send");

    this.emit("transcript", { text });
    addMessage(this.session, "user", text);

    const templateName = this._activeTemplateName();
    this._templateLocked = true;
    const turnStartedAt = Date.now();

    // INTENT → RESOLUTION (design doc 02): classify the player's message and let
    // the deterministic engine resolve any mechanics BEFORE narration. The
    // result (rolls/deltas/sections) is parked with the pending reply and only
    // commits on accept. Freeform turns resolve to null — narration only, as today.
    const mechanics = await this._resolveMechanics(text);

    let narrativePrompt;
    let narrativeGen = cfg.narrative;
    try {
      const { prompt, report, stopSequences } = await assembleNarrativeContext({
        session: this.session,
        worldState: this.worldState,
        cfg,
        vectorStore: this._getMemoryVectors(),
        countTokens: this._countTokensCached,
        template: templateName,
        gmBestiary: this.gmBestiary ?? null,
        extraDirective: this._firstTurnDirective(),
        // The resolved-mechanics block rides on the latest user turn (most
        // salient slot) rather than the distant system block — see context.js.
        lateDirective: renderMechanicsDirective(mechanics)
      });
      narrativePrompt = prompt;
      this.lastContextReport = report;
      report.timing = { assembleMs: Date.now() - turnStartedAt };
      // Template stops replace the hardcoded "\nUser:" pair (plain returns null).
      if (stopSequences) narrativeGen = { ...cfg.narrative, stop_sequence: stopSequences };
    } catch (error) {
      this.emit("error", { error, phase: "narrative_prompt" });
      return;
    }

    this.emit("transcript", { text, beforeKobold: true });

    let reply;
    try {
      reply = await this._generateNarrative(narrativePrompt, narrativeGen, cfg);
    } catch (error) {
      this.emit("error", { error, phase: "kobold" });
      return;
    }

    // Per-turn latency (v0.7.0 D7) — visible in the context debug panel.
    Object.assign(this.lastContextReport.timing, this._lastGenTiming, {
      turnMs: Date.now() - turnStartedAt
    });

    reply = this._sanitizeReply(reply);
    this.emit("narrative", { text: reply, meta: this._lastGenMeta ?? null });
    this._enterPending(reply, text, "new", mechanics);
  }

  /**
   * Strip stray mechanical output the model printed despite the directive
   * (design doc 02 §8) — but only on app-forged worlds, where the engine + app
   * own the numbers. Blank/legacy worlds keep the model's prose verbatim.
   * @param {string} reply
   */
  _sanitizeReply(reply) {
    if (this.worldState?.character?.createdBy !== "app-forge") return reply;
    const cleaned = sanitizeNarration(reply);
    // Never blank a reply entirely — if stripping ate everything, keep original.
    return cleaned.trim() ? cleaned : reply;
  }

  /**
   * Classify intent + run the deterministic engine for one player message
   * (design doc 02 §3). Returns a ResolutionResult (parked with the pending
   * reply, committed on accept) or null for a freeform/narration-only turn.
   * Never throws — any engine error degrades to a plain narration turn.
   * @param {string} text
   */
  async _resolveMechanics(text) {
    // The interaction engine only engages for app-forged worlds (design doc 02
    // consumes doc 01's structured sheet). Blank/legacy worlds behave exactly as
    // before — no classification, no mechanics.
    if (this.worldState?.character?.createdBy !== "app-forge") return null;
    try {
      const proposal = await classifyIntent(text, this._intentCtx(text));
      const rng = makeRng((this._turnSeq = (this._turnSeq + 0x9e3779b1) >>> 0));
      const result = resolveMechanics(
        proposal,
        this.worldState.character,
        this.worldState.encounter,
        this.rules,
        rng,
        this.gmBestiary ?? null
      );
      if (result) this.emit("mechanics:resolved", result.public);
      return result;
    } catch (error) {
      this.emit("error", { error, phase: "engine" });
      return null;
    }
  }

  /**
   * Context passed to intent classification. The referee LLM pass (design doc
   * 02 §3.1) is offered only for action-ish freeform (a cheap pre-filter keeps
   * pure-narration turns model-call-free), and routes through the narration
   * inference adapter.
   * @param {string} text
   */
  _intentCtx(text) {
    const character = this.worldState?.character ?? {};
    const inEncounter = this.worldState?.encounter?.active === true;
    if (!looksLikeAction(text, inEncounter)) return {};
    const refereeCtx = {
      stats: character.stats,
      skills: character.skills,
      inEncounter
    };
    return {
      referee: (t) => runReferee(t, refereeCtx, (p, g) => this.inference.generate(p, g))
    };
  }

  /**
   * Park a narrator response as pending (D1). Nothing is committed: the
   * assistant message is not in session.json and extractor/memory have not
   * run. Acceptance (auto timer, explicit, next-send, or stop) commits it.
   * @param {string} text - narrator response
   * @param {string} transcript - the player message that produced it
   * @param {string} mode - "new" | "regenerate" | "continue" | "rewrite" | "restored"
   * @param {object|null} [mechanics] - parked ResolutionResult (doc 02); deltas apply on accept
   */
  _enterPending(text, transcript, mode, mechanics = null, meta) {
    const graceMs = this.cfg.acceptGraceMs;
    // Carry the message-fin meta (doc 03) of the generation that produced this
    // reply through the pending lifecycle, so it survives accept unchanged.
    // Callers that did NOT just generate `text` (the "restored" error paths)
    // pass meta=null explicitly so a stale prior-turn meta isn't mislabeled
    // onto the recovered message; the normal paths default to _lastGenMeta.
    const resolvedMeta = meta === undefined ? (this._lastGenMeta ?? null) : meta;
    const pending = {
      id: ++this._pendingSeq,
      text,
      transcript,
      mode,
      mechanics: mechanics ?? null,
      meta: resolvedMeta,
      createdAt: Date.now(),
      timer: null
    };
    this._pending = pending;
    this.emit("narrative:pending", {
      id: pending.id,
      text,
      mode,
      graceMs,
      sections: mechanics?.sections ?? null,
      meta: resolvedMeta
    });
    if (graceMs === 0) {
      this.acceptPending("auto");
      return;
    }
    pending.timer = setTimeout(() => {
      // No-op if this pending was already accepted or discarded.
      if (this._pending === pending) this.acceptPending("auto");
    }, graceMs);
    pending.timer.unref?.();
  }

  /**
   * Commit the pending response: append to session.json, then fire extractor
   * + memory tick on the accepted text in the background (awaitable via
   * `_postAcceptPromise`).
   * @param {string} reason - "explicit" | "auto" | "next-send" | "stop"
   */
  acceptPending(reason = "explicit") {
    const p = this._pending;
    if (!p) return { ok: false };
    if (p.timer) clearTimeout(p.timer);
    this._pending = null;
    addMessage(this.session, "assistant", p.text);
    // COMMIT (design doc 02 §3.2): apply the engine's parked deltas exactly once,
    // before the extractor runs. The engine is the sole writer of mechanical
    // fields, so this never races the extractor (which skips them for app-forge
    // sheets). An unaccepted turn never reaches here, so it mutates nothing.
    if (p.mechanics?.deltas) {
      applyDeltas(this.worldState, p.mechanics.deltas);
      saveWorldState(this.worldState);
      this.emit("world:updated", { worldState: this.worldState });
    }
    this.emit("narrative:accepted", {
      id: p.id,
      text: p.text,
      reason,
      sections: p.mechanics?.sections ?? null
    });
    this._postAcceptPromise = this._postAcceptWork(p).catch((error) => {
      this.emit("error", { error, phase: "extractor" });
    });
    return { ok: true, id: p.id };
  }

  /** Extractor + memory work for an accepted response (was inline in the turn path pre-v0.6.0). */
  async _postAcceptWork(p) {
    const cfg = this.cfg;
    // A new acceptance supersedes any older undo record — only the most
    // recent turn's extraction is ever revertible.
    this._lastTurnRevert = null;
    const extractorPrompt = buildExtractorPrompt(
      this.worldState,
      p.transcript,
      cfg,
      p.text
    );
    // Tracked so stopGeneration can see an extraction in flight; the promise
    // spans the initial attempt and the JSON-repair retry.
    this._extractionPromise = runExtractorWithRetry(
      extractorPrompt,
      cfg.extractor,
      cfg,
      (prompt, gen, c) => this._generate(prompt, gen, c)
    );
    let ex;
    try {
      ex = await this._extractionPromise;
    } finally {
      this._extractionPromise = null;
    }

    if (ex.ok && ex.diff) {
      const liveDiff = {};
      // `character_updates` is the pre-v2 schema key — kept as a fallback for
      // user-customized extractor prompts that still emit it.
      const pc = ex.diff.player_character ?? ex.diff.character_updates;
      if (pc) liveDiff.player_character = pc;
      if (ex.diff.npcs) liveDiff.npcs = ex.diff.npcs;
      if (ex.diff.quests) liveDiff.quests = ex.diff.quests;
      if (ex.diff.locations) liveDiff.locations = ex.diff.locations;
      if (ex.diff.lorebook) liveDiff.lorebook = ex.diff.lorebook;
      if (ex.diff.session_beat) liveDiff.session_beat = ex.diff.session_beat;

      // Scene-boundary detection compares against the pre-diff location set.
      const prevLocationNames = new Set(
        (this.worldState.locations ?? [])
          .map((l) => String(l?.name ?? "").trim().toLowerCase())
          .filter(Boolean)
      );

      // World state is JSON-round-trip-safe by construction (loaded/saved as
      // JSON); strings avoid aliasing the live object.
      const serializedBefore = JSON.stringify(this.worldState);

      // Direct writes (v0.8.4): the co-author's diff lands immediately with
      // prov:"ai"; brand-new entries are flagged isNew for Keep/Rewrite and
      // reported via `created` so the renderer can drop marker chips inline.
      const { created } = applyExtractorDiff(this.worldState, liveDiff, {
        prov: "ai",
        autoKeepPrevious: true
      });

      saveWorldState(this.worldState);
      this.emit("world:updated", { worldState: this.worldState });
      this.emit("extractor:ok", { diff: ex.diff, created });

      // Captured after the diff applies and before the memory tick: a revert
      // also drops this turn's lore entries, while tick output that persists
      // later invalidates the record (byte-equality check).
      this._lastTurnRevert = {
        serializedBefore,
        serializedAfter: JSON.stringify(this.worldState),
        assistantText: p.text
      };

      // Memory roll-up runs off the turn path — narration is already out.
      this._memoryTick(prevLocationNames, liveDiff);
    } else {
      this.emit("extractor:skip", { raw: ex.raw });
    }

    try {
      appendEvent({
        ts: nowIso(),
        transcript: p.transcript,
        narrative: p.text,
        extractorOk: ex.ok,
        extractorRaw: ex.raw,
        extractorError: ex.ok ? null : "parse_failed"
      });
    } catch {
      // ignore
    }
  }

  /** Pending state for renderer bootstrap (IPC: narrative:getPending). */
  getPendingState() {
    if (!this._pending) return { pending: null };
    const { id, text, mode, createdAt } = this._pending;
    return { pending: { id, text, mode, createdAt, graceMs: this.cfg.acceptGraceMs } };
  }

  /** Regenerate the latest narrator response with fresh sampling (D3). */
  regenerateLast() {
    this._queueControl("regenerate", "");
  }

  /** Extend the latest narrator response (append-mode generation, D3). */
  continueLast() {
    this._queueControl("continue", "");
  }

  /** Regenerate with a one-shot instruction injected as a temporary directive (D3). */
  rewriteLast(instruction) {
    this._queueControl("rewrite", String(instruction ?? "").trim());
  }

  /**
   * Undo the last accepted turn's extraction on regenerate-after-grace
   * (decision of record, tech-debt session item 3): restore the pre-diff
   * world state only when the current state still serializes byte-identically
   * to what that extraction left behind — any intervening write (lore review,
   * corrections, memory edits, a memory tick that persisted) fails the
   * comparison and routes to the flag path instead of guessing at a merge.
   * The flag path emits `world:staleExtraction` so the player can correct
   * via the Memory tab.
   * @param {string} assistantText - the un-committed assistant message
   */
  _revertLastExtraction(assistantText) {
    const rec = this._lastTurnRevert;
    if (!rec) return;
    this._lastTurnRevert = null;
    const reason =
      rec.assistantText !== assistantText
        ? "message-mismatch"
        : this._memoryBusy
          ? "memory-busy"
          : JSON.stringify(this.worldState) !== rec.serializedAfter
            ? "world-changed"
            : null;
    if (reason) {
      console.warn(
        `[pipeline] regenerate left the prior turn's extraction in world state (${reason}); correct via the Memory tab if needed`
      );
      this.emit("world:staleExtraction", { assistantText, reason });
      return;
    }
    this.worldState = JSON.parse(rec.serializedBefore);
    saveWorldState(this.worldState);
    this.emit("world:updated", { worldState: this.worldState });
  }

  _queueControl(mode, instruction) {
    if (!this._started) return;
    this._gate = this._gate
      .then(async () => {
        await this._redoTurn(mode, instruction);
      })
      .catch((error) => {
        this.emit("error", { error, phase: "pipeline" });
      });
  }

  /**
   * Shared body of regenerate / continue / rewrite. Operates on the pending
   * response when one exists (clean: nothing was committed). When the latest
   * response was already accepted, the assistant message is un-committed from
   * session.json and the result becomes a fresh pending — its earlier
   * extraction is reverted when provably safe, otherwise flagged as stale
   * (`_revertLastExtraction`, tech-debt session item 3; closes the v0.6.0
   * "clean only inside the grace window" caveat).
   */
  async _redoTurn(mode, instruction) {
    const cfg = this.cfg;

    let baseText;
    let transcript;
    // Reuse the pending turn's resolved mechanics — a regenerate re-narrates the
    // SAME outcome, it never re-rolls (design doc 02 §3.2). After accept the
    // pending is gone and its deltas are already committed, so mechanics is null
    // (no re-apply, no directive).
    let mechanics = null;
    const p = this._pending;
    if (p) {
      if (p.timer) clearTimeout(p.timer);
      this._pending = null;
      baseText = p.text;
      transcript = p.transcript;
      mechanics = p.mechanics ?? null;
    } else {
      const msgs = this.session.messages;
      const last = msgs[msgs.length - 1];
      if (!last || last.role !== "assistant") return;
      // The accepted turn's extractor may still be in flight — let it land
      // before un-committing, or its diff would apply to a message that no
      // longer exists (pre-existing race; the promise never rejects).
      await this._postAcceptPromise;
      msgs.pop();
      saveSession(this.session);
      this._revertLastExtraction(last.content);
      baseText = last.content;
      const lastUser = [...msgs].reverse().find((m) => m.role === "user");
      transcript = lastUser?.content ?? "";
    }

    const templateName = this._activeTemplateName();
    this._templateLocked = true;

    let prompt;
    let narrativeGen = cfg.narrative;
    try {
      const { prompt: assembled, report, stopSequences } = await assembleNarrativeContext({
        session: this.session,
        worldState: this.worldState,
        cfg,
        vectorStore: this._getMemoryVectors(),
        countTokens: this._countTokensCached,
        template: templateName,
        gmBestiary: this.gmBestiary ?? null,
        // Regenerating the very first reply re-applies the onboarding
        // directive (the assistant message was popped above). The RESOLVED
        // MECHANICS block is re-stated only when the turn is re-narrated from
        // scratch (regenerate/rewrite) — NOT on continue, which merely extends
        // the existing prose: re-asserting "the outcome is final, narrate it"
        // over an already-complete narration makes the model stop (design §3.2,
        // "continue extends the prose only").
        extraDirective: [
          this._firstTurnDirective(),
          mode === "rewrite" && instruction
            ? `Style note for this response only: ${instruction}`
            : ""
        ]
          .filter(Boolean)
          .join("\n"),
        // Re-narration (regenerate/rewrite) re-states the resolved mechanics on
        // the latest user turn; continue extends prose and must not (design §3.2).
        lateDirective: mode === "continue" ? "" : renderMechanicsDirective(mechanics)
      });
      this.lastContextReport = report;
      if (stopSequences) narrativeGen = { ...cfg.narrative, stop_sequence: stopSequences };
      // Continue-mode: seed the completion with the existing response so the
      // model extends it instead of answering fresh. Every template's prompt
      // ends with its assistant header awaiting generation.
      prompt =
        mode === "continue"
          ? assembled.endsWith("\n")
            ? `${assembled}${baseText}`
            : `${assembled} ${baseText}`
          : assembled;
    } catch (error) {
      // No new text was generated here — don't carry the prior turn's fin meta.
      this._enterPending(baseText, transcript, "restored", mechanics, null);
      this.emit("error", { error, phase: "narrative_prompt" });
      return;
    }

    this.emit("transcript", { text: transcript, beforeKobold: true });

    let reply;
    try {
      // Continue-mode streams display text with the existing response prefixed.
      const mapText =
        mode === "continue" ? (t) => `${baseText} ${t}` : (t) => t;
      reply = await this._generateNarrative(prompt, narrativeGen, cfg, mapText);
    } catch (error) {
      // Generation failed — restore the previous response as pending so the
      // on-screen text can still be accepted.
      // No new text was generated here — don't carry the prior turn's fin meta.
      this._enterPending(baseText, transcript, "restored", mechanics, null);
      this.emit("error", { error, phase: "kobold" });
      return;
    }

    const newText = this._sanitizeReply(mode === "continue" ? `${baseText} ${reply}` : reply);
    this.emit("narrative:updated", { text: newText, mode, meta: this._lastGenMeta ?? null });
    this._enterPending(newText, transcript, mode, mechanics);
  }

  start() {
    if (this._started) return;
    this._started = true;

    ensureDirs();
    this.session = loadSession();
    this.worldState = loadWorldState();
    // Story-template GM reference (v0.9.0 D5) — null for blank worlds.
    // World switches re-boot the pipeline, so this follows the active world.
    this.gmBestiary = loadGmBestiary(getActiveWorldDir());

    // Fire-and-forget template detection (D5) — only for "auto", and the
    // result applies only if it lands before the first turn.
    if (this.cfg.narrativeTemplate === "auto") {
      this._detectTemplate().catch(() => {});
    }

    const cfg = this.cfg;

    const onTick = () => {
      if (!this.recording) return;
      // Toggle mode keeps the recording open until the second press
      // (setPttLatched(false)); the release-timeout finalize is hold-only.
      if (this._pttLatched) return;
      if (Date.now() - this.lastSpaceAt <= cfg.spaceReleaseMs) return;

      const current = this.recording;
      this.recording = null;
      const startedAt = this.recordStartedAt;
      this.recordStartedAt = 0;
      const finalizedWav = this.wavPath;
      this.wavPath = "";
      this.lastStoppedAt = Date.now();

      this._gate = this._gate.then(async () => {
        let stopError = null;
        try {
          await current.stop();
        } catch (e) {
          stopError = e;
        }

        // Always emit recording:stop, even on failure — the UI's recording
        // state is driven by this event and must never be left dangling.
        const durMs = Math.max(0, Date.now() - startedAt);
        this.emit("recording:stop", { wavPath: finalizedWav, durationMs: durMs });

        if (stopError || !fs.existsSync(finalizedWav)) {
          this.emit("error", {
            error: stopError ?? new Error("recording failed (no wav file created)"),
            phase: "recording"
          });
          return;
        }

        if (durMs < cfg.minRecordMs) {
          try {
            fs.unlinkSync(finalizedWav);
          } catch {
            // ignore
          }
          // Empty transcript so the renderer can leave its transcribing state.
          this.emit("transcript", { text: "" });
          return;
        }

        let transcript;
        try {
          transcript = await this.sttAdapter.transcribe(finalizedWav);
        } catch (error) {
          this.emit("error", { error, phase: "whisper" });
          return;
        }

        if (!transcript || transcript === "[BLANK_AUDIO]") {
          this.emit("transcript", { text: transcript || "" });
          return;
        }

        // Read this.cfg (not the captured cfg) so the setting hot-applies.
        if (this.cfg.voiceAutoSend) {
          await this._runTurnFromTranscript(transcript);
        } else {
          this.emit("transcript:draft", { text: transcript });
        }
      }).catch((error) => {
        this.emit("error", { error, phase: "pipeline" });
      });
    };

    this._tick = setInterval(onTick, 25);

    this._stdinDataHandler = (key) => {
      if (key === "\u0003") {
        this.stop();
        return;
      }

      if (key === " ") {
        this._pttPulse();
      }
    };

    if (cfg.stdinPtt) {
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", this._stdinDataHandler);
    }

    this.emit("ready");

    // Story-template opening (D5): if this world starts with an onboarding
    // directive and no narrator reply yet, the narrator opens unprompted.
    // Fire-and-forget — it waits for the backend internally.
    this._kickoffOpening().catch(() => {});
  }

  /**
   * Hot-swap the resolved config (settings saved mid-session). In-flight turns
   * captured `this.cfg` into a local at turn start, so swapping here is safe
   * mid-generation; the next turn picks up the new values.
   *
   * Backend hot-switch (v0.8.0 D7): when the inference block changes, the
   * adapter is rebuilt (adapters are stateless) and template auto-detection
   * re-runs for the new backend — no restart beyond the server's own model
   * load.
   * @param {ReturnType<typeof resolvePipelineConfig>} resolvedConfig
   */
  updateConfig(resolvedConfig) {
    const prevInference = JSON.stringify(this.cfg?.inference ?? null);
    this.cfg = resolvedConfig;
    if (JSON.stringify(resolvedConfig.inference ?? null) !== prevInference) {
      this.inference = createInferenceAdapter(resolvedConfig.inference);
      this._countTokensCached = this._buildTokenCounter();
      if (this._started && resolvedConfig.narrativeTemplate === "auto") {
        this._templateLocked = false;
        this._detectTemplate().catch(() => {});
      }
    }
  }

  reloadSttAdapter(fileCfg) {
    this.sttAdapter = createSttAdapter({
      backend: fileCfg.sttBackend ?? "whisper-cpp",
      whisperBin: process.env.WHISPER_BIN ?? resolveWhisperBin(fileCfg) ?? "",
      whisperModel: process.env.WHISPER_MODEL ?? resolveWhisperModel(fileCfg) ?? "",
      whisperLanguage: process.env.WHISPER_LANGUAGE ?? "en",
      whisperThreads: Number(process.env.WHISPER_THREADS ?? "6"),
      customBin: fileCfg.sttCustomBin ?? "",
      customArgs: fileCfg.sttCustomArgs ?? ""
    });
  }

  /**
   * Clear world-state sections from settings. Mutates the live in-memory
   * world state (never disk-direct — the next pipeline save would clobber a
   * disk-only write) after backing up the on-disk file.
   * @param {string[]} sections
   */
  resetWorldSections(sections) {
    const wanted = (Array.isArray(sections) ? sections : []).filter((s) =>
      RESETTABLE_SECTIONS.includes(String(s ?? "").trim())
    );
    if (wanted.length === 0) return { ok: false, cleared: [] };
    backupWorldStateFile("reset");
    const cleared = resetWorldSections(this.worldState, wanted);
    if (cleared.includes("session_beats")) {
      // Embedding cache is keyed by beat/scene ids — stale after a wipe.
      this._memoryVectors = null;
      try {
        fs.unlinkSync(getMemoryVectorsPath());
      } catch {
        // ignore (file may not exist)
      }
    }
    saveWorldState(this.worldState);
    this.emit("world:updated", { worldState: this.worldState });
    return { ok: true, cleared };
  }

  async loreApplyCorrection(correctionText) {
    const cfg = this.cfg;
    const snapshot = buildExtractorSnapshot(this.worldState);
    const systemPrompt =
      (cfg.loreCorrection._systemPrompt || "").trim() ||
      cfg.loreCorrectionSystem ||
      cfg.extractorSystem;
    const lines = [];
    lines.push(systemPrompt);
    lines.push("");
    lines.push(JSON.stringify(snapshot, null, 2));
    lines.push("");
    lines.push(`The player wants to correct, add, or remove the following: ${correctionText}`);
    lines.push("");
    lines.push("Return ONLY the JSON object.");
    const prompt = lines.join("\n");

    const ex = await runExtractorWithRetry(
      prompt,
      cfg.loreCorrection,
      cfg,
      (pr, gen, c) => this._generate(pr, gen, c)
    );
    console.log("[loreCorrection] raw extractor result:", JSON.stringify(ex, null, 2));
    if (!ex.ok || !ex.diff) return { ok: false };

    const historyEntry = recordCorrection(this.worldState, correctionText, ex.diff);
    // Corrections are model-written (player-instructed): prov stays "ai".
    // No autoKeepPrevious — a correction must not clear this turn's drafts.
    applyExtractorDiff(this.worldState, ex.diff, { prov: "ai" });
    saveWorldState(this.worldState);
    this.emit("world:updated", { worldState: this.worldState });
    return { ok: true, diff: ex.diff, historyId: historyEntry.id };
  }

  /** Undo the newest lore correction (restores pre-application snapshots). */
  loreUndoLast() {
    const entry = undoLastCorrection(this.worldState);
    if (!entry) return { ok: false };
    saveWorldState(this.worldState);
    this.emit("world:updated", { worldState: this.worldState });
    return {
      ok: true,
      entry: {
        id: entry.id,
        ts: entry.ts,
        correctionText: entry.correctionText,
        diff: entry.diff
      }
    };
  }

  /** Correction history without the `before` snapshots (keeps IPC payloads light). */
  loreGetHistory() {
    return (this.worldState.correction_history ?? []).map(
      ({ id, ts, correctionText, diff }) => ({ id, ts, correctionText, diff })
    );
  }

  /**
   * Background memory work after a turn (or an explicit memory action):
   * scene-boundary detection, summary auto-fill, embedding refresh. Never
   * blocks or interrupts play — failures log and emit `memory:error`, which
   * the renderer does not surface as a banner.
   * @param {Set<string>} prevLocationNames - lowercased pre-diff location names
   * @param {object | null} diff - this turn's extractor diff (null for explicit actions)
   */
  _memoryTick(prevLocationNames, diff) {
    if (this._memoryBusy || !this._started) return;
    this._memoryBusy = true;
    this._memoryTickInner(prevLocationNames, diff)
      .catch((error) => {
        console.warn("[pipeline] memory tick failed:", error?.message ?? error);
        this.emit("memory:error", { error });
      })
      .finally(() => {
        this._memoryBusy = false;
      });
  }

  async _memoryTickInner(prevLocationNames, diff) {
    const cfg = this.cfg;
    let dirty = false;

    const reason = detectSceneBoundary(
      this.worldState,
      diff,
      cfg.memory,
      prevLocationNames ?? new Set()
    );
    if (reason) {
      const scene = endScene(this.worldState);
      if (scene) {
        dirty = true;
        this.emit("memory:scene", { sceneId: scene.id, reason });
      }
    }

    if (cfg.memory.autoSummarize) {
      const generate = (prompt) => this._generate(prompt, cfg.summarizer, cfg);
      const done = await runSummarization(this.worldState, generate);
      if (done.scenes.length || done.chapters.length) dirty = true;
    }

    if (dirty) {
      saveWorldState(this.worldState);
      this.emit("world:updated", { worldState: this.worldState });
    }

    const store = this._getMemoryVectors();
    const { changed } = await refreshMemoryVectors(this.worldState, store);
    if (changed) saveMemoryVectors(store);
  }

  /** Lazy-loaded memory vector cache; the memory tick keeps it fresh. */
  _getMemoryVectors() {
    if (!this._memoryVectors) this._memoryVectors = loadMemoryVectors();
    return this._memoryVectors;
  }

  /** Per-turn context assembly report for the debug view (null before first turn). */
  getLastContextReport() {
    return this.lastContextReport;
  }

  /** Current location names, lowercased — "no boundary" baseline for explicit ticks. */
  _locationNameSet() {
    return new Set(
      (this.worldState.locations ?? [])
        .map((l) => String(l?.name ?? "").trim().toLowerCase())
        .filter(Boolean)
    );
  }

  _memorySaveAndEmit() {
    saveWorldState(this.worldState);
    this.emit("world:updated", { worldState: this.worldState });
  }

  /** Explicit "End scene": roll unassigned beats into a scene now. */
  memoryEndScene(title = "") {
    const scene = endScene(this.worldState, title);
    if (!scene) return { ok: false };
    this._memorySaveAndEmit();
    this.emit("memory:scene", { sceneId: scene.id, reason: "explicit" });
    this._memoryTick(this._locationNameSet(), null);
    return { ok: true, sceneId: scene.id };
  }

  /** Explicit "New chapter". */
  memoryStartChapter(title = "") {
    const chapter = startChapter(this.worldState, title);
    this._memorySaveAndEmit();
    return { ok: true, chapterId: chapter.id };
  }

  /**
   * Memory browser edits. `kind`: beat | scene | chapter. Beat edits flag
   * parent summaries stale; summary edits mark the entry player-authored.
   */
  memoryEdit(kind, id, payload = {}) {
    const ws = this.worldState;
    let ok = false;
    if (kind === "beat") {
      ok = editBeat(ws, id, payload.text);
    } else if (kind === "scene") {
      if (typeof payload.title === "string") ok = setSceneTitle(ws, id, payload.title) || ok;
      if (typeof payload.summary === "string") ok = editSceneSummary(ws, id, payload.summary) || ok;
    } else if (kind === "chapter") {
      if (typeof payload.title === "string") ok = setChapterTitle(ws, id, payload.title) || ok;
      if (typeof payload.summary === "string") ok = editChapterSummary(ws, id, payload.summary) || ok;
    }
    if (ok) {
      this._memorySaveAndEmit();
      this._memoryTick(this._locationNameSet(), null);
    }
    return { ok };
  }

  memoryDelete(kind, id) {
    const ws = this.worldState;
    const ok =
      kind === "beat" ? deleteBeat(ws, id)
      : kind === "scene" ? deleteScene(ws, id)
      : kind === "chapter" ? deleteChapter(ws, id)
      : false;
    if (ok) {
      this._memorySaveAndEmit();
      this._memoryTick(this._locationNameSet(), null);
    }
    return { ok };
  }

  memoryPin(kind, id, pinned) {
    const ok = setPinned(this.worldState, kind, id, pinned);
    if (ok) this._memorySaveAndEmit();
    return { ok };
  }

  /**
   * Explicit regenerate for stale/edited summaries (the confirmable path —
   * auto mode never rewrites a non-empty summary).
   * @param {{ sceneIds?: string[], chapterIds?: string[] }} target
   */
  async memoryRegenerate(target = {}) {
    const cfg = this.cfg;
    const generate = (prompt) => this._generate(prompt, cfg.summarizer, cfg);
    const done = await runSummarization(this.worldState, generate, {
      force: true,
      sceneIds: Array.isArray(target.sceneIds) ? target.sceneIds : undefined,
      chapterIds: Array.isArray(target.chapterIds) ? target.chapterIds : undefined
    });
    if (done.scenes.length || done.chapters.length) {
      this._memorySaveAndEmit();
      this._memoryTick(this._locationNameSet(), null);
    }
    return { ok: true, ...done };
  }

  stop() {
    if (!this._started) return;
    // Free the backend if narration is mid-stream so quit isn't blocked.
    if (this._streamActive) {
      this.inference.abort().catch(() => {});
    }
    // Commit any pending response so it survives the restart; its extractor
    // work races shutdown (the Electron quit path waits on "stop" with a
    // timeout, so it usually completes).
    this.acceptPending("stop");
    this._started = false;

    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }

    if (this.recording) {
      this.recording.stop().catch(() => {});
      this.recording = null;
      this.wavPath = "";
    }

    if (this._stdinDataHandler) {
      process.stdin.removeListener("data", this._stdinDataHandler);
      this._stdinDataHandler = null;
      try {
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
      } catch {
        // ignore
      }
    }

    this.emit("stop");
  }
}

/**
 * @param {ReturnType<typeof resolvePipelineConfig>} resolvedConfig - from {@link resolvePipelineConfig}
 */
export function createPipeline(resolvedConfig) {
  return new LocalPipeline(resolvedConfig);
}
