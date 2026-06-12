/**
 * Style & voice controls (roadmap v4, v0.6.0 item 2; plan D4).
 * Presets are directives, not prompt forks: each non-default choice emits one
 * short line into the assembler's system block, exactly like the length
 * directive. Defaults emit nothing — the narrator system prompt's own
 * conventions (second person, present tense) are the baseline.
 *
 * Single source of truth for resolvePipelineConfig, the Settings → Narrative
 * section, and the InputBar quick control (renderer mirrors labels only).
 * Config location: `narrative.style = { tone, pov, tense, rating, notes }`.
 */
export const STYLE_PRESETS = {
  tone: {
    neutral: { label: "Neutral", directive: "" },
    grim: {
      label: "Grim",
      directive:
        "Tone: grim and weighty. Consequences are real, comfort is scarce, and victories cost something."
    },
    whimsical: {
      label: "Whimsical",
      directive:
        "Tone: light and whimsical, with playful humor and a sense of wonder."
    },
    heroic: {
      label: "Heroic",
      directive:
        "Tone: heroic high adventure — bold action, vivid stakes, momentum."
    },
    eerie: {
      label: "Eerie",
      directive:
        "Tone: eerie and unsettling. Let dread build quietly through detail and implication."
    }
  },
  pov: {
    second: { label: "Second person (you)", directive: "" },
    third: {
      label: "Third person",
      directive:
        "Point of view: narrate in the third person, following the player's character by name."
    }
  },
  tense: {
    present: { label: "Present tense", directive: "" },
    past: { label: "Past tense", directive: "Tense: narrate in the past tense." }
  },
  rating: {
    standard: { label: "Standard", directive: "" },
    family: {
      label: "Family-friendly",
      directive:
        "Content: keep it family-friendly — no gore, no sexual content, mild peril at most."
    },
    mature: {
      label: "Mature",
      directive:
        "Content: mature themes are allowed; violence and its costs may be depicted frankly, without gratuitous detail."
    }
  }
};

export const STYLE_AXES = ["tone", "pov", "tense", "rating"];

const STYLE_DEFAULTS = {
  tone: "neutral",
  pov: "second",
  tense: "present",
  rating: "standard"
};

/** Coerce a config `narrative.style` block to valid preset ids + notes string. */
export function normalizeStyle(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const axis of STYLE_AXES) {
    const v = String(r[axis] ?? "").trim();
    out[axis] = v in STYLE_PRESETS[axis] ? v : STYLE_DEFAULTS[axis];
  }
  out.notes = String(r.notes ?? "").trim();
  return out;
}

/**
 * Directive lines for the assembler's system block, in fixed axis order with
 * freeform notes last. Defaults contribute nothing, so an all-default style
 * keeps the prompt byte-identical to pre-v0.6.0.
 * @param {ReturnType<typeof normalizeStyle>} style
 * @returns {string[]}
 */
export function buildStyleDirectives(style) {
  const lines = [];
  for (const axis of STYLE_AXES) {
    const d = STYLE_PRESETS[axis][style[axis]]?.directive ?? "";
    if (d) lines.push(d);
  }
  if (style.notes) lines.push(`Style notes from the player: ${style.notes}`);
  return lines;
}
