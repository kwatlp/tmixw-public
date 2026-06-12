import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  protocol,
  dialog
} from "electron";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  resolveFfmpegBin,
  resolveKoboldBin,
  resolveKoboldModel,
  resolveWhisperBin,
  resolveWhisperModel,
  hasBundledGgufModel,
  userDataModelsDir,
  userDataBinDir
} from "../core/bin_paths.js";

const require = createRequire(import.meta.url);
const log = require("electron-log/main");

/**
 * Rebindable push-to-talk keys (v0.8.4 Voice HUD). Each entry maps a
 * KeyboardEvent.code to the Electron accelerator (global shortcut while
 * unfocused) and the Windows virtual key (GetAsyncKeyState release poll).
 * Whitelist only — keys without a clean accelerator+VK pair are rejected.
 */
const PTT_KEYS = {
  Backquote: { accelerator: "`", vk: 0xc0, label: "`" },
  ScrollLock: { accelerator: "Scrolllock", vk: 0x91, label: "scroll lock" },
  Insert: { accelerator: "Insert", vk: 0x2d, label: "insert" },
  ...Object.fromEntries(
    // F1–F24: VK_F1 = 0x70 … VK_F24 = 0x87
    Array.from({ length: 24 }, (_, i) => [
      `F${i + 1}`,
      { accelerator: `F${i + 1}`, vk: 0x70 + i, label: `F${i + 1}` }
    ])
  )
};

/** Active PTT binding (KeyboardEvent.code into PTT_KEYS); mutable via ptt:setKey. */
let currentPttCode = "Backquote";

function currentPttKey() {
  return PTT_KEYS[currentPttCode] ?? PTT_KEYS.Backquote;
}

/** Read the configured PTT key from config.json (pushToTalk.key, a KeyboardEvent.code). */
function initPttKeyFromConfig(cfg) {
  const code = String(cfg?.pushToTalk?.key ?? "").trim();
  if (code && PTT_KEYS[code]) currentPttCode = code;
}

let mainProcessFileLogHooked = false;

function envWantsMainDebugLog() {
  const v = process.env.TMIXW_DEBUG;
  return v === "1" || v === "true" || v === "yes";
}

/** When `TMIXW_DEBUG` is set or `config.json` has `"debug": true`, mirror `console.*` to `%AppData%/Roaming/tmixw/tmixw-main.log`. */
function hookMainProcessConsoleToFile(reason) {
  if (mainProcessFileLogHooked) return;
  mainProcessFileLogHooked = true;
  try {
    log.initialize();
    log.transports.file.resolvePathFn = () =>
      path.join(app.getPath("userData"), "tmixw-main.log");
    log.transports.file.level = "debug";
    Object.assign(console, log.functions);
    console.log(
      "[main] electron-log file capture enabled:",
      reason,
      "path:",
      log.transports.file.resolvePathFn()
    );
  } catch (err) {
    process.stderr.write(
      `[main] electron-log hook failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
  }
}

app.setName("tmixw");
if (envWantsMainDebugLog()) {
  hookMainProcessConsoleToFile("TMIXW_DEBUG");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEV_SERVER_URL =
  process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:5173";

/** @type {{ on: (...args: unknown[]) => unknown, start?: () => void, stop?: () => void } | null} */
let pipeline = null;
/** @type {import('node:child_process').ChildProcess | null} */
let koboldProcess = null;
/** True if this session spawned KoboldCPP (do not kill an unrelated listener on 5001). */
let koboldStartedByUs = false;
/** True while we are intentionally killing KoboldCPP (suppress spurious renderer errors). */
let koboldIntentionalStop = false;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Live config object read from disk; updated after first-run wizard. */
let liveFileCfg = {};
/** Resolved `config.json` path (dev: repo core; packaged: userData/core when present). */
let CONFIG_PATH = "";
let bundleRoot = "";
let narrativeSystemText = "";
let extractorSystemText = "";
let loreCorrectionSystemText = "";
const KOBOLD_PORT = 5001;
/** True after `globalShortcut` fired for PTT key (no keyup API — release via poll). */
let pttFromUnfocusedShortcut = false;
/** True after Backquote (`) keydown for PTT (`before-input-event`); poll releases if keyup is lost. */
let pttSpaceChordActive = false;

/** @type {AbortController | null} Active download abort controller for wizard downloads. */
let activeDownloadAbort = null;

/** Settings prompt overrides (`narrative._systemPrompt`) take precedence over the bundled prompt files. */
function resolveNarrativeSystem() {
  return (liveFileCfg.narrative?._systemPrompt ?? "").trim() || narrativeSystemText;
}

function resolveExtractorSystem() {
  return (liveFileCfg.extractor?._systemPrompt ?? "").trim() || extractorSystemText;
}

function isDevRuntime() {
  return !app.isPackaged;
}

function appRoot() {
  return app.getAppPath();
}

async function preparePackagedWritableCore(bundleRoot, userDataCore) {
  await fs.promises.mkdir(userDataCore, { recursive: true });
  process.env.LOCAL_AI_WRITABLE_CORE = userDataCore;
  for (const name of ["world_state.json"]) {
    const from = path.join(bundleRoot, "core", name);
    const to = path.join(userDataCore, name);
    try {
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        fs.copyFileSync(from, to);
      }
    } catch {
      // ignore seed failures
    }
  }
  // Phase 4: do not auto-copy `config.json` here — first-run wizard writes
  // `%AppData%/Roaming/tmixw/core/config.json` with `wizardComplete: true`.
}

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

function safeRelToRoot(relPath) {
  return String(relPath ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((seg) => seg && seg !== ".." && seg !== ".")
    .join(path.sep);
}

/** @param {string} candidate @param {string} rootDir */
function isPathInsideAppRoot(candidate, rootDir) {
  const absC = path.resolve(candidate);
  const absR = path.resolve(rootDir);
  const rel = path.relative(absR, absC);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== "..");
}

function stripLoreEntry(e) {
  return {
    title: e?.title ?? "",
    content: e?.content ?? "",
    keywords: Array.isArray(e?.keywords) ? e.keywords : []
  };
}

function serializeLoreDetailed(d) {
  return {
    merged: d.merged.map(stripLoreEntry),
    keywordScored: d.keywordScored.map((r) => ({
      score: r.score,
      entry: stripLoreEntry(r.entry)
    })),
    vectorScored: d.vectorScored.map((r) => ({
      score: r.score,
      entry: stripLoreEntry(r.entry)
    })),
    vectorOnlyDisplay: d.vectorOnlyDisplay.map((r) => ({
      score: r.score,
      entry: stripLoreEntry(r.entry)
    }))
  };
}

/** @param {Record<string, unknown> | null} cfg */
function needsWizard(cfg) {
  if (!cfg || typeof cfg !== "object") return true;
  return cfg.wizardComplete !== true;
}

/**
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeoutMs]
 */
function portIsListening(port, host = "127.0.0.1", timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ port, host }, () => {
      try {
        sock.end();
      } catch {
        // ignore
      }
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.setTimeout(timeoutMs, () => {
      try {
        sock.destroy();
      } catch {
        // ignore
      }
      resolve(false);
    });
  });
}

/**
 * @param {number} port
 * @param {number} [totalTimeoutMs]
 * @param {number} [intervalMs]
 */
