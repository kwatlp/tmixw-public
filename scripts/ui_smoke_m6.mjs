// M6 smoke: Voice HUD — toggle, meter presence, send-on-release toggle
// (config round-trip), PTT rebind to F13 and back, recording state via
// pttStart/pttEnd. Throwaway dev tool.
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
  await page.waitForSelector(".panel", { timeout: 20_000 });

  // Open the HUD via the input-bar toggle
  await page.evaluate(() => {
    [...document.querySelectorAll("button")]
      .find((b) => b.textContent.trim().startsWith("Voice"))
      ?.click();
  });
  await page.waitForSelector(".voice-hud", { timeout: 5000 });
  console.log(
    "hud:",
    await page.evaluate(() => ({
      bars: document.querySelectorAll(".voice-bar").length,
      keycap: document.querySelector(".voice-keycap")?.textContent,
      deviceOptions: document.querySelectorAll(".voice-device option").length,
      toggleOn: document.querySelector(".voice-toggle")?.classList.contains("on"),
      help: document.querySelector(".voice-help")?.textContent
    }))
  );

  // Send-on-release toggle round trip
  await page.click(".voice-toggle");
  await page.waitForTimeout(400);
  console.log("after toggle:", await page.evaluate(() => window.api.voiceGetConfig()));
  await page.click(".voice-toggle");
  await page.waitForTimeout(400);
  console.log("toggled back:", await page.evaluate(() => window.api.voiceGetConfig()));

  // PTT rebind to F13, then back to backtick
  console.log("rebind F13:", await page.evaluate(() => window.api.pttSetKey("F13")));
  console.log("rebind bad:", await page.evaluate(() => window.api.pttSetKey("KeyQ")));
  console.log("rebind back:", await page.evaluate(() => window.api.pttSetKey("Backquote")));

  // Recording state via the real PTT path (records silence briefly)
  await page.evaluate(() => window.api.pttStart());
  await page.waitForTimeout(900);
  const during = await page.evaluate(() => ({
    recording: !!document.querySelector(".voice-recording"),
    hearing: document.querySelector(".voice-hearing-text")?.textContent ?? null,
    liveBars: document.querySelectorAll(".voice-bar.live").length
  }));
  console.log("while recording:", JSON.stringify(during));
  const f = path.join(SHOT_DIR, "07-voice-hud-recording.png");
  await page.screenshot({ path: f });
  console.log("shot:", f);
  await page.evaluate(() => window.api.pttEnd());
  await page.waitForTimeout(4000);
  console.log(
    "after release:",
    await page.evaluate(() => ({
      recording: !!document.querySelector(".voice-recording"),
      heard: document.querySelector(".voice-hearing-text")?.textContent ?? null,
      input: document.querySelector("textarea")?.value ?? ""
    }))
  );
} finally {
  await app.close().catch(() => {});
}
