// Load + validate a template's character_creation.json (design doc 01 §4, §8).
// Referenced from the manifest under `onboarding.characterCreationFile`;
// resolved through the same sandbox as every other template file
// (resolveTemplateFile in story_templates.js — paths may not escape the folder).
// Absent reference ⇒ null (legacy / blank worlds run the narrator forge).

import fs from "node:fs";
import { resolveTemplateFile } from "../story_templates.js";
import { validateCreationSpec } from "./validate.js";

/**
 * @param {string} templateDir - the template's folder (discoverTemplates row `dir`)
 * @param {object} manifest - the parsed template.json
 * @returns {{ spec: object, errors: string[] } | null}
 *   null when no spec is referenced; otherwise the parsed spec plus any
 *   validation errors (caller decides fatal vs. skip-with-warning).
 */
export function loadCreationSpec(templateDir, manifest) {
  const rel = manifest?.onboarding?.characterCreationFile;
  if (typeof rel !== "string" || !rel.trim()) return null;

  const abs = resolveTemplateFile(templateDir, rel); // throws on escape / missing
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch (err) {
    return { spec: null, errors: [`character_creation.json is not valid JSON (${err.message})`] };
  }
  const v = validateCreationSpec(spec);
  return { spec: v.ok ? spec : null, errors: v.errors };
}
