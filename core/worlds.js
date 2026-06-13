// Multi-world store (v0.9.0 plan D1/D3). One directory per world under
// `<writableCoreDir>/worlds/<worldId>/` (world_state.json, session.json,
// memory_vectors.json, world.json meta), one registry at
// `<writableCoreDir>/worlds.json`. Shared, not per-world: config.json,
// recordings/, events.jsonl, generated/.
//
// `ensureWorldsLayout()` is the app-boot entry point: it migrates a legacy
// flat save into the worlds layout (copy-verify-then-delete — a crash
// mid-migration leaves the legacy files intact), repairs a broken registry,
// and guarantees a valid active world before the pipeline touches disk.
// CLI tools never call it; they resolve lazily via app_paths and keep
// working against either layout.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getWritableCoreDir,
  getWorldsRegistryPath,
  getWorldsRootDir,
  setActiveWorld
} from "./app_paths.js";
import { backupWorldStateFile, defaultWorldState } from "./world_state.js";

/** World-scoped files moved by the legacy migration (world.json is layout-new). */
const WORLD_FILES = ["world_state.json", "session.json", "memory_vectors.json"];

let _nextWorldId = Date.now();

/** @param {string} [prefix] */
export function genWorldId() {
  return `world_${(_nextWorldId++).toString(36)}`;
}

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + os.EOL, "utf8");
}

/** Registry summary row — duplicated from world.json so listing never opens world dirs. */
function registrySummary(meta) {
  return {
    id: meta.id,
    name: meta.name,
    createdAt: meta.createdAt,
    lastPlayedAt: meta.lastPlayedAt,
    templateId: meta.templateId
  };
}

/** @returns {{ activeWorldId: string | null, worlds: object[] } | null} null = no registry (legacy layout or fresh install) */
export function loadWorldsRegistry() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getWorldsRegistryPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const worlds = Array.isArray(parsed.worlds)
      ? parsed.worlds.filter((w) => w && typeof w === "object" && typeof w.id === "string")
      : [];
    return {
      activeWorldId:
        typeof parsed.activeWorldId === "string" && parsed.activeWorldId.trim()
          ? parsed.activeWorldId
          : null,
      worlds
    };
  } catch {
    return null;
  }
}

export function saveWorldsRegistry(reg) {
  writeJson(getWorldsRegistryPath(), reg);
}

/** @param {string} id */
export function getWorldDir(id) {
  return path.join(getWorldsRootDir(), id);
}

/** @param {string} id @returns {object | null} world.json meta, or null */
export function loadWorldMeta(id) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(getWorldDir(id), "world.json"), "utf8")
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** @returns {object | null} the active world's world.json meta (null in legacy/flat layouts) */
export function getActiveWorldMeta() {
  const reg = loadWorldsRegistry();
  return reg?.activeWorldId ? loadWorldMeta(reg.activeWorldId) : null;
}

/** Persist world.json and mirror the summary fields into the registry row. */
export function saveWorldMeta(meta) {
  writeJson(path.join(getWorldDir(meta.id), "world.json"), meta);
  const reg = loadWorldsRegistry();
  if (!reg) return;
  const i = reg.worlds.findIndex((w) => w.id === meta.id);
  if (i >= 0) reg.worlds[i] = { ...reg.worlds[i], ...registrySummary(meta) };
  else reg.worlds.push(registrySummary(meta));
  saveWorldsRegistry(reg);
}

/**
 * Create a new world directory with a fresh default world state and register
 * it. Does NOT activate it — callers decide (boot does, the picker UI does
 * after a clean pipeline stop).
 * @param {{ name?: string, templateId?: string | null }} [opts]
 * @returns {object} world.json meta
 */
export function createWorld({ name, templateId = null } = {}) {
  const id = genWorldId();
  const dir = getWorldDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    name: String(name ?? "").trim() || "My World",
    createdAt: new Date().toISOString(),
    lastPlayedAt: null,
    templateId
  };
  writeJson(path.join(dir, "world_state.json"), defaultWorldState());
  writeJson(path.join(dir, "world.json"), meta);
  const reg = loadWorldsRegistry() ?? { activeWorldId: null, worlds: [] };
  reg.worlds.push(registrySummary(meta));
  saveWorldsRegistry(reg);
  return meta;
}

/**
 * Rename a world (world.json + registry row).
 * @param {string} id @param {string} name
 * @returns {object} updated meta
 */
export function renameWorld(id, name) {
  const clean = String(name ?? "").trim();
  if (!clean) throw new Error("[worlds] rename requires a non-empty name");
  const meta = loadWorldMeta(id);
  if (!meta) throw new Error(`[worlds] cannot rename unknown world: ${id}`);
  meta.name = clean;
  saveWorldMeta(meta);
  return meta;
}

/**
 * Soft-delete: move the world dir to `worlds/.trash/<id>-<ts>/` and drop the
 * registry row. No hard delete in 0.9.0 — recovery is moving the dir back
 * and re-adding the row. The active world cannot be deleted (switch first);
 * that keeps the seam pointed at a real directory at all times.
 * @param {string} id
 * @returns {{ trashedTo: string }}
 */
/**
 * Hard-delete all worlds and the registry (Settings → Restart Setup Wizard).
 * Does not touch shared core files (config.json, recordings/, etc.).
 * Caller must stop the pipeline first; the next boot runs ensureWorldsLayout().
 */
