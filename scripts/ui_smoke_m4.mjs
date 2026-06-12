// M4 smoke: group create (rename mode), rename, drag entry into group,
// persistence, empty-group delete. Throwaway dev tool.
import { _electron as electron } from "playwright-core";
import path from "node:path";

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

  // WORLD tab
  await page.evaluate(() => {
    [...document.querySelectorAll(".codex-tab")]
      .find((b) => b.textContent.trim() === "World")
      ?.click();
  });
  await page.waitForTimeout(300);

  // 1. + New group → rename input appears → name it
  await page.click(".cdx-new-group");
  await page.waitForSelector(".cdx-group-rename", { timeout: 5000 });
  await page.fill(".cdx-group-rename", "Smoke Lore");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const named = await page.evaluate(() =>
    [...document.querySelectorAll(".cdx-group-name")].map((e) => e.textContent)
  );
  console.log("groups after create+rename:", named);

  // 2. Drag the lore card into the new group (synthetic HTML5 DnD, spaced so
  // React state from dragstart lands before dragover/drop)
  const findTarget = `[...document.querySelectorAll(".cdx-group-header")].find((g) => g.textContent.toLowerCase().includes("smoke lore"))`;
  console.log(
    "dragstart:",
    await page.evaluate(() => {
      const header = document.querySelector(".cdx-card-header[draggable='true']");
      if (!header) return "no draggable header";
      header.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() })
      );
      return "ok";
    })
  );
  await page.waitForTimeout(300);
  console.log(
    "dragover:",
    await page.evaluate((expr) => {
      const target = eval(expr);
      if (!target) return "no target";
      target.dispatchEvent(
        new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
      );
      return "ok";
    }, findTarget)
  );
  await page.waitForTimeout(300);
  console.log(
    "drop:",
    await page.evaluate((expr) => {
      const target = eval(expr);
      if (!target) return "no target";
      target.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
      );
      document
        .querySelector(".cdx-card-header[draggable='true']")
        ?.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: new DataTransfer() }));
      return "ok";
    }, findTarget)
  );
  await page.waitForTimeout(600);

  const after = await page.evaluate(async () => {
    const w = await window.api.getWorld();
    return { membership: w.codex.membership, groups: w.codex.groups };
  });
  console.log("persisted:", JSON.stringify(after));

  // 3. Move it back and delete the (now empty) group
  const cleanup = await page.evaluate(async () => {
    const w = await window.api.getWorld();
    const gid = w.codex.groups.find((g) => g.name === "Smoke Lore")?.id;
    if (!gid) return "group missing";
    const entryId = Object.keys(w.codex.membership).find(
      (k) => w.codex.membership[k] === gid
    );
    if (entryId) await window.api.codexMoveEntry(entryId, "world:ungrouped", null);
    const del = await window.api.codexGroupDelete(gid);
    return JSON.stringify(del);
  });
  console.log("cleanup:", cleanup);
  const final = await page.evaluate(async () => {
    const w = await window.api.getWorld();
    return { membership: w.codex.membership, groups: w.codex.groups.length };
  });
  console.log("final:", JSON.stringify(final));
} finally {
  await app.close().catch(() => {});
}
