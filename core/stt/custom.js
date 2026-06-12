import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * @param {object} opts
 * @param {string} opts.bin - path to the custom STT binary
 * @param {string} opts.argTemplate - argument template with {input} and optionally {output}
 */
export function createCustomAdapter({ bin, argTemplate }) {
  const usesOutputFile = argTemplate.includes("{output}");

  return {
    /** @param {string} wavPath @returns {Promise<string>} */
    transcribe(wavPath) {
      return new Promise((resolve, reject) => {
        if (!bin) {
          reject(new Error("Custom STT binary path is not configured."));
          return;
        }

        let outputPath = "";
        let finalArgs = argTemplate.replace(/\{input\}/g, wavPath);

        if (usesOutputFile) {
          outputPath = path.join(
            os.tmpdir(),
            `tmixw-stt-${randomBytes(6).toString("hex")}.txt`
          );
          finalArgs = finalArgs.replace(/\{output\}/g, outputPath);
        }

        const args = parseArgs(finalArgs);
        const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
        child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
        child.on("error", (err) => {
          cleanup(outputPath);
          reject(err);
        });
        child.on("close", (code) => {
          if (code !== 0) {
            cleanup(outputPath);
            reject(new Error(`Custom STT exited ${code}: ${stderr || stdout}`.trim()));
            return;
          }

          let transcript = "";
          if (usesOutputFile) {
            try {
              transcript = fs.readFileSync(outputPath, "utf8").trim();
            } catch (err) {
              cleanup(outputPath);
              reject(new Error(`Custom STT output file missing or unreadable: ${err.message}`));
              return;
            }
            cleanup(outputPath);
          } else {
            transcript = stdout.trim();
          }

          if (!transcript) {
            reject(new Error("Custom STT produced empty transcript"));
            return;
          }
          resolve(transcript);
        });
      });
    }
  };
}

/**
 * Validate that a binary path exists and is executable.
 * @param {string} binPath
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCustomBinary(binPath) {
  if (!binPath || !binPath.trim()) {
    return { ok: false, error: "Binary path is empty." };
  }
  const resolved = path.resolve(binPath);
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `File not found: ${resolved}` };
  }
  try {
    const result = spawnSync(resolved, ["--help"], {
      timeout: 5000,
      stdio: "ignore"
    });
    if (result.error && result.error.code === "EACCES") {
      return { ok: false, error: `Not executable: ${resolved}` };
    }
  } catch {
    // --help may not be supported; that's fine if the file exists
  }
  return { ok: true };
}

function parseArgs(argStr) {
  const args = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (const ch of argStr) {
    if (inQuote) {
      if (ch === quoteChar) { inQuote = false; }
      else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) { args.push(current); current = ""; }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}

function cleanup(filePath) {
  if (filePath) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}
