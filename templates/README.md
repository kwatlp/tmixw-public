# tmíxʷ — Story Templates

Bundled, genre-flavored world starters. A template pre-populates a fresh world
with its lore, locations, NPCs, an opening beat, and a narrator voice, so a new
campaign begins already on-rails instead of from an empty `world_state.json`.

This is the home of the **Story Templates / Genre Starters** feature.
**Shipped in v0.9.0.**
The loader lives in [`core/story_templates.js`](../core/story_templates.js)
(`discoverTemplates` / `validateManifest` / `applyTemplate` / `loadGmBestiary`);
its prerequisites — composable prompts (v0.6.0) and multi-world / save slots
(v0.9.0 M1–M2) — are both in. Templates are applied **at world creation only**
and are world-scoped by construction (global `config.json` is never touched).

Two surfaces apply a template:

- **First-time setup (FTUE).** Right after the setup wizard, the "pick your
  first story" screen (`renderer/components/Ftue.jsx`) showcases the discovered
  templates and applies the chosen one **in place** to the pristine first-run
  world (`worlds:applyTemplateToActive` in `electron/main.js`). Choosing a blank
  world is an equal, no-pressure option.
- **New World** in the Worlds picker (`renderer/components/WorldsModal.jsx` →
  `worlds:create`), reachable any time after setup.

On a templated world's **first session the narrator speaks first**: the pipeline
runs the `onboarding.firstMessageHint` as an unprompted opening turn (see
`LocalPipeline._kickoffOpening` / `_runOpeningTurn` in `core/pipeline.js`), so
the opening message gives the player everything they need to make a character
before they've said a word. It fires once per world, only while no narrator
reply is committed yet.

## Layout

```
templates/
├─ README.md                       ← this file
├─ manifest.schema.json            ← JSON Schema for a template manifest (the loader contract)
├─ character_creation.schema.json  ← JSON Schema for an app-forge creation spec (doc 01)
├─ rules.schema.json               ← JSON Schema for the interaction engine's rules tables (doc 02)
└─ solterra-guildblade/            ← the first template
   ├─ template.json                ← the manifest: metadata + world seed + narrator config
   ├─ system_prompt.md             ← narrator system-prompt override (the Guildblade GM manual)
   ├─ character_creation.json      ← app-forge creation spec (the worked example)
   ├─ rules.json                   ← deterministic rules tables (the machine-readable twin of §3–§4)
   └─ bestiary.gm.json             ← GM-ONLY monster stat blocks + scaling tables (reference + the engine's enemy source)
```

A template is one folder with a `template.json` validating against
`manifest.schema.json`, plus the files that manifest references.

## Seed → world_state mapping

The loader merges `template.json`'s `seed` into a fresh `world_state.json`. Each
key targets one section, which fills one UI tab:

| `seed` key         | `world_state` section            | UI tab                |
|--------------------|----------------------------------|-----------------------|
| `character`        | `character` (`{}` → Forge fills) | Character             |
| `npcs`             | `npcs`                           | NPCs                  |
| `quests`           | `quests`                         | Quests                |
| `locations`        | `locations`                      | World                 |
| `current_location` | `current_location`               | (bg gallery / scene)  |
| `lorebook`         | `lorebook`                       | World / Lore drawer   |
| `session_beats`    | `session_beats`                  | Memory / Log          |
| `bestiary`         | `bestiary` (schema v5, v0.9.0 M3) | Bestiary (Codex tab)  |

The seed shapes deliberately match `core/world_state.js → defaultWorldState()`
and `applyExtractorDiff()` (e.g. NPCs are `{name, status, notes}`, lorebook is
`{title, content, keywords}`, beats are plain strings the loader wraps via
`makeSessionBeat`). So most of a template drops into the existing schema with no
code changes.

### Loader contract (implemented)

As built in `core/story_templates.js` + the pipeline:

1. Validate `template.json` against `manifest.schema.json` (`validateManifest`,
   a hand-rolled mirror of the schema — no ajv).
2. Create the world (`worlds.createWorld`) — or, in the FTUE, reuse the pristine
   first-run world.
3. Merge `seed.*` into that world's `world_state.json`; wrap `session_beats`
   strings into beat objects via `makeSessionBeat` and stamp entry ids.
4. Resolve `narrator.systemPromptFile` per `promptMode` (`override` for
   Guildblade) and store it, plus the `narrator.config` merge, on the world's
   `world.json` — applied per boot in `electron/main.js`. Global `config.json`
   is never touched.
5. Copy `gm.bestiaryFile` into the world dir as `gm_bestiary.json` and load it
   into **narrator reference context only** (`loadGmBestiary`) — never into
   player-facing state.
