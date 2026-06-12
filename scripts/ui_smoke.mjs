// Throwaway UI smoke driver (v0.8.4 codex work): launch the built app,
// screenshot the codex panel states, exit. Not part of the test suites.
// Usage: node scripts/ui_smoke.mjs
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  timeout: 45_000
});

try {
  // Window creation waits behind the inference-backend boot — allow for a
  // model load.
  await app.firstWindow({ timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 3000));
  // Dev mode opens detached devtools — pick the app window.
  const page =
    app.windows().find((w) => !w.url().startsWith("devtools://")) ??
    (await app.firstWindow());
  console.log("windows:", app.windows().map((w) => w.url()));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("[renderer error]", m.text());
  });
  await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  try {
    await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 20_000 });
  } catch (e) {
    console.log("codex panel not found; body text:");
    console.log(await page.evaluate(() => document.body.innerText.slice(0, 800)));
    const f = path.join(SHOT_DIR, "00-failure.png");
    await page.screenshot({ path: f });
    console.log("shot:", f);
    throw e;
  }
  await page.waitForTimeout(1500);

  // Panel collapse persists in localStorage — expand if a previous run left
  // the rail behind.
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());
  await page.waitForTimeout(300);

  const shot = async (name) => {
    const f = path.join(SHOT_DIR, `${name}.png`);
    await page.screenshot({ path: f });
    console.log("shot:", f);
  };

  const clickTab = async (label) => {
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll(".codex-tab")].find(
        (b) => b.textContent.trim().toLowerCase() === t
      );
      if (el) el.click();
    }, label);
    await page.waitForTimeout(400);
  };

  // CAST: expand the PC card
  await clickTab("cast");
  await page.evaluate(() => {
    document.querySelector(".cdx-card-header")?.click();
  });
  await page.waitForTimeout(400);
  await shot("01-cast-pc-expanded");

  // WORLD: expand first lore card
  await clickTab("world");
  await page.evaluate(() => {
    document.querySelector(".cdx-card-header")?.click();
  });
  await page.waitForTimeout(400);
  await shot("02-world-lore-expanded");

  // STORY: Threads + Chronicle; expand the first chronicle card
  await clickTab("story");
  await page.evaluate(() => {
    const headers = [...document.querySelectorAll(".cdx-card-header")];
    headers[headers.length - 1]?.click(); // last card = current scene / newest
  });
  await page.waitForTimeout(400);
  await shot("03-story-chronicle");

  // Collapse rail
  await page.evaluate(() => {
    [...document.querySelectorAll(".codex-icon-btn")]
      .find((b) => b.textContent.includes("⇤"))
      ?.click();
  });
  await page.waitForTimeout(400);
  await shot("04-collapsed-rail");

  console.log("ui smoke done");
} finally {
  await app.close().catch(() => {});
}
