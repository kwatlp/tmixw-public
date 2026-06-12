/**
 * Verifies bundled resources before `electron-builder`.
 *
 * v0.2.0+: FFmpeg, whisper-cli, and KoboldCPP are all wizard-provisioned at
 * first run — no binaries are required for the build.
 *
 * Tech-debt session 2026-06-12 (FEATURE_CREEP #3): the MiniLM embeddings
 * model must ship under `resources/models/` so a packaged install never
 * fetches from HuggingFace at boot (local-first, offline-safe). The small
 * JSONs are tracked in git; the onnx weights are not — copy them once from
 * the @xenova cache (see resources/models/README.md). The build fails when
 * they are missing rather than silently producing an online-only build.
 *
 * Set SKIP_PHASE4_RESOURCES_CHECK=1 to suppress all checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MINILM_DIR = path.join(ROOT, "resources", "models", "Xenova", "all-MiniLM-L6-v2");
const MINILM_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  path.join("onnx", "model_quantized.onnx")
];

function main() {
  if (process.env.SKIP_PHASE4_RESOURCES_CHECK === "1") {
    console.log(
      "[check-phase4-resources] Skipped (SKIP_PHASE4_RESOURCES_CHECK=1)."
    );
    return;
  }

  const missing = MINILM_FILES.filter((f) => !fs.existsSync(path.join(MINILM_DIR, f)));
  if (missing.length) {
    console.error(
      "[check-phase4-resources] Bundled MiniLM embeddings model incomplete — " +
      `missing under ${MINILM_DIR}:\n` +
      missing.map((f) => `  - ${f}`).join("\n") +
      "\nSee resources/models/README.md for the one-time copy instructions."
    );
    process.exit(1);
  }

  console.log(
    "[check-phase4-resources] Bundled MiniLM model present. No bundled " +
    "binaries required (FFmpeg, whisper-cli, and KoboldCPP are wizard-provisioned)."
  );

  // Dev-convenience binaries in resources/bin/ are excluded from the packaged
  // app (extraResources filter ships README.md only — decision of record
  // 2026-06-12: the 0.8.4 installer was found shipping the full whisper.cpp
  // release payload by accident). Warn so a future filter change can't
  // silently reintroduce the leak.
  const BIN_DIR = path.join(ROOT, "resources", "bin");
  const ALLOWED = new Set(["README.md", ".gitkeep"]);
  let stray = [];
  try {
    stray = fs.readdirSync(BIN_DIR).filter((f) => !ALLOWED.has(f));
  } catch {
    // no resources/bin — nothing to warn about
  }
  if (stray.length) {
    console.warn(
      "[check-phase4-resources] Note: resources/bin/ contains " +
      `${stray.length} dev-convenience file(s) (e.g. ${stray.slice(0, 3).join(", ")}). ` +
      "These are NOT copied into the build (extraResources ships README.md " +
      "only). If a packaged build resolves one of these binaries, the " +
      "extraResources filter in package.json has regressed."
    );
  }
}

main();
