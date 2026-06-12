/**
 * Player-facing narrative length presets (roadmap v4, v0.4.0 item 2).
 * Single source of truth for the Settings dropdown, the InputBar quick control,
 * and resolvePipelineConfig. Interim narrative-quality fix — the full narrator
 * prompt overhaul is v0.6.0 by design.
 *
 * `antiEos` maps to KoboldCPP's `use_default_badwordsids` (bans the EOS token);
 * generation still terminates on stop_sequence / max_length.
 */
export const LENGTH_PRESETS = {
  brief: {
    label: "Brief",
    max_length: 120,
    directive: "Style: reply in 1-2 tight paragraphs. Resolve the beat and stop."
  },
  standard: {
    label: "Standard",
    max_length: 220,
    directive: ""
  },
  rich: {
    label: "Rich",
    max_length: 400,
    directive:
      "Style: write 3-4 paragraphs with sensory and environmental detail."
  },
  sprawling: {
    label: "Sprawling",
    max_length: 700,
    directive:
      "Style: write an expansive, multi-paragraph scene. Linger on atmosphere, NPC reactions, and consequences before yielding the turn.",
    antiEos: true
  }
};

export const LENGTH_PRESET_ORDER = ["brief", "standard", "rich", "sprawling"];

/** "custom" preserves the user's own slider values; anything unknown falls back to standard. */
export function normalizeLengthPreset(value) {
  const v = String(value ?? "").trim();
  if (v === "custom" || v in LENGTH_PRESETS) return v;
  return "standard";
}
