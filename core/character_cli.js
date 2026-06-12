import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadWorldState,
  saveWorldState,
  mergeCharacterCard,
  getWorldStatePath
} from "./world_state.js";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

function parseValue(s) {
  const t = s.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return s;
    }
  }
  return s;
}

const cmd = process.argv[2];

if (cmd === "path") {
  console.log(path.resolve(getWorldStatePath()));
  process.exit(0);
}

if (cmd === "show") {
  const ws = loadWorldState();
  console.log(JSON.stringify(ws.character, null, 2));
  process.exit(0);
}

if (cmd === "open") {
  const abs = path.resolve(getWorldStatePath());
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", abs], { detached: true, stdio: "ignore" });
  } else {
    spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
  }
  console.log(abs);
  process.exit(0);
}

if (cmd === "set") {
  const key = process.argv[3];
  const rest = process.argv.slice(4).join(" ");
  if (!key || rest === "") {
    console.error('Usage: node core/character_cli.js set <key> <value...>\nExample: char:set name "Jane Doe"');
    process.exit(1);
  }
  const ws = loadWorldState();
  ws.character[key] = parseValue(rest);
  saveWorldState(ws);
  console.log(JSON.stringify(ws.character, null, 2));
  process.exit(0);
}

if (cmd === "import-json") {
  const fp = process.argv[3];
  if (!fp) {
    console.error("Usage: node core/character_cli.js import-json path\\to\\card.json");
    process.exit(1);
  }
  const raw = fs.readFileSync(path.resolve(fp), "utf8");
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    console.error("JSON must be an object");
    process.exit(1);
  }
  const ws = loadWorldState();
  mergeCharacterCard(ws, obj);
  saveWorldState(ws);
  console.log(JSON.stringify(ws.character, null, 2));
  process.exit(0);
}

console.error(`Usage:
  npm run char:show
  npm run char:path
  npm run char:open     (opens world_state.json with OS default)
  npm run char:set -- <key> <value...>
  npm run char:import -- path\\to\\card.json
`);
process.exit(1);
