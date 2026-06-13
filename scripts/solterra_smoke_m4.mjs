// Throwaway M4 live smoke: create a Solterra world from the picker UI and
// verify the template applied end-to-end — seeded NPCs/lore in the codex,
// narrator override + onboarding in world.json, GM bestiary copied beside
// (never inside) world state, existing world untouched. The live forge run
// itself needs a model (open gate). Needs vite dev on 5173; run from repo root.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

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

const reg = () => JSON.parse(fs.readFileSync(path.resolve("core", "worlds.json"), "utf8"));

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  timeout: 45_000
});

try {
  await app.firstWindow({ timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 4000));
  const page =
    app.windows().find((w) => !w.url().startsWith("devtools://")) ??
    (await app.firstWindow());
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[renderer error]", m.text());
  });
  await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 20_000 });
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());
  await page.waitForTimeout(500);

  await checkStep("picker offers the Solterra template", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    await page.waitForSelector(".worlds-template-select", { timeout: 5000 });
    const options = await page.$$eval(".worlds-template-select option", (os) =>
      os.map((o) => ({ value: o.value, label: o.textContent }))
    );
    if (!options.some((o) => o.value === "")) throw new Error("Blank World option missing");
    if (!options.some((o) => o.value === "solterra-guildblade")) {
      throw new Error(`Solterra missing; options: ${JSON.stringify(options)}`);
    }
  });

  await checkStep("create 'Guildblade Test' from the Solterra template", async () => {
    await page.fill(".worlds-new-input", "Guildblade Test");
    await page.selectOption(".worlds-template-select", "solterra-guildblade");
    await page.click("button:has-text('New World')");
    await page.waitForSelector(".worlds-modal", { state: "detached", timeout: 20_000 });
    await page.waitForTimeout(1500);
  });

  await checkStep("seeded cast present (Skyra, Charter Clerk); Aria's people absent", async () => {
    await page.click(".codex-tab:has-text('Cast')");
    await page.waitForSelector("text=Skyra", { timeout: 5000 });
    await page.waitForSelector("text=The Charter Clerk", { timeout: 5000 });
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Torvald")) throw new Error("old-world NPC leaked into the template world");
  });
  await page.screenshot({ path: path.join(SHOT_DIR, "m4-01-solterra-cast.png") });

  await checkStep("seeded lore present in WORLD tab", async () => {
    await page.click(".codex-tab:has-text('World')");
    await page.waitForSelector("text=The Adventurers' Charter", { timeout: 5000 });
    await page.waitForSelector("text=The Gambit Rule", { timeout: 5000 });
  });

  await checkStep("player bestiary starts empty (GM stat blocks stay out)", async () => {
    await page.click(".codex-tab:has-text('Bestiary')");
    await page.waitForSelector("text=Your field journal is empty", { timeout: 5000 });
  });

  await checkStep("disk: world.json carries narrator override + onboarding; gm_bestiary.json beside world state", async () => {
    const r = reg();
    const active = r.worlds.find((w) => w.id === r.activeWorldId);
    if (active?.name !== "Guildblade Test") throw new Error(`active is ${active?.name}`);
    if (active?.templateId !== "solterra-guildblade") throw new Error("templateId not recorded");
    const worldDir = path.resolve("core", "worlds", r.activeWorldId);
    const meta = JSON.parse(fs.readFileSync(path.join(worldDir, "world.json"), "utf8"));
    if (!/guildblade/i.test(meta.narrator?.systemPrompt ?? "")) {
      throw new Error("narrator override missing or not the Guildblade manual");
    }
    if (meta.narrator.promptMode !== "override") throw new Error("promptMode wrong");
    if (meta.narrator.config?.lengthPreset !== "brief") throw new Error("narrator.config not carried");
    if (meta.onboarding?.runAtStart !== "character-forge") throw new Error("onboarding missing");
    if (!fs.existsSync(path.join(worldDir, "gm_bestiary.json"))) {
      throw new Error("gm_bestiary.json not copied into the world dir");
    }
    const ws = fs.readFileSync(path.join(worldDir, "world_state.json"), "utf8");
    if (ws.includes("Goblin Scrapper")) throw new Error("GM stat blocks leaked into world state");
  });

  await checkStep("switch back: Aria's world untouched", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    const row = page.locator(".worlds-row", { hasText: "Aria's World" });
    await row.locator("button:has-text('Switch')").click();
    await page.waitForSelector(".worlds-modal", { state: "detached", timeout: 15_000 });
    await page.waitForTimeout(1500);
    await page.click(".codex-tab:has-text('Cast')");
    await page.waitForSelector("text=Torvald Ironhand", { timeout: 5000 });
    const body = await page.evaluate(() => document.body.innerText);
    if (body.includes("Skyra")) throw new Error("template content leaked into Aria's world");
  });

  await checkStep("cleanup: trash the test world from the picker", async () => {
    await page.click(".codex-icon-btn[title='Worlds']");
    await page.waitForSelector(".worlds-modal", { timeout: 5000 });
    const row = page.locator(".worlds-row", { hasText: "Guildblade Test" });
    await row.locator("button:has-text('Delete')").click();
    await row.locator("button:has-text('Really delete?')").click();
    await page.waitForSelector(".worlds-row >> text=Guildblade Test", { state: "detached", timeout: 5000 });
  });
  await page.screenshot({ path: path.join(SHOT_DIR, "m4-02-after-cleanup.png") });
} finally {
  await app.close().catch(() => {});
}

console.log(failures === 0 ? "\nM4 smoke ALL PASS" : `\nM4 smoke FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
