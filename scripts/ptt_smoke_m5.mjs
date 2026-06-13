// Throwaway M5 UI smoke: the PTT-mode selector renders in Settings -> Input
// and round-trips through config.json (renderer -> settings:save -> disk ->
// settings:get). The toggle audio loop itself is the hardware gate (mic +
// whisper + ffmpeg), not exercised here. Needs vite dev on 5173; run from repo
// root.
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

const configPath = path.resolve("core", "config.json");
const readMode = () => {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"))?.pushToTalk?.mode ?? null;
  } catch {
    return null;
  }
};
const originalMode = readMode();

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

  await checkStep("Settings → Input shows the PTT mode selector with hold/toggle", async () => {
    await page.click(".codex-icon-btn.gear");
    await page.waitForSelector(".settings-modal", { timeout: 5000 });
    await page.click(".settings-tab-btn:has-text('Input')");
    await page.waitForSelector("text=Push-to-talk mode", { timeout: 5000 });
    const opts = await page.$$eval(".settings-tab-body select option", (os) =>
      os.map((o) => o.value)
    );
    for (const v of ["", "hold", "toggle"]) {
      if (!opts.includes(v)) throw new Error(`mode option "${v}" missing; got ${JSON.stringify(opts)}`);
    }
  });
  await page.screenshot({ path: path.join(SHOT_DIR, "m5-01-ptt-mode.png") });

  await checkStep("select toggle + Save writes pushToTalk.mode to config.json", async () => {
    const select = page.locator(".settings-tab-body select").first();
    await select.selectOption("toggle");
    await page.click(".settings-save-btn");
    await page.waitForTimeout(1200);
    if (readMode() !== "toggle") throw new Error(`config mode is ${readMode()}, expected toggle`);
  });

  await checkStep("reopen Settings: toggle persisted in the UI", async () => {
    await page.click(".settings-close");
    await page.waitForTimeout(300);
    await page.click(".codex-icon-btn.gear");
    await page.click(".settings-tab-btn:has-text('Input')");
    await page.waitForTimeout(300);
    const val = await page.locator(".settings-tab-body select").first().inputValue();
    if (val !== "toggle") throw new Error(`selector shows ${val}, expected toggle`);
  });
} finally {
  await app.close().catch(() => {});
  // Restore the original mode so the dev config is untouched by the smoke.
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.pushToTalk = { ...(cfg.pushToTalk ?? {}), mode: originalMode ?? "" };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  } catch {
    /* ignore */
  }
}

console.log(failures === 0 ? "\nM5 smoke ALL PASS" : `\nM5 smoke FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
