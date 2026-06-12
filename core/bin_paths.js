import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getPackageRoot, getWritableCoreDir } from "./app_paths.js";

/** @param {unknown} v */
function nonEmptyString(v) {
  if (v == null) return "";
  const s = String(v).trim();
  return s;
}

/**
 * `config.example.json` style placeholders (`…path\to\…`) must not win over bundled binaries.
 * @param {string} s
 */
function looksLikeDocPlaceholder(s) {
  return /path[\\/]+to[\\/]+/i.test(String(s));
}

function bundledResourcesBin() {
  const rp = process.resourcesPath;
  if (rp && String(rp).trim()) {
    const p = path.join(rp, "bin");
    if (fs.existsSync(p)) return p;
  }
  const dev = path.join(getPackageRoot(), "resources", "bin");
  if (fs.existsSync(dev)) return dev;
  return "";
}

/**
 * `<userData>/models/` — wizard-downloaded Whisper models land here.
 * Derives from LOCAL_AI_WRITABLE_CORE (set by Electron main to `<userData>/core`).
 */
function userDataModelsDir() {
  const coreDir = getWritableCoreDir();
  return path.resolve(coreDir, "..", "models");
}

/**
 * `<userData>/bin/` — wizard-downloaded binaries (e.g. ffmpeg.exe) land here.
 */
function userDataBinDir() {
  const coreDir = getWritableCoreDir();
  return path.resolve(coreDir, "..", "bin");
}

/**
 * @param {string} name
 * @returns {string}
 */
