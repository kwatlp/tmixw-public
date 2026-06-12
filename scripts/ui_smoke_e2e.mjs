// End-to-end: real model turn → direct extraction → isNew card + narrative
// marker chip → click chip → codex reveal. Needs koboldcpp + model (the app
// spawns it). Throwaway dev tool.
import { _electron as electron } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const SHOT_DIR = path.resolve("scripts", ".shots");
fs.mkdirSync(SHOT_DIR, { recursive: true });

const app = await electron.launch({
  executablePath: path.resolve("node_modules/electron/dist/electron.exe"),
  args: ["."],
  timeout: 120_000
});

try {
  await app.firstWindow({ timeout: 120_000 });
  await new Promise((r) => setTimeout(r, 3000));
  const page = app.windows().find((w) => !w.url().startsWith("devtools://"));
  await page.waitForSelector(".codex-panel, .codex-rail", { timeout: 30_000 });
  await page.evaluate(() => document.querySelector(".codex-rail")?.click());

  // Wait for the inference backend to be ready (textarea enabled = pipeline up;
  // kobold may still be loading the model — give the first turn a long leash).
  await page.fill(
    "textarea",
    "I walk to the smithy and greet the blacksmith, Torvald Ironhand, asking him about the missing apprentice."
  );
  await page.keyboard.press("Enter");
  console.log("turn submitted; waiting for narrative + extraction…");

  const chip = await page
    .waitForSelector(".narrative-marker-chip", { timeout: 360_000 })
    .catch(() => null);

  const narrative = await page.evaluate(
    () => [...document.querySelectorAll(".narrative-text")].at(-1)?.textContent?.slice(0, 200) ?? "(none)"
  );
  console.log("narrative:", narrative);

  if (!chip) {
    console.log("NO MARKER CHIP (extractor may not have created entries) — world check:");
    console.log(
      await page.evaluate(async () => {
        const w = await window.api.getWorld();
        return { npcs: w.npcs.map((n) => n.name), isNew: w.codex.isNew };
      })
    );
  } else {
    console.log(
      "chips:",
      await page.evaluate(() =>
        [...document.querySelectorAll(".narrative-marker-chip")].map((c) => c.textContent.trim())
      )
    );
    const f1 = path.join(SHOT_DIR, "08-marker-chip.png");
    await page.screenshot({ path: f1 });
    console.log("shot:", f1);

    await chip.click();
    await page.waitForTimeout(800);
    console.log(
      "after reveal:",
      await page.evaluate(() => ({
        activeTab: document.querySelector(".codex-tab.active")?.textContent.trim(),
        newCards: [...document.querySelectorAll(".cdx-card.is-new .cdx-card-name")].map(
          (e) => e.textContent
        ),
        expandedNew: !!document.querySelector(".cdx-card.is-new .cdx-field")
      }))
    );
    const f2 = path.join(SHOT_DIR, "09-reveal.png");
    await page.screenshot({ path: f2 });
    console.log("shot:", f2);
  }

  // isNew + prov in the save
  console.log(
    "world:",
    await page.evaluate(async () => {
      const w = await window.api.getWorld();
      return {
        npcs: w.npcs.map((n) => ({ id: n.id, name: n.name })),
        isNew: w.codex.isNew,
        provSample: Object.keys(w.codex.prov).slice(-3)
      };
    })
  );
} finally {
  await app.close().catch(() => {});
}