6. Carry `onboarding` onto `world.json`; on the world's first session the
   pipeline runs an unprompted opening turn (`_kickoffOpening`). In the legacy
   **narrator-forge** mode that opening is `firstMessageHint` (welcome +
   Character Forge as prose). In **app-forge** mode (below) the opening is
   *deferred* until the in-app forge writes the sheet, then it confirms that
   sheet — see "Character creation".

## Character creation (the app forge)

A template may own its character creation as **data**, so the app — not the
narrator — collects every structured choice, does all the math deterministically,
and writes a `world_state.character` sheet. This fixes the failures a prose forge
hit (fabricated names, pre-rolled stats, truncation) and gives advanced authors a
creation flow with no code changes. Design: `docs/design/01-character-creation.md`.

Wire it from the manifest's `onboarding`:

```jsonc
"onboarding": {
  "characterCreationFile": "character_creation.json",  // the creation spec (this folder)
  "mode": "app-forge",                                 // app collects + confirms (vs "narrator-forge")
  "openingHint": "After the forge: welcome them, render STATUS from the exact numbers, open the first scene."
}
```

- **`character_creation.json`** — the creation spec. Contract:
  `templates/character_creation.schema.json`; the enforcing loader is
  `core/character/` (`spec.js` load, `validate.js`, `build.js`, `derive.js`).
  `solterra-guildblade/character_creation.json` is the worked example. Shape:
  - `steps[]` — one screen each, of `fields[]`. Field `type`s: `text`,
    `longtext`, `single-select` (option cards; an option's `effects` may carry
    `stat`/`statChoice`/`statChoiceSecondary`/`skillChoice`/`grantItems`/`coin`/
    `grants`, plus `subtypes`), `multi-select` (choose exactly `count`),
    `point-buy` (`pool`/`stats`/`min`/`max`), `freeform-graded` (the one LLM
    step — graded to a power band, see below).
  - `derived` — an **ordered** map of formula strings over the six stats, prior
    derived keys, and `armor`, evaluated by a **safe** parser (no `eval`;
    `+ - * / ( )`, `floor ceil round min max`). A later key may reference an
    earlier one. Unknown identifiers are rejected at load.
  - `start` — constants stamped onto the sheet (`rank`, `rankLabel`, `xp`,
    `coin`, `conditions`, and `resourcePools` — which derived keys become
    current/max pools; default `vitality`/`stamina`/`aether`).
- **The only model call** is grading `freeform-graded` fields (`grade.js`): a
  single constrained, low-temp JSON call to fit the player's free text to a power
  band. It retries once, then falls back to a deterministic Rank-E writeup — so
  creation never blocks on the backend.
- **Output:** a structured `world_state.character` with `createdBy: "app-forge"`.
  The codex shows it read-only in the **Character** tab. The narrator then runs
  the **app-forge handoff**: it is handed the finished sheet and `openingHint`
  and told to *confirm* it (exact numbers, no placeholders, no re-forging) rather
  than create it. A template that ships a `characterCreationFile` is treated as
  `app-forge` even if an older world's `world.json` predates the `mode` field.
- **Omit `characterCreationFile`** to keep the legacy narrator forge: the opening
  runs `firstMessageHint` and the model fills `character` via the extractor.

### Minimal example

The smallest valid spec — identity, a point-buy, one derived value, and a graded
power. Copy this into `character_creation.json`, set
`onboarding.characterCreationFile`/`mode`, and you have an app forge; grow it from
here (the Solterra file is the full-featured reference).

```jsonc
{
  "schemaVersion": 1,
  "title": "Create your character",
  "steps": [
    {
      "id": "identity",
      "fields": [{ "id": "name", "type": "text", "label": "Name", "required": true, "maxLen": 60 }]
    },
    {
      "id": "stats",
      "fields": [{
        "id": "stats", "type": "point-buy", "label": "Allocate 30 points",
        "pool": 30, "stats": ["BODY", "MIND", "SOUL"], "min": 1, "max": 15
      }]
    },
    {
      "id": "power",
      "fields": [{
        "id": "unique_power", "type": "freeform-graded", "required": true,
        "label": "Describe a knack", "grade": { "outputShape": "unique_power" }
      }]
    }
  ],
  "derived": { "health": "10 + 2*BODY", "focus": "5 + MIND + SOUL" },
  "start": { "rank": "I", "xp": { "current": 0, "max": 100 }, "resourcePools": ["health", "focus"] }
}
```

## The interaction engine (the rules)

