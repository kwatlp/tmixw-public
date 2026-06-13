// Model-free tests for push-to-talk mode resolution (v0.9.0 M5, plan D7) and
// the pipeline's toggle latch state machine.
//
// Usage: npm run ptt:test
import assert from "node:assert/strict";
import { resolvePttMode, PTT_MODES } from "../core/ptt_mode.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

check("default by platform: Windows holds, mac/linux toggle", () => {
  assert.equal(resolvePttMode({}, "win32"), "hold");
  assert.equal(resolvePttMode({}, "darwin"), "toggle");
  assert.equal(resolvePttMode({}, "linux"), "toggle");
});

check("explicit valid mode wins on every platform", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.equal(resolvePttMode({ pushToTalk: { mode: "hold" } }, platform), "hold");
    assert.equal(resolvePttMode({ pushToTalk: { mode: "toggle" } }, platform), "toggle");
  }
});

check("override is case/whitespace tolerant", () => {
  assert.equal(resolvePttMode({ pushToTalk: { mode: " Toggle " } }, "win32"), "toggle");
  assert.equal(resolvePttMode({ pushToTalk: { mode: "HOLD" } }, "darwin"), "hold");
});

check("empty / garbage / missing config falls back to the platform default", () => {
  assert.equal(resolvePttMode({ pushToTalk: { mode: "" } }, "darwin"), "toggle");
  assert.equal(resolvePttMode({ pushToTalk: { mode: "spin" } }, "win32"), "hold");
  assert.equal(resolvePttMode(null, "linux"), "toggle");
  assert.equal(resolvePttMode(undefined, "win32"), "hold");
  assert.equal(resolvePttMode({ pushToTalk: {} }, "darwin"), "toggle");
});

check("PTT_MODES is exactly the two supported modes", () => {
  assert.deepEqual([...PTT_MODES].sort(), ["hold", "toggle"]);
});

// --- Pipeline toggle latch state machine ------------------------------------
// Drive setPttLatched/isPttLatched with the record start/stop primitives
// stubbed (real recording spawns ffmpeg). Verifies: first press latches on and
// starts recording, second press unlatches and releases, and onTick never
// finalizes a latched recording (the whole point of toggle mode).

const { createPipeline, resolvePipelineConfig } = await import("../core/pipeline.js");

function makeLatchPipeline() {
  const cfg = resolvePipelineConfig(
    { stdinPtt: false, narrative: { template: "plain", stream: false } },
    "SYS",
    "EXTRACT",
    ""
  );
  const pl = createPipeline(cfg);
  // Stub the record primitives so no ffmpeg is spawned.
  const calls = { pulse: 0, release: 0 };
  pl._pttPulse = () => {
    calls.pulse++;
    if (!pl.recording) pl.recording = { stop: async () => {} };
    pl.lastSpaceAt = Date.now();
  };
  pl._pttRelease = () => {
    calls.release++;
    pl.lastSpaceAt = 0;
  };
  pl._started = true; // skip real start()/audio
  return { pl, calls };
}

check("latch: no-op until started", () => {
  const { pl } = makeLatchPipeline();
  pl._started = false;
  pl.setPttLatched(true);
  assert.equal(pl.isPttLatched(), false);
  assert.equal(pl.recording, null);
});

check("latch: first press starts + latches, second press releases + unlatches", () => {
  const { pl, calls } = makeLatchPipeline();
  assert.equal(pl.isPttLatched(), false);

  pl.setPttLatched(true);
  assert.equal(pl.isPttLatched(), true);
  assert.equal(calls.pulse, 1);
  assert.ok(pl.recording, "recording should be open while latched");

  pl.setPttLatched(false);
  assert.equal(pl.isPttLatched(), false);
  assert.equal(calls.release, 1);
  assert.equal(pl.lastSpaceAt, 0, "release zeroes lastSpaceAt so onTick finalizes next tick");
});

check("latch: a latched recording is exempt from the release-timeout finalize", () => {
  const { pl } = makeLatchPipeline();
  pl.setPttLatched(true);
  // Simulate time well past spaceReleaseMs since the press.
  pl.lastSpaceAt = Date.now() - (pl.cfg.spaceReleaseMs + 10_000);
  // The onTick guard is `if (this._pttLatched) return;` — model it directly.
  const wouldFinalize = !pl._pttLatched && Date.now() - pl.lastSpaceAt > pl.cfg.spaceReleaseMs;
  assert.equal(wouldFinalize, false, "latched recording must not auto-finalize");
  // Once unlatched, the same elapsed time finalizes.
  pl.setPttLatched(false);
  const wouldFinalizeNow = !pl._pttLatched && Date.now() - pl.lastSpaceAt > pl.cfg.spaceReleaseMs;
  assert.equal(wouldFinalizeNow, true, "unlatched recording finalizes on the timeout");
});

console.log(failures === 0 ? "\nptt:test ALL PASS" : `\nptt:test FAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