async function waitUntilPortOpen(
  port,
  totalTimeoutMs = 120_000,
  intervalMs = 400
) {
  const deadline = Date.now() + totalTimeoutMs;
  while (Date.now() < deadline) {
    if (await portIsListening(port, "127.0.0.1", 2000)) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** @param {string} channel @param {unknown} [payload] */
function sendToRenderer(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (wc.isDestroyed()) return;
    wc.send(channel, payload);
  } catch (err) {
    console.error(
      "[main→renderer]",
      channel,
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * @param {string} koboldBin
 * @param {string} modelPath
 * @param {number} [port]
 */
async function startKoboldCpp(koboldBin, modelPath, port = KOBOLD_PORT) {
  if (await portIsListening(port)) {
    console.log("[kobold] KoboldCPP already listening; skipping spawn");
    sendToRenderer("kobold:ready", { port, reused: true });
    return;
  }

  if (!koboldBin || !modelPath) {
    console.warn("[kobold] Missing binary or model path; not spawning");
    sendToRenderer("kobold:error", {
      message: "KoboldCPP binary or model path is not configured."
    });
    return;
  }

  const contextSize = Number(liveFileCfg.koboldContextSize) || 4096;
  const args = [
    "--model",
    modelPath,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--contextsize",
    String(contextSize)
  ];

  try {
    koboldProcess = spawn(koboldBin, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[kobold] spawn failed", msg);
    sendToRenderer("kobold:error", { message: msg });
    return;
  }

  koboldStartedByUs = true;
  let stderrBuf = "";
  koboldProcess.stderr?.on("data", (d) => {
    stderrBuf += d.toString("utf8");
    if (stderrBuf.length > 8000) stderrBuf = stderrBuf.slice(-4000);
  });
  koboldProcess.stdout?.on("data", (d) => {
    const s = d.toString("utf8");
    if (s.length < 2000) console.log("[kobold]", s.trim());
  });
  koboldProcess.on("error", (e) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[kobold] process error", msg);
    sendToRenderer("kobold:error", { message: msg });
  });
  koboldProcess.on("exit", (code, signal) => {
    console.warn("[kobold] exited", { code, signal });
    const intentional = koboldIntentionalStop;
    koboldIntentionalStop = false;
    const weOwned = koboldStartedByUs;
    koboldStartedByUs = false;
    koboldProcess = null;
    if (weOwned && !intentional && code !== 0 && code != null) {
      sendToRenderer("kobold:error", {
        message: `KoboldCPP exited (${code ?? signal ?? "unknown"}). ${stderrBuf}`.trim()
      });
    }
  });

  const ok = await waitUntilPortOpen(port);
  if (!ok) {
    console.error("[kobold] timed out waiting for port", port);
    sendToRenderer("kobold:error", {
      message: `Timed out waiting for KoboldCPP on port ${port}.`
    });
    if (koboldProcess && koboldStartedByUs) {
      koboldIntentionalStop = true;
      try {
        koboldProcess.kill();
      } catch {
        // ignore
      }
      koboldProcess = null;
      koboldStartedByUs = false;
    }
    return;
  }
  console.log("[kobold] ready on port", port);
  sendToRenderer("kobold:ready", { port, reused: false });
}

function stopKoboldIfStartedByUs() {
  if (!koboldStartedByUs || !koboldProcess) return;
  koboldIntentionalStop = true;
  const pid = koboldProcess.pid;
  if (pid && process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore", timeout: 5000 });
    } catch {
      try { koboldProcess.kill(); } catch { /* ignore */ }
    }
  } else {
    try {
      koboldProcess.kill();
    } catch {
      // ignore
    }
  }
  koboldProcess = null;
  koboldStartedByUs = false;
}

/**
 * Backend startup (v0.8.0 D6): the KoboldCPP binary is auto-spawned only
 * when it is the selected backend. Every other backend is a user-run server
 * — health-checked, never spawned; `kobold:ready`/`kobold:error` keep their
 * channel names as the generic "backend ready" signals.
 */
async function startKoboldFromConfig() {
  const backend = liveFileCfg.inference?.backend ?? "koboldcpp";
  if (backend !== "koboldcpp") {
    try {
      const { buildInferenceRuntimeConfig, createInferenceAdapter } = await import(
        "../core/inference/index.js"
      );
      const inf = buildInferenceRuntimeConfig(liveFileCfg);
      const h = await createInferenceAdapter(inf).health();
      if (h.ok) {
        console.log(`[inference] ${backend} backend ready at ${inf.url} (model: ${h.model})`);
        sendToRenderer("kobold:ready", { port: null, reused: true, backend, model: h.model });
      } else {
        sendToRenderer("kobold:error", {
          message: `${backend} backend not reachable at ${inf.url}: ${h.error}`
        });
      }
    } catch (e) {
      sendToRenderer("kobold:error", { message: e?.message ?? String(e) });
    }
    return;
  }
  const bin = resolveKoboldBin(liveFileCfg);
  const model = resolveKoboldModel(liveFileCfg);
  await startKoboldCpp(bin, model, KOBOLD_PORT);
}

function mimeForExt(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html") return "text/html";
  if (ext === ".js") return "text/javascript";
  if (ext === ".css") return "text/css";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function wirePipelineToWindow() {
  if (!pipeline) return;

  const fwd = sendToRenderer;

  pipeline.on("ready", () => fwd("ready", {}));
  pipeline.on("recording:start", (p) => fwd("recording:start", p));
  pipeline.on("recording:stop", (p) => fwd("recording:stop", p));
  pipeline.on("transcript", (p) => fwd("transcript", p));
  pipeline.on("transcript:draft", (p) => fwd("transcript:draft", p));
  pipeline.on("narrative", (p) => fwd("narrative", p));
  pipeline.on("narrative:token", (p) => fwd("narrative:token", p));
  pipeline.on("narrative:pending", (p) => fwd("narrative:pending", p));
  pipeline.on("narrative:accepted", (p) => fwd("narrative:accepted", p));
  pipeline.on("narrative:updated", (p) => fwd("narrative:updated", p));
  pipeline.on("extractor:ok", (p) => fwd("extractor:ok", p));
  pipeline.on("extractor:skip", (p) => fwd("extractor:skip", p));
  pipeline.on("world:updated", (p) => fwd("world:updated", p));
  pipeline.on("memory:scene", (p) => fwd("memory:scene", p));
  // Memory failures must never interrupt play — log only, no error banner.
  pipeline.on("memory:error", (p) => {
    const message = p?.error?.message ?? String(p?.error ?? "error");
    console.warn(`[pipeline memory] ${message}`);
  });
  pipeline.on("error", (p) => {
    const message = p?.error?.message ?? String(p?.error ?? "error");
    console.error(`[pipeline error] (${p?.phase ?? "?"}) ${message}`);
    fwd("error", { phase: p?.phase, error: message });
  });
  pipeline.on("stop", () => fwd("stop", {}));
}

/**
 * Registers a **single** global hotkey callback. Electron does **not** expose keyup for
 * `globalShortcut` — only this callback (keydown edge). Key release while unfocused
 * is handled by the `GetAsyncKeyState` poll in `main()` together with `pttFromUnfocusedShortcut`.
 */
function updateGlobalPttShortcut(accelerator) {
  globalShortcut.unregisterAll();
  if (!mainWindow || mainWindow.isDestroyed()) {
    console.warn("[ptt] updateGlobalPttShortcut: no mainWindow, skip register");
    return;
  }
  if (mainWindow.isFocused()) {
    console.log(
      "[ptt] updateGlobalPttShortcut: window focused — PTT uses before-input-event (Backquote); global shortcut not registered"
    );
    return;
  }
  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!pipeline) {
        console.warn("[ptt] globalShortcut PTT: pipeline null");
        return;
      }
      pttFromUnfocusedShortcut = true;
      pttSpaceChordActive = true;
      pipeline.setPttState(true);
    });
    if (ok) {
      console.log("[ptt] globalShortcut.register succeeded", JSON.stringify(accelerator));
    } else {
      console.warn(
        "[ptt] globalShortcut.register returned false (often reserved or in use)",
        JSON.stringify(accelerator)
      );
    }
  } catch (e) {
    console.warn("[ptt] globalShortcut.register threw", JSON.stringify(accelerator), e);
  }
}