Once a template owns its character sheet (above), it can also move every
**deterministic** system — dice, skill checks, damage, XP, currency, inventory,
combat — out of the narrator and into an auditable engine. The app rolls and
computes; the model only proposes intent and writes prose. The turn becomes
`INTENT → RESOLUTION (engine) → NARRATION (prose only) → COMMIT`. Design:
`docs/design/02-interaction-engine.md`. The engine is gated to **app-forge**
worlds (it reads doc 01's structured sheet), so a legacy/blank world is
byte-identical to before.

Wire it from the manifest's `gm` block:

```jsonc
"gm": {
  "rulesFile": "rules.json",        // deterministic tables (this folder)
  "bestiaryFile": "bestiary.gm.json" // also the engine's combat enemy source
}
```

- **`rules.json`** — the machine-readable twin of the narrator's resolution/combat
  prose. Contract: `templates/rules.schema.json`; the loader is
  `core/engine/rules.js` (`loadRules`). **Every field is optional** — anything you
  omit falls back to the engine's `DEFAULT_RULES`, so a partial file (or no
  `rulesFile` at all) still runs. `solterra-guildblade/rules.json` is the full
  worked example. Sections:
  - `resolution` — `die`, `dcByDifficulty` (label → DC), `rankBonus` (rank → flat
    bonus), `critOn` / `fumbleOn`. The check math: `d20 + stat + rankBonus` vs DC
    or enemy Guard.
  - `damage` — `dice` (weapon weight → die) and a human-readable `formula`; the
    engine uses `weaponDie + floor(stat/2)`.
  - `gambit` — `xpAward` and the `options` a plausible, creative action can earn
    (advantage / +1d6 / ignoreGuard / rider).
  - `currency` — `units` (largest→smallest) and `ratiosToBase` (each unit in the
    base unit) for coin normalization.
  - `progression` — `rankOrder`, `xpToNextByRank`, `awards`, and the `rankUp`
    payload (pool bumps, stat points, heal fraction) applied on a rank-up.
  - `rest` — `recoverFraction` per pool. `regenerateRerolls` — leave `false`
    (locked rolls are fairer; a regenerate re-narrates, it doesn't re-roll).
- **Combat reads the GM bestiary.** On the first attack the engine mints enemies
  from `gm.bestiaryFile`, so each combat-capable creature needs the numeric
  fields the engine consumes: `name`, `rank`, `vit`, `guard`, `atk`, `damage`
  (a dice expression like `1d8+4`), `xp`, and `typicalGroup` (the low end seeds
  pack size, capped at 3). `trait` / `flaw` stay **narrator flavor** — the engine
  never parses them (the Gambit/Flaw loop is fiction the GM runs). See "the
  bestiary split" below for why this file is GM-only.
- **The narrator prompt keeps its rules prose**, gated by an *Engine override*:
  whenever the app injects a `RESOLVED MECHANICS` block the model narrates the
  engine's outcome and prints no numbers (the interface renders them); with no
  block — a legacy world, or a pure-narration turn — the prose tables still apply.
  So one `system_prompt.md` serves both modes; `rules.json` is the engine's copy,
  the prose explains *feel*.

## The bestiary split (shipped v0.9.0 M3)

The Guildblade material carries a real bestiary — 65 monster stat blocks plus
scaling, variant, and doctrine tables. The original gap (no bestiary concept in
the schema) was closed in v0.9.0 M3: `defaultWorldState()` now has a
`bestiary: []` section (schema v5 + migration), the extractor appends
player-observed creatures, and there's a **Bestiary** Codex tab. This template
splits the data deliberately:

- **GM-only data → `bestiary.gm.json`.** Full stat blocks (VIT, Guard, Atk,
  Damage, Trait, Flaw, XP) and the scaling/variant tables. This is the
  narrator's reference, surfaced to the model as context — **never** written to
  `world_state` or shown in the UI. Knowing a monster's hidden Flaw is the
  GM's job; revealing it to the player as a UI readout would defeat the whole
  Gambit/Flaw loop the system is built on.

- **Player-facing data → `seed.bestiary` (empty `[]`).** A discovered-creature
  field journal the player fills *as they meet creatures* — what they've
  learned, traits they've seen, where they first met it. This is the `bestiary`
  section (schema v5) surfaced in the Bestiary Codex tab. Entry shape is defined
  in `manifest.schema.json → seed.bestiary.items`:

  ```json
  {
    "name": "Gnasher",
    "rank": "E",
    "discovered": true,
    "encounters": 1,
    "knownTraits": ["pack tactics"],
    "notes": "Mange-furred mine-hounds. Cowardly alone.",
    "firstSeen": "Day 1 · Emberreach Mine"
  }
  ```

All three pieces that made this template fully live shipped in v0.9.0 M3:

1. `bestiary: []` in `defaultWorldState()` (schema v5 + migration) in
   `core/world_state.js`.
2. The extractor appends player-observed creature notes (and `bestiary` is in
   `RESETTABLE_SECTIONS`).
3. A **Bestiary** Codex tab reading `world.bestiary`, mirroring the existing
   tab pattern.

## Adding another template

Copy `solterra-guildblade/`, rewrite `template.json` (new `id` = new folder
name), swap the `system_prompt.md`, and drop any `gm.*` reference files. Keep it
validating against `manifest.schema.json`.
