import React from "react";

/**
 * Per-message completion indicator (design doc 03). A whisper-quiet marker at
 * the bottom-right of each narrator message: did the reply end naturally, or
 * did it hit the length budget and stop mid-thought? Driven entirely by the
 * engine's `meta` ({ truncated, finishReason, tokenCount, maxTokens,
 * lengthPreset }) — never by parsing the prose.
 *
 * States: streaming (pulsing dot) → complete (a quiet fleuron, weighted by
 * length tier) · truncated (a "…continue?" nudge, clickable on the last
 * message) · aborted (you pressed Stop).
 */

const PRESET_TIER = { brief: 1, standard: 2, rich: 3, sprawling: 4 };

/** 1–4 weight for the complete glyph: prefer the preset, else token volume. */
function lengthTier(meta) {
  const p = meta?.lengthPreset;
  if (p && PRESET_TIER[p]) return PRESET_TIER[p];
  const t = Number(meta?.tokenCount) || 0;
  return t > 400 ? 4 : t > 220 ? 3 : t > 120 ? 2 : 1;
}

export default function MessageFin({ meta, streaming, busy, isLast }) {
  if (streaming) {
    return (
      <span className="msg-fin msg-fin-streaming" title="still writing…">
        <span className="pulse-dot" style={{ background: "var(--muted)" }} />
      </span>
    );
  }
  if (!meta) return null;

  if (meta.finishReason === "aborted") {
    return (
      <span className="msg-fin msg-fin-aborted" title="You stopped this — Continue or leave it">
        ■ stopped
      </span>
    );
  }

  if (meta.truncated) {
    const onContinue = () => {
      if (busy || !isLast) return;
      window.api.narrativeContinue().catch((err) => console.error("[MessageFin]", err));
    };
    return (
      <button
        type="button"
        className="msg-fin msg-fin-truncated"
        disabled={!isLast || busy}
        title={
          isLast
            ? "Cut off at the length limit — click to Continue"
            : "Cut off at the length limit"
        }
        onClick={onContinue}
      >
        …&nbsp;continue?
      </button>
    );
  }

  // Complete — a quiet fleuron, sized by how long the (finished) reply ran.
  return (
    <span
      className={`msg-fin msg-fin-complete tier-${lengthTier(meta)}`}
      title="Complete — the thought is finished"
      aria-label="complete"
    >
      ❧
    </span>
  );
}