function whichOnPath(name) {
  if (process.platform === "win32") {
    const r = spawnSync("where.exe", [name], {
      encoding: "utf8",
      shell: false
    });
    const line = String(r.stdout ?? "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    return line && fs.existsSync(line) ? line : "";
  }
  const r = spawnSync("which", [name], {
    encoding: "utf8",
    shell: false
  });
  const line = String(r.stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  return line && fs.existsSync(line) ? line : "";
}

/**
 * Priority: explicit `config` value → bundled `resources/bin` (packaged or repo) → PATH / which.
 * @param {Record<string, unknown>} config
 * @param {string} configKey
 * @param {string} bundledFileName e.g. ffmpeg.exe
 * @param {string} pathFallback bare executable name for spawn
 */
function resolveBinary(config, configKey, bundledFileName, pathFallback) {
  const explicit = nonEmptyString(config?.[configKey]);
  if (explicit) return explicit;

  const binDir = bundledResourcesBin();
  if (binDir) {
    const bundled = path.join(binDir, bundledFileName);
    if (fs.existsSync(bundled)) return bundled;
  }

  if (pathFallback) {
    const found = whichOnPath(pathFallback);
    if (found) return found;
    return pathFallback;
  }
  return "";
}

/**
 * Priority: config path (if exists) → <userData>/bin/ → bundled resources/bin/ → PATH.
 * @param {Record<string, unknown>} config
 */
export function resolveFfmpegBin(config) {
  const explicit = nonEmptyString(config?.ffmpegBin);
  if (explicit && !looksLikeDocPlaceholder(explicit) && fs.existsSync(explicit)) {
    return explicit;
  }

  const udBin = userDataBinDir();
  const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const udCandidate = path.join(udBin, ffmpegName);
  if (fs.existsSync(udCandidate)) return udCandidate;

  const binDir = bundledResourcesBin();
  if (binDir) {
    const bundled = path.join(binDir, ffmpegName);
    if (fs.existsSync(bundled)) return bundled;
  }

  const found = whichOnPath("ffmpeg");
  if (found) return found;
  return "ffmpeg";
}

/**
 * @param {Record<string, unknown>} config
 */
export function resolveWhisperBin(config) {
  let explicit = nonEmptyString(config?.whisperBin);
  if (explicit && looksLikeDocPlaceholder(explicit)) {
    console.log(
      "[bin_paths] resolveWhisperBin: ignoring doc placeholder whisperBin:",
      explicit
    );
    explicit = "";
  }
  if (explicit) {
    const ok = fs.existsSync(explicit);
    console.log(
      "[bin_paths] resolveWhisperBin: using config path",
      explicit,
      "exists=",
      ok
    );
    if (ok) return explicit;
    console.warn(
      "[bin_paths] resolveWhisperBin: config path missing on disk, trying bundled"
    );
  }

  const whisperExe = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

  const udBin = userDataBinDir();
  const udCandidate = path.join(udBin, whisperExe);
  if (fs.existsSync(udCandidate)) {
    console.log("[bin_paths] resolveWhisperBin: found in userData/bin:", udCandidate);
    return udCandidate;
  }

  const binDir = bundledResourcesBin();
  console.log(
    "[bin_paths] resolveWhisperBin: process.resourcesPath=",
    process.resourcesPath ?? "(undefined)",
    "bundled binDir=",
    binDir || "(none)"
  );
  if (binDir) {
    const bundled = path.join(binDir, whisperExe);
    const exists = fs.existsSync(bundled);
    console.log(
      "[bin_paths] resolveWhisperBin: bundled candidate",
      bundled,
      "exists=",
      exists
    );
    if (exists) return bundled;
  }

  const found = whichOnPath("whisper-cli");
  if (found) {
    console.log("[bin_paths] resolveWhisperBin: PATH which whisper-cli ->", found);
    return found;
  }
  console.warn("[bin_paths] resolveWhisperBin: unresolved (no bundled exe, not on PATH)");
  return "whisper-cli";
}

/** Known Whisper model filenames for fallback scanning. */
const WHISPER_MODEL_NAMES = [
  "ggml-medium.bin",
  "ggml-small.bin",
  "ggml-base.bin"
];

/**
 * Resolution priority: config path → <userData>/models/ → bundled resources/bin/ → empty.
 * @param {Record<string, unknown>} config
 */
export function resolveWhisperModel(config) {
  let explicit = nonEmptyString(config?.whisperModel);
  if (explicit && looksLikeDocPlaceholder(explicit)) {
    console.log(
      "[bin_paths] resolveWhisperModel: ignoring doc placeholder whisperModel:",
      explicit
    );
    explicit = "";
  }
  if (explicit) {
    const ok = fs.existsSync(explicit);
    console.log(
      "[bin_paths] resolveWhisperModel: using config path",
      explicit,
      "exists=",
      ok
    );
    if (ok) return explicit;
    console.warn(
      "[bin_paths] resolveWhisperModel: config path missing on disk, trying userData/models"
    );
  }

  const modelsDir = userDataModelsDir();
  console.log("[bin_paths] resolveWhisperModel: userData modelsDir=", modelsDir);
  if (fs.existsSync(modelsDir)) {
    for (const name of WHISPER_MODEL_NAMES) {
      const candidate = path.join(modelsDir, name);
      if (fs.existsSync(candidate)) {
        console.log("[bin_paths] resolveWhisperModel: found in userData/models:", candidate);
        return candidate;
      }
    }
  }

  const binDir = bundledResourcesBin();
  console.log(
    "[bin_paths] resolveWhisperModel: bundled binDir=",
    binDir || "(none)"
  );
  if (binDir) {
    for (const name of WHISPER_MODEL_NAMES) {
      const bundled = path.join(binDir, name);
      if (fs.existsSync(bundled)) {
        console.log("[bin_paths] resolveWhisperModel: bundled candidate", bundled);
        return bundled;
      }
    }
  }
  console.warn("[bin_paths] resolveWhisperModel: unresolved (no model found)");
  return "";
}

/**
 * Priority: config path (if exists) → <userData>/bin/ → bundled resources/bin/ → PATH.
 * @param {Record<string, unknown>} config
 */
export function resolveKoboldBin(config) {
  const explicit = nonEmptyString(config?.koboldBin);
  if (explicit && !looksLikeDocPlaceholder(explicit) && fs.existsSync(explicit)) {
    return explicit;
  }

  const udBin = userDataBinDir();
  const koboldName = process.platform === "win32" ? "koboldcpp.exe" : "koboldcpp";
  const udCandidate = path.join(udBin, koboldName);
  if (fs.existsSync(udCandidate)) return udCandidate;

  const binDir = bundledResourcesBin();
  if (binDir) {
    const bundled = path.join(binDir, koboldName);
    if (fs.existsSync(bundled)) return bundled;
  }

  const found = whichOnPath("koboldcpp");
  if (found) return found;
  return "koboldcpp";
}

/**
 * First `*.gguf` in a directory (lexicographic), or empty string.
 * @param {string} dir
 */
export function firstGgufInDir(dir) {
  if (!dir || !fs.existsSync(dir)) return "";
  let best = "";
  try {
    const names = fs.readdirSync(dir);
    for (const n of names.sort()) {
      if (n.toLowerCase().endsWith(".gguf")) {
        const full = path.join(dir, n);
        if (fs.statSync(full).isFile()) {
          best = full;
          break;
        }
      }
    }
  } catch {
    return "";
  }
  return best;
}

/**
 * @param {Record<string, unknown>} config
 */
export function resolveKoboldModel(config) {
  const explicit = nonEmptyString(config?.koboldModel);
  if (explicit) return explicit;

  const binDir = bundledResourcesBin();
  if (binDir) {
    const modelsDir = path.join(binDir, "models");
    const bundled = firstGgufInDir(modelsDir);
    if (bundled) return bundled;
  }
  return "";
}

/**
 * Whether a bundled GGUF exists under `bin/models/` (packaged or dev `resources/bin/models`).
 */
export function hasBundledGgufModel() {
  return Boolean(nonEmptyString(resolveKoboldModel({})));
}

export { userDataModelsDir, userDataBinDir };
