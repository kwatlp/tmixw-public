# tmíxʷ — Story Templates

Bundled, genre-flavored world starters. A template pre-populates a fresh world
with its lore, locations, NPCs, an opening beat, and a narrator voice, so a new
campaign begins already on-rails instead of from an empty `world_state.json`.

This is the home of the **Story Templates / Genre Starters** feature described
in [`docs/FEATURE_CREEP.md`](../docs/FEATURE_CREEP.md) §1. **The loader is not
built yet** — these files are the data and the contract, staged so the feature
can be wired up when its prerequisites (composable prompt structure ✓ in
v0.6.0; multi-world / save slots — still pending) land. Nothing here runs
automatically today.

## Layout

```
templates/
├─ README.md                     ← this file
├─ manifest.schema.json          ← JSON Schema for a template manifest (the loader contract)
└─ solterra-guildblade/          ← the first template
   ├─ template.json              ← the manifest: metadata + world seed + narrator config
   ├─ system_prompt.md           ← narrator system-prompt override (the Guildblade GM manual)
   └─ bestiary.gm.json           ← GM-ONLY monster stat blocks + scaling tables (reference, never shown to the player)
```

A template is one folder with a `template.json` validating against
`manifest.schema.json`, plus the files that manifest references.

## Seed → world_state mapping

When the loader exists, it merges `template.json`'s `seed` into a fresh
`world_state.json`. Each key targets one section, which fills one UI tab:

| `seed` key         | `world_state` section            | UI tab                |
|--------------------|----------------------------------|-----------------------|
| `character`        | `character` (`{}` → Forge fills) | Character             |
| `npcs`             | `npcs`                           | NPCs                  |
| `quests`           | `quests`                         | Quests                |
| `locations`        | `locations`                      | World                 |
| `current_location` | `current_location`               | (bg gallery / scene)  |
| `lorebook`         | `lorebook`                       | World / Lore drawer   |
| `session_beats`    | `session_beats`                  | Memory / Log          |
| `bestiary` ⚠️       | `bestiary` — **does not exist yet** | Bestiary — **new tab** |

The seed shapes deliberately match `core/world_state.js → defaultWorldState()`
and `applyExtractorDiff()` (e.g. NPCs are `{name, status, notes}`, lorebook is
`{title, content, keywords}`, beats are plain strings the loader wraps via
`makeSessionBeat`). So most of a template drops into the existing schema with no
code changes.

### Suggested loader contract

1. Validate `template.json` against `manifest.schema.json`.
2. Create/select a world (needs multi-world support — the real blocker).
3. Merge `seed.*` into that world's `world_state.json`; wrap `session_beats`
   strings into v3 beat objects.
4. Apply `narrator.systemPromptFile` to the narrative system prompt per
   `promptMode` (`override` for Guildblade), and merge `narrator.config` over
   `config.json.narrative`.
5. Load `gm.bestiaryFile` into **narrator reference context only** (pinned or
   retrieval) — never into player-facing state.
6. Hand off to onboarding per `onboarding.runAtStart`.

## The bestiary gap

The Guildblade material carries a real bestiary — 65 monster stat blocks plus
scaling, variant, and doctrine tables. tmíxʷ has **no bestiary concept today**:
not in `world_state.js`, not in any tab, and not tracked in
[`docs/TECH_DEBT_SESSION.md`](../docs/TECH_DEBT_SESSION.md). This template
splits it deliberately:

- **GM-only data → `bestiary.gm.json`.** Full stat blocks (VIT, Guard, Atk,
  Damage, Trait, Flaw, XP) and the scaling/variant tables. This is the
  narrator's reference, surfaced to the model as context — **never** written to
  `world_state` or shown in the UI. Knowing a monster's hidden Flaw is the
  GM's job; revealing it to the player as a UI readout would defeat the whole
  Gambit/Flaw loop the system is built on.

- **Player-facing data → `seed.bestiary` (empty `[]`).** A discovered-creature
  field journal the player fills *as they meet creatures* — what they've
  learned, traits they've seen, where they first met it. This is the **new
  section and new tab** the schema needs. Entry shape is defined in
  `manifest.schema.json → seed.bestiary.items`:

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

To make this template fully live, three things are needed beyond the template
loader itself:

1. Add a `bestiary: []` array to `defaultWorldState()` (and a schema-version
   bump + migration) in `core/world_state.js`.
2. Teach the extractor to append player-observed creature notes to it (and add
   it to `RESETTABLE_SECTIONS`).
3. Add a **Bestiary** tab in `renderer/components/tabs/` that reads
   `world.bestiary`, mirroring the existing tab pattern.

This gap is logged in `docs/FEATURE_CREEP.md` (Bestiary / Creature Field
Notes) so it doesn't get lost. It is intentionally **not** filed as a tech-debt
task — it's a new feature, not accrued debt.

## Adding another template

Copy `solterra-guildblade/`, rewrite `template.json` (new `id` = new folder
name), swap the `system_prompt.md`, and drop any `gm.*` reference files. Keep it
validating against `manifest.schema.json`.
