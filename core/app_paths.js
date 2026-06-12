import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — parent directory of `core/` (development: project root; asar load: resolves into the bundle mount). */
export function getPackageRoot() {
  return path.resolve(__dirname, "..");
}

/**
 * Writable `core/` equivalent: session.json, world_state.json, recordings/, events.jsonl.
 * Electron main sets LOCAL_AI_WRITABLE_CORE (under app.getPath("userData")) before importing the pipeline package.
 */
export function getWritableCoreDir() {
  const e = process.env.LOCAL_AI_WRITABLE_CORE;
  if (e != null && String(e).trim() !== "") {
    return path.resolve(String(e).trim());
  }
  return path.join(getPackageRoot(), "core");
}

export function getSessionPath() {
  return path.join(getWritableCoreDir(), "session.json");
}

export function getWorldStatePath() {
  return path.join(getWritableCoreDir(), "world_state.json");
}

export function getRecordingsDir() {
  return path.join(getWritableCoreDir(), "recordings");
}

export function getEventsPath() {
  return path.join(getWritableCoreDir(), "events.jsonl");
}

/**
 * Beat/scene embedding cache (memory architecture, v0.5.0). Regenerable —
 * lives beside world_state.json but is never backed up or migrated with it.
 */
export function getMemoryVectorsPath() {
  return path.join(getWritableCoreDir(), "memory_vectors.json");
}
