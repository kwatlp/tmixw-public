/**
 * Player-facing narrative length presets (roadmap v4, v0.4.0 item 2;
 * soft-target model, v0.9.1 design doc 06).
 *
 * Single source of truth for the Settings dropdown, the InputBar quick control,
 * and resolvePipelineConfig.
 *
 * Length is a **soft target**, not a fixed cap (design doc 06):
 *   - `target` is the size the narration *aims* for; the directive states it and
 *     tells the model it may stop early ("resolve and yield, shorter is fine").
 *   - `max_length` (the backend cap) is a *ceiling*, derived = target × headroom
 *     (see {@link LENGTH_HEADROOM}). It only catches runaway generations, so it
 *     is rarely hit — the message-fin indicator (doc 03) then reads "complete"
 *     far more often than under the old fixed-cap presets.
 *
 * This replaced the old fixed `max_length` ceilings + `antiEos` floor. `antiEos`
 * (KoboldCPP `use_default_badwordsids`, banning the EOS token) is gone from every
 * preset — it forced the model to fill the whole budget every turn (player
 * feedback e10, "Sprawl narrates for a very long time"). The directives now say
 * the inverse: don't pad, yield when the beat resolves.
 */

/** Ceiling = target × headroom. 1.5–1.7 is the doc-06 range; 1.6 is the start. */
export const LENGTH_HEADROOM = 1.6;
/** Clamp bounds for the derived ceiling, so neither tuning nor a custom target runs away. */
export const LENGTH_CEILING_MIN = 80;
export const LENGTH_CEILING_MAX = 1536;

/**
 * Build a soft-target directive from a prose description of the aimed size.
 * The "resolve and yield / shorter is fine / don't pad" clause is the inverse of
 * what `antiEos` used to enforce, and the e10 fix's whole point.
 */
export function softTargetDirective(aim) {
  return (
    `Length: aim for roughly ${aim}. Resolve the beat and yield the turn when ` +
    `it's done — don't pad to fill space; shorter is fine when the moment is small.`
  );
}

export const LENGTH_PRESETS = {
  brief: {
    label: "Brief",
    target: 120,
    aim: "1-2 tight paragraphs",
    directive: softTargetDirective("1-2 tight paragraphs")
  },
  standard: {
    label: "Standard",
    target: 220,
    aim: "2-3 paragraphs",
    directive: softTargetDirective("2-3 paragraphs")
  },
  rich: {
    label: "Rich",
    target: 400,
    aim: "3-4 paragraphs with sensory and environmental detail",
    directive: softTargetDirective(
      "3-4 paragraphs with sensory and environmental detail"
    )
  },
  sprawling: {
    label: "Sprawling",
    target: 700,
    aim: "an expansive, multi-paragraph scene",
    directive: softTargetDirective(
      "an expansive, multi-paragraph scene that lingers on atmosphere, NPC reactions, and consequences"
    )
  }
};

export const LENGTH_PRESET_ORDER = ["brief", "standard", "rich", "sprawling"];

/**
 * Derive the backend ceiling (`max_length`) from a target size.
 * Clamped to {@link LENGTH_CEILING_MIN}/{@link LENGTH_CEILING_MAX}. A non-finite
 * or non-positive target falls back to the max clamp (safety, never zero).
 */
export function deriveCeiling(target) {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return LENGTH_CEILING_MAX;
  return Math.min(
    LENGTH_CEILING_MAX,
    Math.max(LENGTH_CEILING_MIN, Math.round(t * LENGTH_HEADROOM))
  );
}

/** "custom" preserves the user's own slider values; anything unknown falls back to standard. */
export function normalizeLengthPreset(value) {
  const v = String(value ?? "").trim();
  if (v === "custom" || v in LENGTH_PRESETS) return v;
  return "standard";
}