/** @param {Record<string, unknown>} resolved */
function createMainWindow(resolved, _fileCfg) {
  const dev = isDevRuntime();
  mainWindow = new BrowserWindow({
    title: "tmixw",
    width: 1280,
    height: 800,
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !dev
    }
  });

  if (dev) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexHtml = path.join(
      appRoot(),
      "renderer",
      "dist",
      "index.html"
    );
    mainWindow.loadFile(indexHtml);
  }

  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (resolved.stdinPtt !== false) return;
    if (input.code !== currentPttCode || input.isAutoRepeat) return;
    if (input.type === "keyDown") {
      console.log(`[ptt] before-input-event ${currentPttCode} keyDown`, {
        hasPipeline: Boolean(pipeline),
        pipelineStarted: Boolean(pipeline?._started)
      });
      pttFromUnfocusedShortcut = false;
      pttSpaceChordActive = true;
      pipeline?.setPttState(true);
      event.preventDefault();
    } else if (input.type === "keyUp") {
      pttSpaceChordActive = false;
      pipeline?.setPttState(false);
      pttFromUnfocusedShortcut = false;
      event.preventDefault();
    }
  });

  mainWindow.on("focus", () => {
    globalShortcut.unregisterAll();
  });
  mainWindow.on("blur", () => updateGlobalPttShortcut(currentPttKey().accelerator));

  mainWindow.webContents.once("did-finish-load", () => {
    if (!mainWindow?.isFocused()) {
      updateGlobalPttShortcut(currentPttKey().accelerator);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function registerAppProtocol() {
  if (!app.isPackaged) return;

  protocol.handle("app", async (request) => {
    const u = new URL(request.url);
    let pathname = decodeURIComponent(u.pathname || "");
    const host = (u.hostname || "").trim();
    if (host) {
      pathname = `/${host}${pathname === "/" ? "" : pathname}`;
    }
    const rel = safeRelToRoot(pathname.replace(/^\/+/, ""));
    if (!rel) {
      console.error("[app protocol] 404 empty path", request.url);
      return new Response(null, { status: 404 });
    }
    const root = path.normalize(appRoot());
    const filePath = path.normalize(path.join(root, rel));
    const ok = isPathInsideAppRoot(filePath, root) && fs.existsSync(filePath);
    if (!ok) {
      console.error(
        "[app protocol] 404",
        JSON.stringify({
          requestUrl: request.url,
          rel,
          resolved: filePath,
          appPath: root,
          exists: fs.existsSync(filePath)
        })
      );
      return new Response(null, { status: 404 });
    }
    const data = await fs.promises.readFile(filePath);
    return new Response(data, {
      headers: { "content-type": mimeForExt(filePath) }
    });
  });
}

/**
 * @param {{
 *   loadWorldState: typeof import("../core/world_state.js").loadWorldState,
 *   saveWorldState: typeof import("../core/world_state.js").saveWorldState,
 *   mergeCharacterCard: typeof import("../core/world_state.js").mergeCharacterCard,
 *   buildLoreRuntimeConfig: typeof import("../core/world_state.js").buildLoreRuntimeConfig,
 *   mergedLorebookMatchesDetailed: typeof import("../core/world_state.js").mergedLorebookMatchesDetailed
 * }} ws
 * @param {typeof import("../core/codex.js")} codex
 * @param {{ bootPipelineFromDisk: () => Promise<void> }} lifecycle
 */
function registerIpcHandlers(ws, codex, lifecycle) {
  const { bootPipelineFromDisk } = lifecycle;
  const {
    loadWorldState,
    saveWorldState,
    mergeCharacterCard,
    buildLoreRuntimeConfig,
    mergedLorebookMatchesDetailed
  } = ws;

  /**
   * Run a mutation against the live world state — the pipeline's in-memory
   * object when booted (so the next turn sees the edit), the on-disk state
   * otherwise — then persist and notify the renderer.
   * @param {(state: object) => any} fn
   */
  const mutateWorld = (fn) => {
    const state = pipeline ? pipeline.worldState : loadWorldState();
    const result = fn(state);
    saveWorldState(state);
    if (pipeline) {
      pipeline.emit("world:updated", { worldState: state });
    } else {
      sendToRenderer("world:updated", { worldState: state });
    }
    return result;
  };

  ipcMain.handle("app:getBootstrap", () => ({
    needsWizard: needsWizard(liveFileCfg),
    hasBundledModel: hasBundledGgufModel(),
    platform: process.platform
  }));

  ipcMain.handle("kobold:status", async () => {
    const backend = liveFileCfg.inference?.backend ?? "koboldcpp";
    if (backend !== "koboldcpp") {
      const { buildInferenceRuntimeConfig, createInferenceAdapter } = await import(
        "../core/inference/index.js"
      );
      const inf = buildInferenceRuntimeConfig(liveFileCfg);
      const h = await createInferenceAdapter(inf).health();
      return { running: h.ok, backend, model: h.model ?? "", startedByUs: false };
    }
    return {
      running: await portIsListening(KOBOLD_PORT),
      port: KOBOLD_PORT,
      backend,
      startedByUs: koboldStartedByUs
    };
  });

  // Validate an UNSAVED inference draft (v0.8.0 validate-on-save).
  ipcMain.handle("settings:validateInference", async (_e, draftInference) => {
    try {
      const { buildInferenceRuntimeConfig, createInferenceAdapter } = await import(
        "../core/inference/index.js"
      );
      const inf = buildInferenceRuntimeConfig({
        ...liveFileCfg,
        inference: draftInference ?? {}
      });
      const h = await createInferenceAdapter(inf).health();
      return { ...h, backend: inf.backend, url: inf.url };
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle("wizard:listMics", async () => {
    const { listDshowAudioDevices } = await import("../core/pipeline.js");
    const ffmpegBin = resolveFfmpegBin(liveFileCfg || {});
    const devices = listDshowAudioDevices({ ffmpegBin });
    return { devices };
  });

  ipcMain.handle("wizard:testMic", async (_e, deviceName) => {
    const device = String(deviceName ?? "").trim();
    if (!device) {
      return { ok: false, error: "No microphone selected." };
    }
    const ffmpegBin = resolveFfmpegBin(liveFileCfg || {});
    const tmp = path.join(
      app.getPath("userData"),
      `wizard-mic-test-${Date.now()}.wav`
    );

    let inputArgs;
    if (process.platform === "darwin") {
      const inputSpec = device.startsWith(":") ? device : `:${device}`;
      inputArgs = ["-f", "avfoundation", "-i", inputSpec];
    } else if (process.platform === "linux") {
      inputArgs = ["-f", "alsa", "-i", device];
    } else {
      inputArgs = ["-f", "dshow", "-i", `audio=${device}`];
    }

    await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpegBin,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          ...inputArgs,
          "-t", "2", "-ac", "1", "-ar", "16000",
          tmp
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let err = "";
      child.stderr?.on("data", (d) => {
        err += d.toString("utf8");
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && code !== 255) {
          reject(new Error((err || `ffmpeg exited ${code}`).trim()));
          return;
        }
        resolve();
      });
    });
    const buf = await fs.promises.readFile(tmp);
    await fs.promises.unlink(tmp).catch(() => {});
    return { ok: true, audioBase64: buf.toString("base64") };
  });

  ipcMain.handle("wizard:pickModel", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: "Select GGUF model",
      filters: [{ name: "GGUF models", extensions: ["gguf"] }],
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths?.[0]) {
      return { canceled: true, path: "" };
    }
    const modelPath = r.filePaths[0];
    let sizeBytes = 0;
    try {
      sizeBytes = (await fs.promises.stat(modelPath)).size;
    } catch {
      sizeBytes = 0;
    }
    return { canceled: false, path: modelPath, sizeBytes };
  });

  const WHISPER_MODELS = {
    medium: { file: "ggml-medium.bin", size: 1533_000_000, label: "Medium (~1.5 GB)" },
    small: { file: "ggml-small.bin", size: 488_000_000, label: "Small (~466 MB)" },
    base: { file: "ggml-base.bin", size: 148_000_000, label: "Base (~142 MB)" }
  };

  ipcMain.handle("wizard:downloadWhisper", async (_e, modelId) => {
    const model = WHISPER_MODELS[modelId];
    if (!model) throw new Error(`Unknown model: ${modelId}`);

    const modelsDir = userDataModelsDir();
    await fs.promises.mkdir(modelsDir, { recursive: true });
    const destPath = path.join(modelsDir, model.file);

    if (fs.existsSync(destPath)) {
      const stat = await fs.promises.stat(destPath);
      if (stat.size > 1000) {
        return { ok: true, path: destPath, alreadyExists: true };
      }
    }

    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${model.file}`;
    const abort = new AbortController();
    activeDownloadAbort = abort;

    try {
      const res = await fetch(url, {
        signal: abort.signal,
        redirect: "follow"
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const totalBytes = Number(res.headers.get("content-length") || model.size);
      let received = 0;
      const tmpPath = destPath + ".tmp";
      const writer = fs.createWriteStream(tmpPath);
      let lastProgressAt = 0;

      for await (const chunk of res.body) {
        if (abort.signal.aborted) break;
        writer.write(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt > 250) {
          lastProgressAt = now;
          sendToRenderer("wizard:downloadProgress", {
            received,
            total: totalBytes,
            percent: Math.round((received / totalBytes) * 100)
          });
        }
      }

      writer.end();
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      if (abort.signal.aborted) {
        await fs.promises.unlink(tmpPath).catch(() => {});
        return { ok: false, cancelled: true };
      }

      await fs.promises.rename(tmpPath, destPath);
      sendToRenderer("wizard:downloadProgress", {
        received: totalBytes,
        total: totalBytes,
        percent: 100
      });
      return { ok: true, path: destPath };
    } catch (err) {
      if (err.name === "AbortError") {
        return { ok: false, cancelled: true };
      }
      throw err;
    } finally {
      activeDownloadAbort = null;
    }
  });

  ipcMain.handle("wizard:cancelDownload", () => {
    if (activeDownloadAbort) {
      activeDownloadAbort.abort();
      activeDownloadAbort = null;
    }
    return { ok: true };
  });

  ipcMain.handle("wizard:checkFfmpeg", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("ffmpeg", ["-version"], {
      encoding: "utf8",
      shell: false,
      timeout: 5000
    });
    if (r.status === 0 && r.stdout) {
      let resolved = "ffmpeg";
      if (process.platform === "win32") {
        const wr = spawnSync("where.exe", ["ffmpeg"], { encoding: "utf8", shell: false });
        const line = String(wr.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
        if (line && fs.existsSync(line)) resolved = line;
      } else {
        const wr = spawnSync("which", ["ffmpeg"], { encoding: "utf8", shell: false });
        const line = String(wr.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
        if (line && fs.existsSync(line)) resolved = line;
      }
      return { found: true, path: resolved };
    }
    const udBin = userDataBinDir();
    const ffmpegName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
    const udCandidate = path.join(udBin, ffmpegName);
    if (fs.existsSync(udCandidate)) {
      return { found: true, path: udCandidate };
    }
    return { found: false, path: "" };
  });

  ipcMain.handle("wizard:downloadFfmpeg", async () => {
    if (process.platform !== "win32") {
      return { ok: false, error: "FFmpeg download is only supported on Windows. Please install via your package manager." };
    }

    const binDir = userDataBinDir();
    await fs.promises.mkdir(binDir, { recursive: true });
    const destPath = path.join(binDir, "ffmpeg.exe");

    if (fs.existsSync(destPath)) {
      return { ok: true, path: destPath, alreadyExists: true };
    }

    const url = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    const abort = new AbortController();
    activeDownloadAbort = abort;
    const tmpZip = path.join(binDir, "ffmpeg-download.zip");

    try {
      const res = await fetch(url, { signal: abort.signal, redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const totalBytes = Number(res.headers.get("content-length") || 0);
      let received = 0;
      const writer = fs.createWriteStream(tmpZip);
      let lastProgressAt = 0;

      for await (const chunk of res.body) {
        if (abort.signal.aborted) break;
        writer.write(chunk);
        received += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt > 500) {
          lastProgressAt = now;
          sendToRenderer("wizard:downloadProgress", {
            received,
            total: totalBytes || received * 2,
            percent: totalBytes ? Math.round((received / totalBytes) * 100) : -1,
            label: "FFmpeg"
          });
        }
      }

      writer.end();
      await new Promise((resolve, reject) => {
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      if (abort.signal.aborted) {
        await fs.promises.unlink(tmpZip).catch(() => {});
        return { ok: false, cancelled: true };
      }

      sendToRenderer("wizard:downloadProgress", {
        received, total: received, percent: 100, label: "FFmpeg (extracting...)"
      });

      const { execSync } = await import("node:child_process");
      const extractDir = path.join(binDir, "ffmpeg-extract");
      await fs.promises.mkdir(extractDir, { recursive: true });
      execSync(
        `powershell -NoProfile -Command "Expand-Archive -Force '${tmpZip}' '${extractDir}'"`,
        { timeout: 60_000 }
      );

      let ffmpegExe = "";
      const findFfmpeg = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            const found = findFfmpeg(full);
            if (found) return found;
          } else if (e.name.toLowerCase() === "ffmpeg.exe") {
            return full;
          }
        }
        return "";
      };
      ffmpegExe = findFfmpeg(extractDir);

      if (!ffmpegExe) {
        throw new Error("Could not find ffmpeg.exe in downloaded archive");
      }

      await fs.promises.copyFile(ffmpegExe, destPath);
      await fs.promises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fs.promises.unlink(tmpZip).catch(() => {});

      return { ok: true, path: destPath };
    } catch (err) {
      if (err.name === "AbortError") {
        await fs.promises.unlink(tmpZip).catch(() => {});
        return { ok: false, cancelled: true };
      }
      throw err;
    } finally {
      activeDownloadAbort = null;
    }
  });

  ipcMain.handle("wizard:checkWhisperCli", async () => {
    const { spawnSync: spSync } = await import("node:child_process");
    const whisperName = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";

    const udBin = userDataBinDir();
    const udCandidate = path.join(udBin, whisperName);
    if (fs.existsSync(udCandidate)) {
      return { found: true, path: udCandidate };
    }

    if (process.platform === "win32") {
      const r = spSync("where.exe", ["whisper-cli"], { encoding: "utf8", shell: false, timeout: 5000 });
      const line = String(r.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return { found: true, path: line };
    } else {
      const r = spSync("which", ["whisper-cli"], { encoding: "utf8", shell: false, timeout: 5000 });
      const line = String(r.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return { found: true, path: line };
    }

    return { found: false, path: "" };
  });

  ipcMain.handle("wizard:browseWhisperCli", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const filters = process.platform === "win32"
      ? [{ name: "whisper-cli", extensions: ["exe"] }, { name: "All Files", extensions: ["*"] }]
      : [{ name: "All Files", extensions: ["*"] }];
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: "Select whisper-cli executable",
      filters,
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths?.[0]) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: r.filePaths[0] };
  });

  ipcMain.handle("wizard:checkKobold", async () => {
    const { spawnSync } = await import("node:child_process");
    const koboldName = process.platform === "win32" ? "koboldcpp.exe" : "koboldcpp";

    const udBin = userDataBinDir();
    const udCandidate = path.join(udBin, koboldName);
    if (fs.existsSync(udCandidate)) {
      return { found: true, path: udCandidate };
    }

    if (process.platform === "win32") {
      const r = spawnSync("where.exe", ["koboldcpp"], { encoding: "utf8", shell: false, timeout: 5000 });
      const line = String(r.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return { found: true, path: line };
    } else {
      const r = spawnSync("which", ["koboldcpp"], { encoding: "utf8", shell: false, timeout: 5000 });
      const line = String(r.stdout ?? "").split(/\r?\n/).map(l => l.trim()).find(Boolean);
      if (line && fs.existsSync(line)) return { found: true, path: line };
    }

    return { found: false, path: "" };
  });

  ipcMain.handle("wizard:browseKobold", async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const filters = process.platform === "win32"
      ? [{ name: "KoboldCPP", extensions: ["exe"] }, { name: "All Files", extensions: ["*"] }]
      : [{ name: "All Files", extensions: ["*"] }];
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: "Select KoboldCPP executable",
      filters,
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths?.[0]) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: r.filePaths[0] };
  });

  ipcMain.handle("wizard:complete", async (_e, payload) => {
    const p = payload && typeof payload === "object" ? payload : {};
    const examplePath = path.join(bundleRoot, "core", "config.example.json");
    const template = loadJsonIfExists(examplePath) ?? {};
    let koboldModel = String(p.koboldModel ?? "").trim();
    if (!koboldModel && hasBundledGgufModel()) {
      koboldModel = resolveKoboldModel({});
    }
    const koboldBin = String(p.koboldBin ?? "").trim() || undefined;
    const merged = {
      ...template,
      ...p,
      stdinPtt: false,
      wizardComplete: true,
      koboldGenerateUrl:
        String(p.koboldGenerateUrl ?? "").trim() ||
        template.koboldGenerateUrl ||
        "http://127.0.0.1:5001/api/v1/generate",
      ffmpegDshowAudioDevice: String(p.ffmpegDshowAudioDevice ?? "").trim(),
      koboldModel: koboldModel || undefined,
      koboldBin
    };
    if (!merged.ffmpegDshowAudioDevice) {
      throw new Error("Microphone device is required.");
    }
    if (!merged.koboldModel) {
      throw new Error("KoboldCPP model path is required (no bundled model found).");
    }

    merged.whisperBin = resolveWhisperBin(merged);
    merged.whisperModel = resolveWhisperModel(merged);
    merged.ffmpegBin = resolveFfmpegBin(merged);
    if (!merged.whisperBin || !merged.whisperModel) {
      throw new Error(
        "Whisper binary or model could not be resolved. Packaged apps expect `whisper-cli.exe` and `ggml-medium.bin` under resources (see resources/bin/README.md)."
      );
    }

    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    await bootPipelineFromDisk();
    pipeline?.start();
    sendToRenderer("wizard:done", {});
    return { ok: true };
  });

  ipcMain.handle("pipeline:start", () => {
    pipeline?.start();
    return true;
  });
  ipcMain.handle("pipeline:stop", () => {
    pipeline?.stop();
    return true;
  });
  ipcMain.handle("pipeline:submitText", (_e, text) => {
    pipeline?.submitText(String(text ?? ""));
    return true;
  });

  ipcMain.handle("ptt:start", () => {
    const started = Boolean(pipeline?._started);
    console.log("[main] ipc ptt:start", {
      hasPipeline: Boolean(pipeline),
      pipelineStarted: started
    });
    pttFromUnfocusedShortcut = false;
    pttSpaceChordActive = false;
    pipeline?.setPttState(true);
    return true;
  });
  ipcMain.handle("ptt:end", () => {
    console.log("[main] ipc ptt:end", { hasPipeline: Boolean(pipeline) });
    pipeline?.setPttState(false);
    pttFromUnfocusedShortcut = false;
    pttSpaceChordActive = false;
    return true;
  });

  // --- Per-response controls (v0.6.0 M2) ----------------------------------
  ipcMain.handle("narrative:accept", () => {
    if (!pipeline) return { ok: false };
    return pipeline.acceptPending("explicit");
  });
  ipcMain.handle("narrative:regenerate", () => {
    pipeline?.regenerateLast();
    return true;
  });
  ipcMain.handle("narrative:continue", () => {
    pipeline?.continueLast();
    return true;
  });
  ipcMain.handle("narrative:rewrite", (_e, instruction) => {
    pipeline?.rewriteLast(String(instruction ?? ""));
    return true;
  });
  ipcMain.handle("narrative:getPending", () => {
    if (!pipeline) return { pending: null };
    return pipeline.getPendingState();
  });
  ipcMain.handle("narrative:stopGeneration", () => {
    if (!pipeline) return { ok: false };
    return pipeline.stopGeneration();
  });

  ipcMain.handle("world:get", () => loadWorldState());

  ipcMain.handle("world:resetSections", (_e, sections) => {
    if (pipeline) return pipeline.resetWorldSections(sections);
    // Pipeline not started (e.g. wizard pending): operate on disk directly.
    const state = ws.loadWorldState();
    const cleared = ws.resetWorldSections(state, sections);
    if (cleared.length > 0) {
      ws.backupWorldStateFile("reset");
      ws.saveWorldState(state);
    }
    return { ok: cleared.length > 0, cleared };
  });

  ipcMain.handle("world:setCharField", (_e, k, v) => {
    const key = String(k ?? "").trim();
    if (!key || key === "__proto__" || key === "constructor") {
      throw new Error("Invalid field key");
    }
    return mutateWorld((state) => {
      mergeCharacterCard(state, { [key]: v });
      codex.stampProv(state, "pc", key, "you");
      return state;
    });
  });

  // --- Codex (v0.8.4) ------------------------------------------------------
  // Player-side writes to the record cards. Chronicle entries (beat_/scene_/
  // chap_ ids) route through the memory-edit path so stale-marking stays in
  // one place; everything else goes through core/codex.js.

  ipcMain.handle("codex:editField", (_e, entryId, fieldKey, value) => {
    const id = String(entryId ?? "");
    if (codex.isChronicleEntryId(id)) {
      if (!pipeline) return { ok: false, reason: "pipeline not running" };
      const kind = id.startsWith("beat_")
        ? "beat"
        : id.startsWith("scene_")
          ? "scene"
          : "chapter";
      const field = String(fieldKey ?? "").trim();
      const allowed =
        kind === "beat" ? ["text"] : ["title", "summary"];
      if (!allowed.includes(field)) {
        return { ok: false, reason: `chronicle ${kind} has no field "${field}"` };
      }
      // Stamp before delegating — memoryEdit saves + emits, so the stamp
      // rides along in the same write. Rolled back if the edit is rejected.
      const cx = codex.ensureCodex(pipeline.worldState);
      const prevStamp = cx.prov[id]?.[field];
      codex.stampProv(pipeline.worldState, id, field, "you");
      const res = pipeline.memoryEdit(kind, id, { [field]: String(value ?? "") });
      if (!res?.ok) {
        if (prevStamp) cx.prov[id][field] = prevStamp;
        else if (cx.prov[id]) delete cx.prov[id][field];
      }
      return res;
    }
    return mutateWorld((state) => codex.codexEditField(state, id, fieldKey, value));
  });

  ipcMain.handle("codex:addField", (_e, entryId, label) => {
    return mutateWorld((state) =>
      codex.codexAddField(state, String(entryId ?? ""), label)
    );
  });

  ipcMain.handle("codex:keepEntry", (_e, entryId) => {
    return mutateWorld((state) =>
      codex.codexKeepEntry(state, String(entryId ?? ""))
    );
  });

  ipcMain.handle("codex:moveEntry", (_e, entryId, toGroupId, index) => {
    return mutateWorld((state) =>
      codex.codexMoveEntry(
        state,
        String(entryId ?? ""),
        String(toGroupId ?? ""),
        Number.isInteger(index) ? index : null
      )
    );
  });

  ipcMain.handle("codex:groupCreate", (_e, tab, name) => {
    return mutateWorld((state) =>
      codex.codexGroupCreate(state, String(tab ?? ""), name)
    );
  });

  ipcMain.handle("codex:groupRename", (_e, groupId, name) => {
    return mutateWorld((state) =>
      codex.codexGroupRename(state, String(groupId ?? ""), name)
    );
  });

  ipcMain.handle("codex:groupDelete", (_e, groupId) => {
    return mutateWorld((state) =>
      codex.codexGroupDelete(state, String(groupId ?? ""))
    );
  });

  ipcMain.handle("lore:list", () => {
    const state = loadWorldState();
    return (state.lorebook ?? []).map((e) => ({
      title: e.title,
      keywords: e.keywords ?? []
    }));
  });

  ipcMain.handle("lore:test", async (_e, text) => {
    const query = String(text ?? "").trim();
    const state = loadWorldState();
    const lr = buildLoreRuntimeConfig(liveFileCfg);
    const d = await mergedLorebookMatchesDetailed(
      query,
      state.lorebook ?? [],
      lr
    );
    return serializeLoreDetailed(d);
  });

  ipcMain.handle("lore:undoLast", () => {
    if (!pipeline) return { ok: false };
    return pipeline.loreUndoLast();
  });

  ipcMain.handle("lore:getHistory", () => {
    if (!pipeline) return [];
    return pipeline.loreGetHistory();
  });

  ipcMain.handle("lore:applyCorrection", async (_e, correction) => {
    if (!pipeline) return { ok: false };
    return pipeline.loreApplyCorrection(String(correction ?? "").trim());
  });

  // --- Memory browser (v0.5.0) -------------------------------------------
  ipcMain.handle("memory:endScene", (_e, title) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryEndScene(String(title ?? ""));
  });

  ipcMain.handle("memory:startChapter", (_e, title) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryStartChapter(String(title ?? ""));
  });

  ipcMain.handle("memory:edit", (_e, kind, id, payload) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryEdit(String(kind ?? ""), String(id ?? ""), payload ?? {});
  });

  ipcMain.handle("memory:delete", (_e, kind, id) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryDelete(String(kind ?? ""), String(id ?? ""));
  });

  ipcMain.handle("memory:pin", (_e, kind, id, pinned) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryPin(String(kind ?? ""), String(id ?? ""), Boolean(pinned));
  });

  ipcMain.handle("memory:regenerate", async (_e, target) => {
    if (!pipeline) return { ok: false };
    return pipeline.memoryRegenerate(target ?? {});
  });

  ipcMain.handle("context:lastReport", () => {
    if (!pipeline) return null;
    return pipeline.getLastContextReport();
  });

  ipcMain.handle("ui:getConfig", () => liveFileCfg.ui ?? {});

  // --- Image generation (v0.7.0 D6 — optional, manual, isolated) ----------
  ipcMain.handle("imagegen:status", async () => {
    const { buildImagegenRuntimeConfig, imagegenEnabled } = await import("../core/imagegen.js");
    const cfg = buildImagegenRuntimeConfig(liveFileCfg);
    return { enabled: imagegenEnabled(cfg), endpoint: cfg.endpoint };
  });

  ipcMain.handle("imagegen:generateLocation", async (_e, locationName) => {
    const name = String(locationName ?? "").trim();
    if (!name) return { ok: false, error: "No location name." };
    try {
      const {
        buildImagegenRuntimeConfig,
        imagegenEnabled,
        buildLocationPrompt,
        txt2img,
        saveGeneratedImage
      } = await import("../core/imagegen.js");
      const cfg = buildImagegenRuntimeConfig(liveFileCfg);
      if (!imagegenEnabled(cfg)) {
        return { ok: false, error: "No image generation endpoint configured." };
      }
      const world = ws.loadWorldState();
      const loc = (world.locations ?? []).find(
        (l) => String(l?.name ?? "").trim().toLowerCase() === name.toLowerCase()
      );
      const prompt = buildLocationPrompt(name, loc?.description ?? "");
      const png = await txt2img(prompt, cfg);
      const file = saveGeneratedImage(png, name);

      // Reference it from the gallery map immediately (D6).
      const ui = { ...(liveFileCfg.ui ?? {}) };
      ui.locationBackgrounds = {
        ...(ui.locationBackgrounds ?? {}),
        [name.toLowerCase()]: file
      };
      const merged = { ...liveFileCfg, ui };
      await fs.promises.writeFile(
        CONFIG_PATH,
        JSON.stringify(merged, null, 2) + "\n",
        "utf8"
      );
      liveFileCfg = merged;
      return { ok: true, path: file, prompt };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  });

  // Background images (v0.7.0 D5): gallery paths may live anywhere on disk
  // (user-picked), which the app:// protocol cannot serve. Data URLs work in
  // both dev and packaged modes; backgrounds are few and cached renderer-side.
  ipcMain.handle("ui:getBackgroundUrl", async (_e, p) => {
    const raw = String(p ?? "").trim();
    if (!raw) return { url: "", missing: true };
    const abs = path.isAbsolute(raw)
      ? path.normalize(raw)
      : path.normalize(path.join(appRoot(), safeRelToRoot(raw)));
    try {
      const data = await fs.promises.readFile(abs);
      return {
        url: `data:${mimeForExt(abs)};base64,${data.toString("base64")}`,
        missing: false
      };
    } catch {
      return { url: "", missing: true };
    }
  });

  ipcMain.handle("ui:getAssetPath", (_e, relPath) => {
    const rel = safeRelToRoot(relPath);
    const abs = path.normalize(path.join(appRoot(), rel));
    const root = path.normalize(appRoot());
    if (!isPathInsideAppRoot(abs, root)) {
      return { url: "", path: abs, missing: true };
    }
    const missing = !fs.existsSync(abs);
    if (missing) {
      if (app.isPackaged) {
        console.error("[ui:getAssetPath] missing file", { rel, abs, appPath: root });
      }
      return { url: "", path: abs, missing: true };
    }
    if (isDevRuntime()) {
      return { url: pathToFileURL(abs).href, path: abs, missing: false };
    }
    const relUrl = rel.split(path.sep).join("/");
    return {
      url: `app:///${encodeURI(relUrl)}`,
      path: abs,
      missing: false
    };
  });

  ipcMain.handle("renderer:ready", () => {
    if (!pipeline) {
      console.warn("[main] ipc renderer:ready: pipeline is null (wizard flow?), not calling start()");
      return true;
    }
    console.log("[main] ipc renderer:ready: calling pipeline.start()");
    pipeline.start();
    return true;
  });

  // --- Settings IPC ---

  ipcMain.handle("settings:get", () => {
    return { ...liveFileCfg };
  });

  ipcMain.handle("settings:save", async (_e, cfg) => {
    if (!cfg || typeof cfg !== "object") throw new Error("Invalid config");
    const prevInference = JSON.stringify(liveFileCfg.inference ?? null);
    const merged = { ...liveFileCfg, ...cfg, wizardComplete: true };
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    if (pipeline && (cfg.sttBackend || cfg.sttCustomBin || cfg.sttCustomArgs)) {
      pipeline.reloadSttAdapter(merged);
    }
    if (pipeline) {
      const { resolvePipelineConfig } = await import("../core/pipeline.js");
      pipeline.updateConfig(
        resolvePipelineConfig(
          { ...merged, stdinPtt: false },
          resolveNarrativeSystem(),
          resolveExtractorSystem(),
          loreCorrectionSystemText
        )
      );
    }
    // Backend hot-switch (v0.8.0 D7): spawn KoboldCPP if it just became the
    // backend (no-op when already listening), or health-check the user-run
    // server otherwise. Fire-and-forget — the renderer hears kobold:ready/error.
    if (JSON.stringify(merged.inference ?? null) !== prevInference) {
      startKoboldFromConfig().catch((err) => {
        console.warn("[inference] backend switch check failed:", err?.message ?? err);
      });
    }
    return { ok: true };
  });

  ipcMain.handle("narrative:setLengthPreset", async (_e, presetValue) => {
    const { normalizeLengthPreset } = await import("../core/length_presets.js");
    const lengthPreset = normalizeLengthPreset(presetValue);
    const merged = {
      ...liveFileCfg,
      narrative: { ...(liveFileCfg.narrative ?? {}), lengthPreset }
    };
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    if (pipeline) {
      const { resolvePipelineConfig } = await import("../core/pipeline.js");
      pipeline.updateConfig(
        resolvePipelineConfig(
          { ...merged, stdinPtt: false },
          resolveNarrativeSystem(),
          resolveExtractorSystem(),
          loreCorrectionSystemText
        )
      );
    }
    return { ok: true, lengthPreset };
  });

  ipcMain.handle("narrative:setStyle", async (_e, patch) => {
    const { normalizeStyle } = await import("../core/style_presets.js");
    const p = patch && typeof patch === "object" ? patch : {};
    const current = liveFileCfg.narrative?.style ?? {};
    const style = normalizeStyle({ ...current, ...p });
    const merged = {
      ...liveFileCfg,
      narrative: { ...(liveFileCfg.narrative ?? {}), style }
    };
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    if (pipeline) {
      const { resolvePipelineConfig } = await import("../core/pipeline.js");
      pipeline.updateConfig(
        resolvePipelineConfig(
          { ...merged, stdinPtt: false },
          resolveNarrativeSystem(),
          resolveExtractorSystem(),
          loreCorrectionSystemText
        )
      );
    }
    return { ok: true, style };
  });

  // --- Voice HUD (v0.8.4) ---------------------------------------------------

  /**
   * Patch voice settings without a pipeline reboot: send-on-release
   * (pushToTalk.autoSend) and the input device (ffmpegDshowAudioDevice).
   * Persists to config.json and hot-applies via updateConfig — the pipeline
   * reads this.cfg.voiceAutoSend live.
   */
  ipcMain.handle("voice:setConfig", async (_e, patch) => {
    if (!patch || typeof patch !== "object") throw new Error("Invalid voice config");
    const merged = { ...liveFileCfg };
    if (typeof patch.autoSend === "boolean") {
      merged.pushToTalk = { ...(merged.pushToTalk ?? {}), autoSend: patch.autoSend };
    }
    if (typeof patch.device === "string") {
      merged.ffmpegDshowAudioDevice = patch.device;
    }
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    if (pipeline) {
      const { resolvePipelineConfig } = await import("../core/pipeline.js");
      pipeline.updateConfig(
        resolvePipelineConfig(
          { ...merged, stdinPtt: false },
          resolveNarrativeSystem(),
          resolveExtractorSystem(),
          loreCorrectionSystemText
        )
      );
    }
    return { ok: true };
  });

  ipcMain.handle("voice:getConfig", () => ({
    autoSend: liveFileCfg.pushToTalk?.autoSend === true,
    device: String(liveFileCfg.ffmpegDshowAudioDevice ?? ""),
    pttKey: currentPttCode,
    pttLabel: currentPttKey().label
  }));

  /** Rebind the push-to-talk key (whitelisted KeyboardEvent.code). */
  ipcMain.handle("ptt:setKey", async (_e, code) => {
    const key = PTT_KEYS[String(code ?? "")];
    if (!key) return { ok: false, reason: "key not supported" };
    currentPttCode = String(code);
    const merged = {
      ...liveFileCfg,
      pushToTalk: {
        ...(liveFileCfg.pushToTalk ?? {}),
        key: currentPttCode,
        electronAccelerator: key.accelerator
      }
    };
    await fs.promises.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.promises.writeFile(
      CONFIG_PATH,
      JSON.stringify(merged, null, 2) + "\n",
      "utf8"
    );
    liveFileCfg = merged;
    // Re-register the unfocused-window shortcut against the new key.
    globalShortcut.unregisterAll();
    if (mainWindow && !mainWindow.isFocused()) {
      updateGlobalPttShortcut(key.accelerator);
    }
    return { ok: true, pttKey: currentPttCode, pttLabel: key.label };
  });

  ipcMain.handle("settings:getMicList", async () => {
    const { listDshowAudioDevices } = await import("../core/pipeline.js");
    const ffmpegBin = resolveFfmpegBin(liveFileCfg || {});
    const devices = listDshowAudioDevices({ ffmpegBin });
    return { devices };
  });

  ipcMain.handle("settings:testMic", async (_e, deviceName) => {
    const device = String(deviceName ?? "").trim();
    if (!device) return { ok: false, error: "No microphone selected." };
    const ffmpegBin = resolveFfmpegBin(liveFileCfg || {});
    const tmp = path.join(app.getPath("userData"), `settings-mic-test-${Date.now()}.wav`);

    let inputArgs;
    if (process.platform === "darwin") {
      const inputSpec = device.startsWith(":") ? device : `:${device}`;
      inputArgs = ["-f", "avfoundation", "-i", inputSpec];
    } else if (process.platform === "linux") {
      inputArgs = ["-f", "alsa", "-i", device];
    } else {
      inputArgs = ["-f", "dshow", "-i", `audio=${device}`];
    }

    await new Promise((resolve, reject) => {
      const child = spawn(
        ffmpegBin,
        ["-hide_banner", "-loglevel", "error", "-y", ...inputArgs, "-t", "2", "-ac", "1", "-ar", "16000", tmp],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let err = "";
      child.stderr?.on("data", (d) => { err += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0 && code !== 255) {
          reject(new Error((err || `ffmpeg exited ${code}`).trim()));
          return;
        }
        resolve();
      });
    });
    const buf = await fs.promises.readFile(tmp);
    await fs.promises.unlink(tmp).catch(() => {});
    return { ok: true, audioBase64: buf.toString("base64") };
  });

  ipcMain.handle("settings:resetPrompt", async (_e, type) => {
    const kind = String(type ?? "").trim();
    const filenames = {
      narrative: "narrative_system.txt",
      extractor: "extractor_system.txt",
      loreCorrection: "lore_correction.txt"
    };
    const filename = filenames[kind];
    if (!filename) {
      throw new Error("type must be 'narrative', 'extractor', or 'loreCorrection'");
    }
    const bundledPath = path.join(bundleRoot, "prompts", filename);
    const text = loadTextIfExists(bundledPath) ?? "";
    return { text };
  });

  ipcMain.handle("settings:browseFile", async (_e, opts) => {
    const o = opts && typeof opts === "object" ? opts : {};
    const filters = [];
    const exts = Array.isArray(o.extensions) ? o.extensions.filter(Boolean) : [];
    if (exts.length > 0) {
      filters.push({ name: "Files", extensions: exts });
    }
    filters.push({ name: "All Files", extensions: ["*"] });

    const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
    const r = await dialog.showOpenDialog(win ?? undefined, {
      title: o.title ?? "Select file",
      filters,
      properties: ["openFile"]
    });
    if (r.canceled || !r.filePaths?.[0]) {
      return { canceled: true, path: "" };
    }
    return { canceled: false, path: r.filePaths[0] };
  });

  ipcMain.handle("settings:validateSttBinary", async (_e, binPath) => {
    const { validateCustomBinary } = await import("../core/stt/index.js");
    return validateCustomBinary(String(binPath ?? ""));
  });

  ipcMain.handle("settings:relaunch", () => {
    app.relaunch();
    app.quit();
  });
}

