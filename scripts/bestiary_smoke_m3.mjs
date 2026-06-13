// Throwaway M3 live smoke: Bestiary tab empty state → seed creatures through
// the real applyExtractorDiff path (what a live extractor turn does) →
// relaunch → entries render with pills/traits and the isNew draft marker.
// Needs the vite dev server on 5173. Run from repo root.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const { ensureWorldsLayout } = await import("../core/worlds.js");
const { applyExtractorDiff, loadWorldState, saveWorldState } = await import(
  "../core/world_state.js"
);

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

const launch = async () => {
  const app = await electron.launch({
    executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
    args: ["."],
    timeout: 45_000
  });
  await app.firstWindow({ timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 4000));
  const page =
    app.windows().find((w) => !w.url().startsWith("devtools://")) ??
    (await app.firstWindow());
  await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 20_000 });
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());
  await page.waitForTimeout(500);
  return { app, page };
};

ensureWorldsLayout();

// Idempotency: clear any bestiary left by a previous smoke run so the
// empty-state and encounter-count assertions start from a known world.
{
  const ws = loadWorldState();
  ws.bestiary = [];
  saveWorldState(ws);
}

// Phase 1: empty journal state.
{
  const { app, page } = await launch();
  try {
    await checkStep("Bestiary tab exists and shows the empty-journal hint", async () => {
      await page.click(".codex-tab:has-text('Bestiary')");
      await page.waitForSelector("text=Your field journal is empty", { timeout: 5000 });
    });
    await page.screenshot({ path: path.join(SHOT_DIR, "m3-01-empty-journal.png") });
  } finally {
    await app.close().catch(() => {});
  }
}

// Phase 2: seed two creatures exactly the way a live extractor turn would,
// including a re-sighting (encounters increment + trait union).
{
  const ws = loadWorldState();
  applyExtractorDiff(
    ws,
    {
      bestiary: [
        {
          name: "Gnasher",
          rank: "E",
          knownTraits: ["pack tactics"],
          notes: "Mange-furred mine-hounds. Cowardly alone."
        }
      ]
    },
    { prov: "ai", autoKeepPrevious: true }
  );
  applyExtractorDiff(
    ws,
    {
      bestiary: [
        { name: "gnasher", knownTraits: ["fears fire"] },
        { name: "Ash Wraith", rank: "C", knownTraits: ["passes through stone"] }
      ]
    },
    { prov: "ai" }
  );
  saveWorldState(ws);
  const g = ws.bestiary.find((b) => b.name === "Gnasher");
  console.log(
    "seeded:",
    ws.bestiary.map((b) => `${b.name} (enc ${b.encounters})`).join(", "),
    "| Gnasher traits:",
    g.knownTraits.join("/")
  );
  if (g.encounters !== 2 || g.knownTraits.length !== 2) {
    failures++;
    console.error("FAIL seed: re-sighting did not merge as expected");
  }
}

// Phase 3: relaunch, entries render.
{
  const { app, page } = await launch();
  try {
    await checkStep("seeded creatures render in the Bestiary tab", async () => {
      await page.click(".codex-tab:has-text('Bestiary')");
      await page.waitForSelector("text=Gnasher", { timeout: 5000 });
      await page.waitForSelector("text=Ash Wraith", { timeout: 5000 });
    });
    await checkStep("rank pill and trait pills render on the card", async () => {
      // Pills are CSS-uppercased — compare case-insensitively. Card expansion
      // persists in localStorage, so click only when the traits aren't visible.
      const bodyText = async () =>
        (await page.evaluate(() => document.body.innerText)).toLowerCase();
      let body = await bodyText();
      if (!body.includes("pack tactics")) {
        await page.click("text=Gnasher");
        await page.waitForTimeout(400);
        body = await bodyText();
      }
      if (!body.includes("rank e")) throw new Error("rank pill missing");
      if (!body.includes("pack tactics") || !body.includes("fears fire")) {
        throw new Error("knownTraits pills missing");
      }
    });
    await checkStep("codex search finds creatures (Bestiary tab counted)", async () => {
      await page.fill(".codex-search", "wraith");
      await page.waitForTimeout(400);
      const tab = await page.textContent(".codex-tab:has-text('Bestiary')");
      if (!/Bestiary · 1/.test(tab ?? "")) throw new Error(`tab label was "${tab}"`);
      await page.fill(".codex-search", "");
    });
    await page.screenshot({ path: path.join(SHOT_DIR, "m3-02-seeded-journal.png") });
  } finally {
    await app.close().catch(() => {});
  }
}

console.log(failures === 0 ? "\nM3 smoke ALL PASS" : `\nM3 smoke FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