export function clearAllWorlds() {
  const coreDir = getWritableCoreDir();
  const worldsRoot = getWorldsRootDir();
  const registryPath = getWorldsRegistryPath();
  if (fs.existsSync(worldsRoot)) {
    fs.rmSync(worldsRoot, { recursive: true, force: true });
  }
  if (fs.existsSync(registryPath)) {
    fs.rmSync(registryPath, { force: true });
  }
  for (const f of [...WORLD_FILES, "world.json"]) {
    const p = path.join(coreDir, f);
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  setActiveWorld(null);
}

export function deleteWorldToTrash(id) {
  const reg = loadWorldsRegistry();
  if (!reg) throw new Error("[worlds] no registry — nothing to delete");
  if (reg.activeWorldId === id) {
    throw new Error("[worlds] cannot delete the active world — switch to another world first");
  }
  if (!reg.worlds.some((w) => w.id === id)) {
    throw new Error(`[worlds] cannot delete unknown world: ${id}`);
  }
  const dir = getWorldDir(id);
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const trashedTo = path.join(getWorldsRootDir(), ".trash", `${id}-${ts}`);
  if (fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(trashedTo), { recursive: true });
    fs.renameSync(dir, trashedTo);
  }
  reg.worlds = reg.worlds.filter((w) => w.id !== id);
  saveWorldsRegistry(reg);
  return { trashedTo };
}

/**
 * Mark a world active: registry pointer, lastPlayedAt stamp, and the
 * app_paths seam. Caller is responsible for pipeline stop/reload around it.
 * @param {string} id
 */
export function activateWorld(id) {
  const reg = loadWorldsRegistry();
  if (!reg || !fs.existsSync(getWorldDir(id))) {
    throw new Error(`[worlds] cannot activate unknown world: ${id}`);
  }
  reg.activeWorldId = id;
  const now = new Date().toISOString();
  const row = reg.worlds.find((w) => w.id === id);
  if (row) row.lastPlayedAt = now;
  saveWorldsRegistry(reg);
  const meta = loadWorldMeta(id);
  if (meta) {
    meta.lastPlayedAt = now;
    writeJson(path.join(getWorldDir(id), "world.json"), meta);
  }
  setActiveWorld(getWorldDir(id));
}

/**
 * App-boot entry point (Electron main, before the pipeline touches disk).
 * Guarantees: a registry exists, its activeWorldId points at a real world
 * dir, and app_paths is pinned to it. Three paths in:
 *   - registry already present → repair active pointer if broken, pin, done;
 *   - no registry + legacy flat save → migrate it (backup, copy, verify,
 *     register — the commit point — then delete the originals);
 *   - no registry + nothing → fresh install, create a blank "My World".
 * @returns {{ migrated: boolean, created?: boolean, activeWorldId: string, movedFiles?: string[], backupPath?: string | null }}
 */
export function ensureWorldsLayout() {
  const coreDir = getWritableCoreDir();
  fs.mkdirSync(coreDir, { recursive: true });
  const reg = loadWorldsRegistry();
  if (reg) {
    let id = reg.activeWorldId;
    if (!id || !fs.existsSync(getWorldDir(id))) {
      const firstExisting = reg.worlds.find((w) => fs.existsSync(getWorldDir(w.id)));
      id = firstExisting ? firstExisting.id : createWorld({ name: "My World" }).id;
      const fresh = loadWorldsRegistry();
      fresh.activeWorldId = id;
      saveWorldsRegistry(fresh);
    }
    setActiveWorld(getWorldDir(id));
    if (fs.existsSync(path.join(coreDir, "world_state.json"))) {
      // Post-migration leftovers (crash between registry write and legacy
      // delete) or downgrade artifacts. Never delete — just don't read them.
      console.warn(
        "[worlds] legacy world_state.json present beside worlds.json — ignored (worlds layout wins)"
      );
    }
    return { migrated: false, activeWorldId: id };
  }

  // No registry: the registry write is the migration's commit point, so any
  // existing worlds/ content is a failed earlier attempt (legacy originals
  // are still intact). Clear it and start over.
  const worldsRoot = getWorldsRootDir();
  if (fs.existsSync(worldsRoot)) {
    fs.rmSync(worldsRoot, { recursive: true, force: true });
  }

  const legacyState = path.join(coreDir, "world_state.json");
  if (!fs.existsSync(legacyState)) {
    const meta = createWorld({ name: "My World" });
    const fresh = loadWorldsRegistry();
    fresh.activeWorldId = meta.id;
    saveWorldsRegistry(fresh);
    setActiveWorld(getWorldDir(meta.id));
    return { migrated: false, created: true, activeWorldId: meta.id };
  }

  // Legacy flat save → worlds/<id>/. backupWorldStateFile resolves through
  // app_paths, which (no registry, no explicit world) still points at the
  // legacy flat layout here.
  const backupPath = backupWorldStateFile("pre-worlds");
  let name = "My World";
  try {
    const ws = JSON.parse(fs.readFileSync(legacyState, "utf8"));
    const n = String(ws?.character?.name ?? "").trim();
    if (n) name = n;
  } catch {
    // unreadable name is not fatal; the file is moved verbatim regardless
  }
  const id = genWorldId();
  const dir = getWorldDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const movedFiles = [];
  for (const f of WORLD_FILES) {
    const src = path.join(coreDir, f);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(dir, f);
    fs.copyFileSync(src, dest);
    if (!fs.readFileSync(src).equals(fs.readFileSync(dest))) {
      throw new Error(`[worlds] migration copy verification failed for ${f}`);
    }
    movedFiles.push(f);
  }
  const meta = {
    id,
    name,
    createdAt: new Date().toISOString(),
    lastPlayedAt: null,
    templateId: null
  };
  writeJson(path.join(dir, "world.json"), meta);
  saveWorldsRegistry({ activeWorldId: id, worlds: [registrySummary(meta)] }); // commit point
  for (const f of movedFiles) {
    fs.rmSync(path.join(coreDir, f), { force: true });
  }
  setActiveWorld(dir);
  return { migrated: true, activeWorldId: id, movedFiles, backupPath };
}
