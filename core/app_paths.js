import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — parent directory of `core/` (development: project root; asar load: resolves into the bundle mount). */
export function getPackageRoot() {
  return path.resolve(__dirname, "..");
}

/**
 * Writable `core/` equivalent: worlds/, recordings/, events.jsonl, worlds.json.
 * Electron main sets LOCAL_AI_WRITABLE_CORE (under app.getPath("userData")) before importing the pipeline package.
 */
export function getWritableCoreDir() {
  const e = process.env.LOCAL_AI_WRITABLE_CORE;
  if (e != null && String(e).trim() !== "") {
    return path.resolve(String(e).trim());
  }
  return path.join(getPackageRoot(), "core");
}

/** Registry of worlds: `{ activeWorldId, worlds: [{id, name, createdAt, lastPlayedAt, templateId}] }`. */
export function getWorldsRegistryPath() {
  return path.join(getWritableCoreDir(), "worlds.json");
}

/** Parent of all per-world directories (`worlds/<worldId>/`). */
export function getWorldsRootDir() {
  return path.join(getWritableCoreDir(), "worlds");
}

/** Explicit active-world override (Electron main / worlds.js boot). Null = resolve lazily. */
let explicitWorldDir = null;
/** Lazy resolution cache, keyed by the core dir (tests swap LOCAL_AI_WRITABLE_CORE mid-process). */
let resolvedWorld = { coreDir: null, worldDir: null };

/**
 * Pin the active world directory (absolute path), or pass null to fall back
 * to lazy resolution from the registry. Electron main calls this at boot and
 * on world switch — never while a pipeline is running against the old world.
 * @param {string | null} dir
 */
export function setActiveWorld(dir) {
  explicitWorldDir = dir == null ? null : path.resolve(String(dir));
  resolvedWorld = { coreDir: null, worldDir: null };
}

/**
 * Directory holding the active world's files (world_state.json, session.json,
 * memory_vectors.json, world.json). Resolution order:
 *   1. explicit `setActiveWorld()` value;
 *   2. `worlds.json` registry's activeWorldId (CLI entries land here);
 *   3. legacy flat layout — the writable core dir itself (pre-0.9.0 saves,
 *      and the temp dirs the model-free suites create).
 * Repairing a registry whose activeWorldId points nowhere is worlds.js's job
 * (`ensureWorldsLayout`); this seam stays dumb and falls back to legacy.
 */
export function getActiveWorldDir() {
  if (explicitWorldDir) return explicitWorldDir;
  const coreDir = getWritableCoreDir();
  if (resolvedWorld.coreDir === coreDir) return resolvedWorld.worldDir;
  let worldDir = coreDir;
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(coreDir, "worlds.json"), "utf8"));
    const id = typeof reg?.activeWorldId === "string" ? reg.activeWorldId.trim() : "";
    if (id) {
      const candidate = path.join(coreDir, "worlds", id);
      if (fs.existsSync(candidate)) worldDir = candidate;
    }
  } catch {
    // no registry (or unreadable) — legacy flat layout
  }
  resolvedWorld = { coreDir, worldDir };
  return worldDir;
}

export function getSessionPath() {
  return path.join(getActiveWorldDir(), "session.json");
}

export function getWorldStatePath() {
  return path.join(getActiveWorldDir(), "world_state.json");
}

/** App-level, shared across worlds (diagnostics; revisit if a world ever needs its own recordings). */
export function getRecordingsDir() {
  return path.join(getWritableCoreDir(), "recordings");
}

/** App-level, shared across worlds. */
export function getEventsPath() {
  return path.join(getWritableCoreDir(), "events.jsonl");
}

/**
 * Beat/scene embedding cache (memory architecture, v0.5.0). Regenerable —
 * lives beside world_state.json but is never backed up or migrated with it.
 */
export function getMemoryVectorsPath() {
  return path.join(getActiveWorldDir(), "memory_vectors.json");
}
