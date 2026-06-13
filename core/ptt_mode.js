// Push-to-talk interaction mode (v0.9.0 D7). Pure resolver so the platform
// default is testable model-free and shared between Electron main and tests.
//
// "hold"   — record while the key is held, finalize on release. Signature
//            interaction. Needs key-release detection: focused windows get it
//            from `before-input-event` (all platforms); unfocused windows
//            need a poll, which only Windows has (koffi/GetAsyncKeyState).
// "toggle" — first press starts recording, second press stops. The fallback
//            where no global key-release exists. Provisional on mac/linux —
//            revisit a real keyup path (native module / uiohook) post-0.9.0.

export const PTT_MODES = ["hold", "toggle"];

/**
 * Resolve the effective PTT mode: an explicit, valid `pushToTalk.mode` wins;
 * otherwise default by platform (Windows can do hold even unfocused, others
 * cannot, so they default to toggle).
 * @param {{ pushToTalk?: { mode?: string } } | null | undefined} cfg
 * @param {NodeJS.Platform} [platform]
 * @returns {"hold" | "toggle"}
 */
export function resolvePttMode(cfg, platform = process.platform) {
  const m = String(cfg?.pushToTalk?.mode ?? "").trim().toLowerCase();
  if (m === "hold" || m === "toggle") return m;
  return platform === "win32" ? "hold" : "toggle";
}