async function main() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        secure: true,
        standard: true,
        supportFetchAPI: true,
        corsEnabled: true
      }
    }
  ]);

  await app.whenReady();
  await registerAppProtocol();

  bundleRoot = appRoot();
  const userDataCore = path.join(app.getPath("userData"), "core");
  if (app.isPackaged) {
    await preparePackagedWritableCore(bundleRoot, userDataCore);
  }

  const userDataConfig = path.join(userDataCore, "config.json");
  if (app.isPackaged) {
    CONFIG_PATH = userDataConfig;
    liveFileCfg =
      loadJsonIfExists(userDataConfig) ??
      loadJsonIfExists(path.join(bundleRoot, "core", "config.json")) ??
      {};
  } else {
    CONFIG_PATH = path.join(bundleRoot, "core", "config.json");
    liveFileCfg = loadJsonIfExists(CONFIG_PATH) ?? {};
  }

  const NARRATIVE_SYSTEM_PATH = path.join(
    bundleRoot,
    "prompts",
    "narrative_system.txt"
  );
  const EXTRACTOR_SYSTEM_PATH = path.join(
    bundleRoot,
    "prompts",
    "extractor_system.txt"
  );
  const LORE_CORRECTION_PATH = path.join(
    bundleRoot,
    "prompts",
    "lore_correction.txt"
  );

  const [{ createPipeline, resolvePipelineConfig }, ws, codexModule] =
    await Promise.all([
      import("../core/pipeline.js"),
      import("../core/world_state.js"),
      import("../core/codex.js")
    ]);

  narrativeSystemText =
    loadTextIfExists(NARRATIVE_SYSTEM_PATH)?.trim() ||
    "You are an in-world narrative roleplay assistant. Stay in character and respond naturally.";
  extractorSystemText =
    loadTextIfExists(EXTRACTOR_SYSTEM_PATH)?.trim() ||
    `You extract world state as JSON only. Keys: player_character, npcs, quests, locations, session_beat. player_character is ONLY the player's own sheet; everyone else goes in npcs.`;
  loreCorrectionSystemText = loadTextIfExists(LORE_CORRECTION_PATH)?.trim() || "";

  const wizardRequired = needsWizard(liveFileCfg);

  async function bootPipelineFromDisk() {
    if (pipeline) {
      pipeline.removeAllListeners();
      pipeline.stop();
      pipeline = null;
    }
    const mergedFile = { ...liveFileCfg, stdinPtt: false };
    const resolved = resolvePipelineConfig(
      mergedFile,
      resolveNarrativeSystem(),
      resolveExtractorSystem(),
      loreCorrectionSystemText
    );
    pipeline = createPipeline(resolved);
    wirePipelineToWindow();
    await startKoboldFromConfig();
  }

  registerIpcHandlers(ws, codexModule, { bootPipelineFromDisk });

  if (!wizardRequired) {
    await bootPipelineFromDisk();
  }

  initPttKeyFromConfig(liveFileCfg);

  if (liveFileCfg.debug === true) {
    hookMainProcessConsoleToFile("config.json debug");
  }

  const windowResolved = { stdinPtt: false };
  createMainWindow(windowResolved, liveFileCfg);

  /** @type {ReturnType<typeof setInterval> | null} */
  let pttKeyReleasePoll = null;
  if (process.platform === "win32") {
    try {
      const koffi = (await import("koffi")).default;
      const user32 = koffi.load("user32.dll");
      const GetAsyncKeyState = user32.func(
        "int16 __stdcall GetAsyncKeyState(int vkey)"
      );
      pttKeyReleasePoll = setInterval(() => {
        if (!pipeline?.recording) return;
        if (!pttFromUnfocusedShortcut && !pttSpaceChordActive) return;
        const down =
          (GetAsyncKeyState(currentPttKey().vk) & 0x8000) !== 0;
        if (!down) {
          pipeline.setPttState(false);
          pttFromUnfocusedShortcut = false;
          pttSpaceChordActive = false;
        }
      }, 50);
    } catch {
      // without koffi, release after global shortcut start requires mic button
    }
  }

  let quitting = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let quitTimeout = null;

  app.on("before-quit", (e) => {
    if (quitting) return;
    e.preventDefault();
    globalShortcut.unregisterAll();
    let finished = false;
    const finishQuit = () => {
      if (finished || quitting) return;
      finished = true;
      if (quitTimeout) {
        clearTimeout(quitTimeout);
        quitTimeout = null;
      }
      if (pttKeyReleasePoll) clearInterval(pttKeyReleasePoll);
      globalShortcut.unregisterAll();
      quitting = true;
      app.quit();
    };
    quitTimeout = setTimeout(finishQuit, 8000);
    stopKoboldIfStartedByUs();
    if (pipeline) {
      let sawStop = false;
      pipeline.once("stop", () => {
        sawStop = true;
        if (quitTimeout) {
          clearTimeout(quitTimeout);
          quitTimeout = null;
        }
        finishQuit();
      });
      pipeline.stop();
      setImmediate(() => {
        if (!sawStop) finishQuit();
      });
    } else {
      finishQuit();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("will-quit", () => {
    if (pttKeyReleasePoll) clearInterval(pttKeyReleasePoll);
    globalShortcut.unregisterAll();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
