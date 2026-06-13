// Throwaway M2 live smoke: seed filler data into the dev world, then drive
// the real UI — picker open, create, switch (no cross-world bleed), rename,
// delete-to-trash. Needs the vite dev server on 5173. Run from repo root.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

// --- Seed filler (the real save was deleted; fabricate a lived-in world) ---
const { ensureWorldsLayout, renameWorld } = await import("../core/worlds.js");
const { loadWorldState, saveWorldState, makeSessionBeat } = await import(
  "../core/world_state.js"
);
const boot = ensureWorldsLayout();
const ws = loadWorldState();
ws.character = { name: "Aria Stormsong", class: "Stormcaller", level: "3" };
if (!ws.npcs.some((n) => n.name === "Torvald Ironhand")) {
  ws.npcs.push({
    name: "Torvald Ironhand",
    status: "alive",
    notes: "Filler blacksmith of Emberreach. Owes Aria a favor."
  });
}
if (!ws.locations.includes("Emberreach")) ws.locations.push("Emberreach");
ws.current_location = "Emberreach";
if (ws.session_beats.length === 0) {
  ws.session_beats.push(makeSessionBeat("Aria arrived in Emberreach during the ash storm."));
}
saveWorldState(ws);
renameWorld(boot.activeWorldId, "Aria's World");
console.log("seeded filler into", boot.activeWorldId);

// --- Drive the UI ----------------------------------------------------------
const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  timeout: 45_000
});

let failures = 0;
const checkStep = async (name, fn) => {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}: ${e.message}`);
  }
};

try {
  await app.firstWindow({ timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 4000));
  const page =
    app.windows().find((w) => !w.url().startsWith("devtools://")) ??
    (await app.firstWindow());
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[renderer error]", m.text());
  });
  const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOT_DIR, `m2-${name}.png`) });
  };

  await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 20_000 });
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());
  await page.waitForTimeout(500);

  await checkStep("seeded world visible in codex (Torvald in CAST)", async () => {
    await page.click(".codex-tab:has-text('Cast')");
    await page.waitForSelector("text=Torvald Ironhand", { timeout: 5000 });
  });
  await shot("01-seeded-world");

  await checkStep("world picker opens from the codex header", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    await page.waitForSelector(".worlds-row.active >> text=Aria's World", { timeout: 5000 });
  });
  await shot("02-picker-open");

  await checkStep("create new world switches to it", async () => {
    await page.fill(".worlds-new-input", "Test World B");
    await page.click("button:has-text('New World')");
    await page.waitForSelector(".worlds-modal", { state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1500);
  });

  await checkStep("no cross-world bleed: Torvald absent in fresh world", async () => {
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Torvald")) throw new Error("old-world NPC leaked into new world UI");
  });
  await shot("03-fresh-world");

  await checkStep("registry now has 2 worlds, B active", async () => {
    const reg = JSON.parse(fs.readFileSync(path.resolve("core", "worlds.json"), "utf8"));
    const active = reg.worlds.find((w) => w.id === reg.activeWorldId);
    if (reg.worlds.length !== 2) throw new Error(`expected 2 worlds, got ${reg.worlds.length}`);
    if (active?.name !== "Test World B") throw new Error(`active is ${active?.name}`);
  });

  await checkStep("switch back restores the seeded world", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    const row = page.locator(".worlds-row", { hasText: "Aria's World" });
    await row.locator("button:has-text('Switch')").click();
    await page.waitForSelector(".worlds-modal", { state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.click(".codex-tab:has-text('Cast')");
    await page.waitForSelector("text=Torvald Ironhand", { timeout: 5000 });
  });
  await shot("04-switched-back");

  await checkStep("rename World B from the picker", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    const row = page.locator(".worlds-row", { hasText: "Test World B" });
    await row.locator("button:has-text('Rename')").click();
    await page.fill(".worlds-rename-input", "Renamed B");
    await page.click("button:has-text('Save')");
    await page.waitForSelector(".worlds-row >> text=Renamed B", { timeout: 5000 });
  });

  await checkStep("delete Renamed B to trash (two-step confirm)", async () => {
    const row = page.locator(".worlds-row", { hasText: "Renamed B" });
    await row.locator("button:has-text('Delete')").click();
    await row.locator("button:has-text('Really delete?')").click();
    await page.waitForSelector(".worlds-row >> text=Renamed B", { state: "detached", timeout: 5000 });
    const reg = JSON.parse(fs.readFileSync(path.resolve("core", "worlds.json"), "utf8"));
    if (reg.worlds.length !== 1) throw new Error(`expected 1 world after delete, got ${reg.worlds.length}`);
    const trash = path.resolve("core", "worlds", ".trash");
    const entries = fs.existsSync(trash) ? fs.readdirSync(trash) : [];
    if (entries.length === 0) throw new Error("nothing landed in worlds/.trash");
    console.log("  trash:", entries.join(", "));
  });
  await shot("05-after-delete");
} finally {
  await app.close().catch(() => {});
}

console.log(failures === 0 ? "\nM2 smoke ALL PASS" : `\nM2 smoke FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
