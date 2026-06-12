import { spawn } from "node:child_process";

/**
 * @param {object} opts
 * @param {string} opts.bin - path to whisper-cli binary
 * @param {string} opts.model - path to .bin model file
 * @param {string} opts.language
 * @param {number} opts.threads
 */
export function createWhisperCppAdapter({ bin, model, language, threads }) {
  return {
    /** @param {string} wavPath @returns {Promise<string>} */
    transcribe(wavPath) {
      return new Promise((resolve, reject) => {
        if (!bin || !model) {
          reject(new Error(
            "Missing Whisper binary and/or model. Set whisperBin/whisperModel in config.json, " +
            "WHISPER_BIN/WHISPER_MODEL env vars, or place bundled files under resources/bin."
          ));
          return;
        }

        const args = ["-m", model, "-f", wavPath, "-l", language, "-t", String(threads)];
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) {
            reject(new Error(`Whisper exited ${code}: ${stderr || stdout}`.trim()));
            return;
          }
          const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
          const last = lines.at(-1) ?? "";
          const cleaned = last.replace(/^\[[^\]]+\]\s*/, "").trim();
          if (!cleaned) {
            reject(new Error("Whisper produced empty transcript"));
            return;
          }
          resolve(cleaned);
        });
      });
    }
  };
}
