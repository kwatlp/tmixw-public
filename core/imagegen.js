/**
 * Optional image generation adapter (roadmap v4 v0.7.0 item 3; plan D6).
 * A1111/Forge-compatible `/sdapi/v1/txt2img` only — manual, isolated, and
 * strictly optional: nothing else may depend on this module, an absent
 * endpoint hides every button, and failures surface as a toast, never
 * blocking play.
 *
 * Config block (core/config.json):
 *   "imagegen": { "endpoint": "http://127.0.0.1:7860", "steps": 28,
 *                 "width": 1280, "height": 720, "negative": "..." }
 * Empty/missing endpoint = feature off.
 *
 * NOTE: built against the stable A1111 API shape; live verification pending
 * a local endpoint (none on the dev machine as of 2026-06-12).
 */
import fs from "node:fs";
import path from "node:path";
import { getWritableCoreDir } from "./app_paths.js";

export const IMAGEGEN_DEFAULTS = {
  endpoint: "",
  steps: 28,
  width: 1280,
  height: 720,
  negative: "text, watermark, signature, blurry, lowres, deformed"
};

/** @param {Record<string, unknown>} fileCfg - root of core/config.json */
export function buildImagegenRuntimeConfig(fileCfg) {
  const c = /** @type {Record<string, unknown>} */ (fileCfg?.imagegen ?? {});
  return {
    endpoint: String(c.endpoint ?? IMAGEGEN_DEFAULTS.endpoint).trim().replace(/\/+$/, ""),
    steps: Math.max(1, Math.min(150, Number(c.steps ?? IMAGEGEN_DEFAULTS.steps) || IMAGEGEN_DEFAULTS.steps)),
    width: Number(c.width ?? IMAGEGEN_DEFAULTS.width) || IMAGEGEN_DEFAULTS.width,
    height: Number(c.height ?? IMAGEGEN_DEFAULTS.height) || IMAGEGEN_DEFAULTS.height,
    negative: String(c.negative ?? IMAGEGEN_DEFAULTS.negative)
  };
}

export function imagegenEnabled(cfg) {
  return Boolean(cfg?.endpoint);
}

/**
 * Scene-art prompt from location facts. Style suffix keeps locations within
 * one visual family; description is the extractor's accumulated text.
 */
export function buildLocationPrompt(name, description = "") {
  const desc = String(description ?? "").trim();
  return [
    `Environment concept art of ${String(name ?? "").trim()}`,
    desc ? desc : null,
    "fantasy illustration, atmospheric lighting, painterly, wide establishing shot, no people in focus"
  ]
    .filter(Boolean)
    .join(", ");
}

/** txt2img request body for an A1111-compatible server. */
export function buildTxt2ImgPayload(prompt, cfg) {
  return {
    prompt,
    negative_prompt: cfg.negative,
    steps: cfg.steps,
    width: cfg.width,
    height: cfg.height,
    sampler_name: "Euler a",
    cfg_scale: 7
  };
}

/**
 * Generate one image; returns raw PNG bytes.
 * @param {ReturnType<typeof buildImagegenRuntimeConfig>} cfg
 */
export async function txt2img(prompt, cfg, fetchImpl = fetch) {
  if (!imagegenEnabled(cfg)) throw new Error("No image generation endpoint configured.");
  const res = await fetchImpl(`${cfg.endpoint}/sdapi/v1/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildTxt2ImgPayload(prompt, cfg))
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Image endpoint HTTP ${res.status}: ${text.slice(0, 200)}`.trim());
  }
  const json = await res.json();
  const b64 = json?.images?.[0];
  if (!b64) throw new Error("Image endpoint returned no images.");
  return Buffer.from(String(b64).split(",").pop(), "base64");
}

/** Slug for generated filenames. */
export function imageSlug(name) {
  return (
    String(name ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "image"
  );
}

/**
 * Save generated PNG under `<writableCore>/generated/` and return its
 * absolute path (the gallery map references it directly).
 */
export function saveGeneratedImage(pngBytes, name) {
  const dir = path.join(getWritableCoreDir(), "generated");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `${imageSlug(name)}-${stamp}.png`);
  fs.writeFileSync(file, pngBytes);
  return file;
}
