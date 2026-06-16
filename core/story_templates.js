// Story-template loader (v0.9.0 plan D5; FEATURE_CREEP §1). Named to avoid
// `core/templates.js`, the prompt-format module. A template is one folder
// with a `template.json` (contract: templates/manifest.schema.json — that
// schema stays the authoring source of truth; validateManifest() mirrors its
// constraints by hand, no ajv) plus the files the manifest references.
//
// Applies at world creation only — never retro-applied to an existing world.
// Everything a template contributes becomes world-scoped by construction:
// the seed merges into the new world's world_state.json, the narrator
// override and onboarding block land in its world.json, and the GM bestiary
// is copied into the world dir. Global config.json is never touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPackageRoot, getWritableCoreDir } from "./app_paths.js";
import { genEntryId } from "./codex.js";
import { defaultWorldState, makeSessionBeat } from "./world_state.js";
import { validateCreationSpec } from "./character/validate.js";

/** World-local copy of the template's GM-only bestiary (narrator reference, never player-facing). */
export const GM_BESTIARY_FILENAME = "gm_bestiary.json";

function writeJson(p, value) {
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + os.EOL, "utf8");
}

/**
 * Structural validation against the documented contract
 * (templates/manifest.schema.json). Returns every problem found, not just
 * the first — template authors get one round trip.
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateManifest(json) {
  const errors = [];
  const m = /** @type {Record<string, any>} */ (json);
  if (!m || typeof m !== "object" || Array.isArray(m)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }

  if (m.schemaVersion !== 1) errors.push("schemaVersion must be the integer 1");
  if (typeof m.id !== "string" || !/^[a-z0-9-]+$/.test(m.id)) {
    errors.push("id must be a kebab-case string ([a-z0-9-]+)");
  }
  if (typeof m.name !== "string" || !m.name.trim()) {
    errors.push("name must be a non-empty string");
  }

  const n = m.narrator;
  if (!n || typeof n !== "object" || Array.isArray(n)) {
    errors.push("narrator must be an object");
  } else {
    if (typeof n.systemPromptFile !== "string" || !n.systemPromptFile.trim()) {
      errors.push("narrator.systemPromptFile must be a non-empty string");
    }
    if (n.promptMode != null && !["override", "append"].includes(n.promptMode)) {
      errors.push('narrator.promptMode must be "override" or "append"');
    }
    if (n.config != null && (typeof n.config !== "object" || Array.isArray(n.config))) {
      errors.push("narrator.config must be an object");
    }
  }

  if (m.gm != null) {
    if (typeof m.gm !== "object" || Array.isArray(m.gm)) {
      errors.push("gm must be an object");
    } else {
      if (m.gm.bestiaryFile != null && typeof m.gm.bestiaryFile !== "string") {
        errors.push("gm.bestiaryFile must be a string");
      }
      if (m.gm.rulesFile != null && typeof m.gm.rulesFile !== "string") {
        errors.push("gm.rulesFile must be a string");
      }
    }
  }

  const seed = m.seed;
  if (!seed || typeof seed !== "object" || Array.isArray(seed)) {
    errors.push("seed must be an object");
  } else {
    if (seed.character != null && (typeof seed.character !== "object" || Array.isArray(seed.character))) {
      errors.push("seed.character must be an object");
    }
    if (seed.current_location != null && typeof seed.current_location !== "string") {
      errors.push("seed.current_location must be a string");
    }
    const arrayOf = (key, check, what) => {
      const v = seed[key];
      if (v == null) return;
      if (!Array.isArray(v)) {
        errors.push(`seed.${key} must be an array`);
        return;
      }
      v.forEach((item, i) => {
        const problem = check(item);
        if (problem) errors.push(`seed.${key}[${i}]: ${what} (${problem})`);
      });
    };
    const str = (o, k) => typeof o?.[k] === "string" && o[k].trim() !== "";
    arrayOf("npcs", (x) => (str(x, "name") ? null : "missing name"), "npc needs a name");
    arrayOf("quests", (x) => (str(x, "title") ? null : "missing title"), "quest needs a title");
    arrayOf("locations", (x) => (str(x, "name") ? null : "missing name"), "location needs a name");
    arrayOf(
      "lorebook",
      (x) => (str(x, "title") && str(x, "content") ? null : "missing title/content"),
      "lore entry needs title + content"
    );
    arrayOf(
      "session_beats",
      (x) => (typeof x === "string" && x.trim() ? null : "must be a plain string"),
      "beats are plain strings (the loader wraps them)"
    );
    arrayOf("bestiary", (x) => (str(x, "name") ? null : "missing name"), "bestiary entry needs a name");
  }

  if (m.onboarding != null) {
    if (typeof m.onboarding !== "object" || Array.isArray(m.onboarding)) {
      errors.push("onboarding must be an object");
    } else {
      if (
        m.onboarding.characterCreationFile != null &&
        typeof m.onboarding.characterCreationFile !== "string"
      ) {
        errors.push("onboarding.characterCreationFile must be a string");
      }
      if (m.onboarding.mode != null && !["app-forge", "narrator-forge"].includes(m.onboarding.mode)) {
        errors.push('onboarding.mode must be "app-forge" or "narrator-forge"');
      }
      if (m.onboarding.openingHint != null && typeof m.onboarding.openingHint !== "string") {
        errors.push("onboarding.openingHint must be a string");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve a manifest-referenced file, refusing paths that escape the
 * template folder (templates are third-party-authorable data).
 * @returns {string} absolute path
 */
export function resolveTemplateFile(templateDir, relPath) {
  const abs = path.resolve(templateDir, String(relPath ?? ""));
  const root = path.resolve(templateDir) + path.sep;
  if (!abs.startsWith(root)) {
    throw new Error(`[story_templates] file reference escapes the template folder: ${relPath}`);
  }
  if (!fs.existsSync(abs)) {
    throw new Error(`[story_templates] referenced file missing: ${relPath}`);
  }
  return abs;
}

/**
 * Load + validate a template's optional character-creation spec (design doc
 * 01). Non-fatal: any problem (no reference, escape, missing file, bad JSON,
 * failed validation) returns null with a warning. The renderer-facing loader
 * lives in core/character/spec.js; this is discovery's warn-and-degrade path.
 * @returns {object | null}
 */
function loadCreationSpecFromDir(dir, manifest, label) {
  const rel = manifest?.onboarding?.characterCreationFile;
  if (typeof rel !== "string" || !rel.trim()) return null;
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(resolveTemplateFile(dir, rel), "utf8"));
  } catch (err) {
    console.warn(`[story_templates] ${label}: character creation spec not loadable — ignored (${err.message})`);
    return null;
  }
  const v = validateCreationSpec(spec);
  if (!v.ok) {
    console.warn(`[story_templates] ${label}: character_creation.json failed validation — ignored:\n  - ${v.errors.join("\n  - ")}`);
    return null;
  }
  return spec;
}

/**
 * Scan for installed templates: bundled `templates/` (off the package root)
 * plus `<writableCoreDir>/templates/` for user-installed ones (user wins on
 * id collision). Invalid manifests are skipped with a warning, never fatal.
 * @returns {{ id: string, name: string, tagline: string, genre: string, summary: string, dir: string, manifest: object }[]}
 */
export function discoverTemplates() {
  const roots = [
    path.join(getPackageRoot(), "templates"),
    path.join(getWritableCoreDir(), "templates")
  ];
  const byId = new Map();
  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root missing — fine
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(root, e.name);
      const manifestPath = path.join(dir, "template.json");
      if (!fs.existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      } catch (err) {
        console.warn(`[story_templates] ${e.name}/template.json is not valid JSON — skipped (${err.message})`);
        continue;
      }
      const v = validateManifest(manifest);
      if (!v.ok) {
        console.warn(`[story_templates] ${e.name} failed validation — skipped:\n  - ${v.errors.join("\n  - ")}`);
        continue;
      }
      // Character-creation spec (design doc 01): optional. A broken spec drops
      // to null with a warning — the template still loads and the narrator
      // forge remains the fallback, so a bad spec never costs the whole world.
      const creationSpec = loadCreationSpecFromDir(dir, manifest, e.name);
      byId.set(manifest.id, {
        id: manifest.id,
        name: manifest.name,
        tagline: String(manifest.tagline ?? ""),
        genre: String(manifest.genre ?? ""),
        summary: String(manifest.summary ?? ""),
        dir,
        manifest,
        creationSpec
      });
    }
  }
  return [...byId.values()];
}

