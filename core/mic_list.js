import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getPackageRoot } from "./app_paths.js";
import { resolveFfmpegBin } from "./bin_paths.js";

function loadConfigJson() {
  try {
    const p = path.join(getPackageRoot(), "core", "config.json");
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

const fileCfg = loadConfigJson();
const ffmpegBin = process.env.FFMPEG_BIN ?? resolveFfmpegBin(fileCfg);

function listDshowAudioDevices() {
  const proc = spawnSync(
    ffmpegBin,
    ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
    { encoding: "utf8" }
  );

  const out = `${proc.stdout ?? ""}\n${proc.stderr ?? ""}`;
  const lines = out.split(/\r?\n/);

  const devices = [];
  for (const line of lines) {
    const m = line.match(/"([^"]+)"\s+\(audio\)/i);
    if (m?.[1]) devices.push(m[1]);
  }
  return devices;
}

try {
  const devices = listDshowAudioDevices();
  if (!devices.length) {
    console.log(
      "[mic:list] No DirectShow audio devices detected. (Is ffmpeg installed and working?)"
    );
    process.exit(1);
  }

  console.log("[mic:list] DirectShow audio devices:");
  for (const d of devices) console.log(`- ${d}`);
} catch (e) {
  console.error(`[mic:list] ${(e && e.message) || String(e)}`);
  process.exit(1);
}
