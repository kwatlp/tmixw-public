// M5 smoke: codex-wide search (counts, highlight, expanded matches, Esc
// restore) + input bar restyle screenshot. Throwaway dev tool.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  timeout: 60_000
});

try {
  await app.firstWindow({ timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3000));
  const page = app.windows().find((w) => !w.url().startsWith("devtools://"));
  await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 20_000 });
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());
  await page.waitForTimeout(300);

  // STORY tab active, collapse a group first to test restore
  await page.evaluate(() => {
    [...document.querySelectorAll(".codex-tab")]
      .find((b) => b.textContent.trim().startsWith("Story"))
      ?.click();
  });
  await page.waitForTimeout(300);

  await page.fill(".codex-search", "battle");
  await page.waitForTimeout(500);
  const during = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".codex-tab")].map((b) => b.textContent.trim()),
    groups: [...document.querySelectorAll(".cdx-group-name")].map((e) => e.textContent),
    hits: document.querySelectorAll(".cdx-hit").length,
    cards: [...document.querySelectorAll(".cdx-card-name")].map((e) => e.textContent)
  }));
  console.log("during search:", JSON.stringify(during, null, 1));
  const f = path.join(SHOT_DIR, "05-search.png");
  await page.screenshot({ path: f });
  console.log("shot:", f);

  await page.focus(".codex-search");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => ({
    tabs: [...document.querySelectorAll(".codex-tab")].map((b) => b.textContent.trim()),
    query: document.querySelector(".codex-search").value
  }));
  console.log("after Esc:", JSON.stringify(after));

  const f2 = path.join(SHOT_DIR, "06-inputbar.png");
  await page.screenshot({ path: f2, clip: { x: 340, y: 600, width: 940, height: 200 } });
  console.log("shot:", f2);
} finally {
  await app.close().catch(() => {});
}