/**
 * Apply a discovered template to a freshly created world directory:
 *   1. merge `seed.*` into a fresh defaultWorldState() (beats wrapped via
 *      makeSessionBeat, entry ids stamped the way the schema migrations do)
 *      and write the world's world_state.json;
 *   2. copy `gm.bestiaryFile` into the world dir as gm_bestiary.json —
 *      narrator reference only, never part of world state;
 *   3. return the world.json patch (narrator override resolved from
 *      systemPromptFile per promptMode, narrator.config, onboarding block)
 *      for the caller to merge via worlds.saveWorldMeta().
 * Global config.json is never touched.
 * @param {string} worldDir - existing world directory (from worlds.createWorld)
 * @param {{ dir: string, manifest: object }} template - discoverTemplates() row
 * @returns {{ narrator: object, onboarding: object | null }}
 */
export function applyTemplate(worldDir, template) {
  const { dir, manifest } = template;
  const v = validateManifest(manifest);
  if (!v.ok) {
    throw new Error(`[story_templates] invalid manifest:\n  - ${v.errors.join("\n  - ")}`);
  }
  const seed = manifest.seed ?? {};
  const ws = defaultWorldState();

  if (seed.character && typeof seed.character === "object") {
    ws.character = { ...seed.character };
  }
  for (const npc of seed.npcs ?? []) {
    ws.npcs.push({
      id: genEntryId("npc"),
      name: String(npc.name).trim(),
      status: String(npc.status ?? "").trim(),
      notes: String(npc.notes ?? "").trim()
    });
  }
  for (const q of seed.quests ?? []) {
    const { id: _drop, ...rest } = q;
    ws.quests.push({ id: genEntryId("quest"), status: "active", ...rest });
  }
  for (const loc of seed.locations ?? []) {
    ws.locations.push({
      name: String(loc.name).trim(),
      description: String(loc.description ?? "").trim()
    });
  }
  for (const e of seed.lorebook ?? []) {
    ws.lorebook.push({
      id: genEntryId("lore"),
      title: String(e.title).trim(),
      content: String(e.content).trim(),
      keywords: Array.isArray(e.keywords)
        ? e.keywords.map((k) => String(k).trim()).filter(Boolean)
        : [String(e.title).trim().toLowerCase()]
    });
  }
  for (const text of seed.session_beats ?? []) {
    ws.session_beats.push(makeSessionBeat(text));
  }
  for (const b of seed.bestiary ?? []) {
    ws.bestiary.push({
      id: genEntryId("beast"),
      name: String(b.name).trim(),
      rank: String(b.rank ?? "").trim(),
      discovered: b.discovered !== false,
      encounters: Number.isInteger(b.encounters) ? b.encounters : 0,
      knownTraits: Array.isArray(b.knownTraits)
        ? b.knownTraits.map((t) => String(t).trim()).filter(Boolean)
        : [],
      notes: String(b.notes ?? "").trim(),
      firstSeen: String(b.firstSeen ?? "").trim()
    });
  }
  if (typeof seed.current_location === "string") {
    ws.current_location = seed.current_location.trim();
  }
  writeJson(path.join(worldDir, "world_state.json"), ws);

  const gmFile = manifest.gm?.bestiaryFile;
  if (typeof gmFile === "string" && gmFile.trim()) {
    fs.copyFileSync(
      resolveTemplateFile(dir, gmFile),
      path.join(worldDir, GM_BESTIARY_FILENAME)
    );
  }

  const systemPrompt = fs
    .readFileSync(resolveTemplateFile(dir, manifest.narrator.systemPromptFile), "utf8")
    .trim();
  const ob = manifest.onboarding;
  return {
    narrator: {
      systemPrompt,
      promptMode: manifest.narrator.promptMode === "append" ? "append" : "override",
      config:
        manifest.narrator.config && typeof manifest.narrator.config === "object"
          ? { ...manifest.narrator.config }
          : {}
    },
    onboarding:
      ob && typeof ob === "object" && !Array.isArray(ob)
        ? {
            firstMessageHint: String(ob.firstMessageHint ?? ""),
            // Handoff mode (design doc 01 §10). "app-forge" defers the opening
            // to the in-app forge, then confirms the sheet using openingHint.
            mode: ob.mode === "app-forge" ? "app-forge" : "narrator-forge",
            openingHint: String(ob.openingHint ?? "")
          }
        : null
  };
}

/**
 * Load the active world's GM bestiary creatures for narrator reference
 * context. Returns null when the world has none (blank worlds, pre-template
 * saves) — the context assembler treats null as "no GM block", byte-identical
 * to pre-0.9.0 prompts.
 * @param {string} worldDir
 * @returns {object[] | null}
 */
export function loadGmBestiary(worldDir) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(worldDir, GM_BESTIARY_FILENAME), "utf8")
    );
    const creatures = Array.isArray(parsed?.creatures) ? parsed.creatures : null;
    return creatures && creatures.length > 0 ? creatures : null;
  } catch {
    return null;
  }
}
