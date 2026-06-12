import { createWhisperCppAdapter } from "./whisper-cpp.js";
import { createCustomAdapter } from "./custom.js";

/**
 * @typedef {{ transcribe: (wavPath: string) => Promise<string> }} SttAdapter
 */

/**
 * Create an STT adapter based on config.
 * @param {object} opts
 * @param {string} opts.backend - "whisper-cpp" | "custom"
 * @param {string} [opts.whisperBin]
 * @param {string} [opts.whisperModel]
 * @param {string} [opts.whisperLanguage]
 * @param {number} [opts.whisperThreads]
 * @param {string} [opts.customBin]
 * @param {string} [opts.customArgs]
 * @returns {SttAdapter}
 */
export function createSttAdapter(opts) {
  const backend = opts.backend ?? "whisper-cpp";
  if (backend === "custom") {
    return createCustomAdapter({
      bin: opts.customBin ?? "",
      argTemplate: opts.customArgs ?? ""
    });
  }
  return createWhisperCppAdapter({
    bin: opts.whisperBin ?? "",
    model: opts.whisperModel ?? "",
    language: opts.whisperLanguage ?? "en",
    threads: opts.whisperThreads ?? 6
  });
}

/**
 * Validate that a custom STT binary exists and is executable.
 * Returns { ok: true } or { ok: false, error: string }.
 */
export { validateCustomBinary } from "./custom.js";
