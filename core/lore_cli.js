import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  loadWorldState,
  saveWorldState,
  normalizeLorebook,
  mergedLorebookMatchesDetailed,
  buildLoreRuntimeConfig,
  getWorldStatePath
} from "./world_state.js";
import { embedLorebookEntry, embedAllMissing } from "./embeddings.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "core", "config.json");

function loadJsonIfExists(p) {
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function parseAddArgs(argv) {
  const out = { title: "", content: "", keywords: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--title") out.title = argv[++i] ?? "";
    else if (a === "--content") out.content = argv[++i] ?? "";
    else if (a === "--keywords") out.keywords = argv[++i] ?? "";
  }
  return out;
}

function keywordListFromArg(s) {
  return String(s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function askLine(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    });
  });
}

function openWorldStateFile() {
  const abs = path.resolve(getWorldStatePath());
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", abs], { detached: true, stdio: "ignore" });
  } else if (process.platform === "darwin") {
    spawn("open", [abs], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [abs], { detached: true, stdio: "ignore" }).unref();
  }
  console.log(abs);
}

async function main() {
  const cmd = process.argv[2];

  if (cmd === "add") {
    const flags = parseAddArgs(process.argv.slice(3));
    if (!flags.title.trim()) {
      console.error(
        'Usage: npm run lore:add -- --title "..." --content "..." --keywords "a,b"'
      );
      process.exit(1);
    }
    const lr = buildLoreRuntimeConfig(loadJsonIfExists(CONFIG_PATH) ?? {});
    const ws = loadWorldState();
    if (!Array.isArray(ws.lorebook)) ws.lorebook = [];
    /** @type {{ title: string, content: string, keywords: string[] }} */
    const entry = {
      title: flags.title.trim(),
      content: flags.content.trim(),
      keywords: keywordListFromArg(flags.keywords)
    };
    const [normed] = normalizeLorebook([entry]);
    ws.lorebook.push(normed);
    if (lr.vectorEnabled) {
      const last = ws.lorebook[ws.lorebook.length - 1];
      await embedLorebookEntry(last);
    }
    saveWorldState(ws);
    console.log(
      `Added lorebook entry #${ws.lorebook.length}: ${normed.title}${lr.vectorEnabled ? " (embedded)" : ""}`
    );
    return;
  }

  if (cmd === "list") {
    const ws = loadWorldState();
    const book = ws.lorebook ?? [];
    if (!book.length) {
      console.log("(no lorebook entries)");
      return;
    }
    book.forEach((e, i) => {
      const kw = (e.keywords ?? []).join(", ") || "(no keywords)";
      console.log(`${i + 1}. ${e.title}  [${kw}]`);
    });
    return;
  }

  if (cmd === "show") {
    const idx = Number(process.argv[3]);
    const ws = loadWorldState();
    const book = ws.lorebook ?? [];
    if (!Number.isFinite(idx) || idx < 1 || idx > book.length) {
      console.error(`Usage: npm run lore:show -- <index>  (1–${book.length || 0})`);
      process.exit(1);
    }
    const e = book[idx - 1];
    const view = {
      title: e.title,
      content: e.content,
      keywords: e.keywords ?? []
    };
    if (Array.isArray(e.embedding) && e.embedding.length) {
      view.embeddingStored = true;
      view.embeddingLength = e.embedding.length;
    } else {
      view.embeddingStored = false;
    }
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  if (cmd === "remove") {
    const idx = Number(process.argv[3]);
    const ws = loadWorldState();
    const book = ws.lorebook ?? [];
    if (!Number.isFinite(idx) || idx < 1 || idx > book.length) {
      console.error(`Usage: npm run lore:remove -- <index>  (1–${book.length || 0})`);
      process.exit(1);
    }
    const e = book[idx - 1];
    const ans = (await askLine(`Remove '${e.title}'? [y/N] `)).trim().toLowerCase();
    if (ans !== "y" && ans !== "yes") {
      console.log("Cancelled.");
      return;
    }
    book.splice(idx - 1, 1);
    saveWorldState(ws);
    console.log("Removed.");
    return;
  }

  if (cmd === "edit") {
    openWorldStateFile();
    return;
  }

  if (cmd === "import") {
    const fp = process.argv[3];
    if (!fp) {
      console.error("Usage: npm run lore:import -- path\\to\\file.json");
      process.exit(1);
    }
    const lr = buildLoreRuntimeConfig(loadJsonIfExists(CONFIG_PATH) ?? {});
    const raw = fs.readFileSync(path.resolve(fp), "utf8");
    /** @type {unknown} */
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : [data];
    const normalized = normalizeLorebook(arr);
    if (!normalized.length) {
      console.error("No valid lorebook entries in file.");
      process.exit(1);
    }
    const ws = loadWorldState();
    if (!Array.isArray(ws.lorebook)) ws.lorebook = [];
    ws.lorebook.push(...normalized);
    if (lr.vectorEnabled) await embedAllMissing(ws);
    saveWorldState(ws);
    console.log(`Imported ${normalized.length} entr${normalized.length === 1 ? "y" : "ies"}.`);
    return;
  }

  if (cmd === "test") {
    const query = process.argv.slice(3).join(" ").trim();
    if (!query) {
      console.error('Usage: npm run lore:test -- "your test phrase"');
      process.exit(1);
    }
    const lr = buildLoreRuntimeConfig(loadJsonIfExists(CONFIG_PATH) ?? {});
    const ws = loadWorldState();

    const d = await mergedLorebookMatchesDetailed(query, ws.lorebook ?? [], lr);

    console.log("");
    console.log("Keyword matches:");
    if (!d.keywordScored.length) {
      console.log("  (none)");
    } else {
      for (const r of d.keywordScored) {
        const kw = (r.entry.keywords ?? []).join(", ") || "(no keywords)";
        console.log(
          `  [${r.score.toFixed(2)}] ${r.entry.title}  (keywords: ${kw})`
        );
      }
    }
    console.log("");
    console.log("Vector matches:");
    if (!lr.vectorEnabled) {
      console.log("  (disabled — lorebook.vectorEnabled is false)");
    } else if (!d.vectorOnlyDisplay.length) {
      console.log("  (none above threshold / no embeddings)");
    } else {
      for (const r of d.vectorOnlyDisplay) {
        console.log(
          `  [${r.score.toFixed(2)}] ${r.entry.title}  (no keyword match)`
        );
      }
    }
    console.log("");
    console.log("Merged (would inject):");
    if (!d.merged.length) {
      console.log("  (none)");
    } else {
      d.merged.forEach((e, i) => {
        console.log(`  ${i + 1}. ${e.title}`);
      });
    }
    console.log("");
    return;
  }

  console.error(`Usage:
  npm run lore:add -- --title "..." --content "..." --keywords "a,b"
  npm run lore:list
  npm run lore:show -- <index>
  npm run lore:remove -- <index>
  npm run lore:edit
  npm run lore:import -- path\\to.json
  npm run lore:test -- "query text"
`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
