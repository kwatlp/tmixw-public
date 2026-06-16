# tmíxʷ

A local, private, voice-driven solo RP narrator. Speak (or type) into an
ongoing story; a narrator AI answers in streamed prose while an extractor AI
silently maintains structured world state — characters, NPCs, quests,
locations, lore, and a hierarchical memory of the whole campaign. Everything
runs on your own machine. No cloud, no API keys, no telemetry.

A Kwatlp studio project. MIT licensed. Runs on Windows, macOS, and Linux.

**Current version: 0.9.1** (interaction engine, character creation, audio).
Development is planned against an internal roadmap; the docs kept in this
public repo are the ones useful to users and contributors —
[`docs/INSTALL.md`](docs/INSTALL.md), [`docs/HARDWARE.md`](docs/HARDWARE.md),
[`docs/LICENSE_BOUNDARY.md`](docs/LICENSE_BOUNDARY.md),
[`docs/latency_budgets.md`](docs/latency_budgets.md), and
[`docs/PLAYTEST.md`](docs/PLAYTEST.md). Changing the code? See
[CONTRIBUTING.md](CONTRIBUTING.md).

## What it does (as of 0.9.1)

- **Interaction engine (new in 0.9.1)** — opt-in tabletop mechanics resolved
  app-side, not improvised by the model: a referee intent pass reads what you
  attempt, dice checks and deterministic combat resolve against rules and a
  seeded RNG, and the narrator is handed the *outcome* to describe rather than
  left to invent it. Mechanics never leak into the prose, and resolved results
  don't get re-litigated on Continue.
- **Character creation (new in 0.9.1)** — an app-owned forge builds your
  player character from a short freeform description (one graded LLM step),
  then hands a finished sheet to the narrator to open the story. A dedicated
  read-only CHARACTER tab in the Codex shows the sheet.
- **Audio (new in 0.9.1)** — an optional background-music layer (a default
  ambient track ships; point it at your own) and **narration text-to-speech**
  so the narrator can read its prose aloud as it streams.
- **Message completion indicator (new in 0.9.1)** — a per-message "fin" marker
  so you can tell at a glance when a streamed response has finished.
- **Multiple worlds (0.9.0)** — keep separate campaigns side by side. Create,
  name, switch, rename, and delete worlds from a picker; each world is its own
  directory (state, session, memory). Deletes are recoverable from a trash
  folder. An existing single-world save migrates in automatically on first
  launch (backed up first).
- **Story templates (0.9.0)** — start a new world from a genre starter instead
  of a blank slate. A template seeds NPCs, locations, lore, and an opening
  beat, and gives the narrator a campaign-specific voice. The bundled
  *Solterra: Guildblade* template ships a full GM bestiary that stays the
  narrator's secret reference, never the player's. Drop a folder in
  `templates/` to add your own.
- **Bestiary (0.9.0)** — a Codex tab that fills in as you meet creatures,
  recording only what you've seen or been told — never the GM-side stat blocks
  or a monster's hidden weakness.
- **Dual-layer pipeline** — the core design: a Narrative AI answers in
  character; an Extractor AI turns each accepted exchange into world-state
  JSON (player character, NPCs, quests, locations, current location, lore,
  session beats). The extractor fires on *acceptance*, so regenerating a
  response never pollutes the world.
- **Voice in** — push-to-talk (backtick) → FFmpeg capture → whisper.cpp →
  editable input field. Pluggable STT backends.
- **Streaming narration** — tokens render as they generate (TTFT ~1s on a
  7B); a Stop button keeps the partial. Per-response controls: Redo,
  Continue, Rewrite-with-instruction, Keep.
- **The Codex (0.8.4)** — the left panel is player-lens tabs (STORY / CAST /
  WORLD, plus BESTIARY and CHARACTER) built from one shared, editable record
  card. Every value is click-to-edit with provenance (◆ co-author / ✎ you);
  AI-written entries land directly, flagged `◆ new` with Keep/Rewrite
  (untouched drafts auto-keep — never a review queue). Player groups (rename,
  delete, drag-and-drop), codex-wide live search with cross-tab match counts,
  collapse-to-rail, and inline narrative marker chips that jump to the entry
  the co-author just wrote.
- **Whole-story memory** — beats roll into scene and chapter summaries;
  pinned entries, vector retrieval, and a budgeted context assembler keep
  long campaigns in the narrator's head. Fully player-editable in the STORY
  tab's Chronicle (context-assembly debug lives in Settings → Debug).
- **Voice HUD (0.8.4)** — summonable panel with a live level meter,
  push-to-talk key rebinding, input-device picker, and a send-on-release
  toggle; the transcript lands for review or sends as the key lifts.
- **Narrative controls** — a soft target-length axis plus tone/POV/tense/
  content-rating style directives, freeform style notes, and model-aware
  prompt templates (plain / ChatML / Llama 3 / Mistral, auto-detected).
- **Atmosphere** — per-location background art with crossfade, optional
  A1111/Forge endpoint for generating location art.
- **Backend freedom (0.8.0)** — `core/inference/` abstraction with adapters
  for **KoboldCPP** (default, auto-launched), **llama.cpp server / any
  OpenAI-compatible server** (LM Studio, vLLM, …), **Ollama**, and a
  custom-endpoint escape hatch (non-streaming by design — replies arrive
  whole; streaming config silently degrades). Switch in Settings → Backend
  with validate-on-save; no restart. License boundary:
  [`docs/LICENSE_BOUNDARY.md`](docs/LICENSE_BOUNDARY.md).

## Quick start

You run two things: **tmíxʷ itself**, and a **local LLM backend** that it
talks to. tmíxʷ never ships a model or an LLM — you bring your own, and
everything stays on your machine.

> **Just want to install a build and play?** See the platform-by-platform
> guide in [`docs/INSTALL.md`](docs/INSTALL.md) (Windows & macOS — packaged
> installers and build-from-source). The steps below are the source workflow.

### 1. Prerequisites

For a full minimum/ideal breakdown by CPU, RAM, GPU/VRAM, disk, and platform,
see [`docs/HARDWARE.md`](docs/HARDWARE.md). The short version: a 7B Q4 model
runs on **16 GB RAM CPU-only** or **~6 GB+ VRAM** with GPU offload; 32 GB RAM
and 12–16 GB VRAM is the comfortable tier.

- **[Node.js](https://nodejs.org/) 18 or newer** — to run the app from source.
- **A local LLM backend.** The tested default is
  **[KoboldCPP](https://github.com/LostRuins/koboldcpp)** loaded with a
  7B-class GGUF model
  ([Mistral 7B Instruct Q4_K_M](https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF)
  is the recommended starting point). Any
  [llama.cpp server](https://github.com/ggml-org/llama.cpp),
  [Ollama](https://ollama.com), or other OpenAI-compatible server works too —
  pick one in the wizard.
- **Voice (optional but core).** The whisper.cpp binary is bundled; the wizard
  downloads the Whisper model and **[FFmpeg](https://ffmpeg.org/)** for you, or
  you can point it at your own. You can also just type instead of speaking.

### 2. Run it

```bash
npm install
npm run electron:dev
```

### 3. First-run wizard

The first launch walks you through, in order: pick your **microphone**, point
at (or download) **FFmpeg** and the **Whisper model**, choose your **LLM
backend** and model, and confirm. It writes `core/config.json` (in packaged
builds, `%AppData%\Roaming\tmixw\core\` on Windows and the equivalent
user-data dir on macOS/Linux). You can change any of it later in **Settings** —
or re-run the whole wizard from **Settings → Paths → Restart Setup Wizard** (it
preserves your FFmpeg/Whisper/backend paths but clears saved worlds, so back up
anything you want to keep first). `core/config.example.json` documents every
option.

### 4. Your first session

A blank "My World" is created for you. Hold the push-to-talk key (**backtick**
by default) and speak — or just type in the input box — to begin the story.
The narrator answers in streamed prose; as you play, the left-hand **Codex**
fills with the characters, places, and lore the story produces. Want a running
start instead of a blank page? Open the **Worlds** picker (the ❖ button), make
a **New World**, and choose the *Solterra: Guildblade* template.

> On macOS and Linux, push-to-talk defaults to **toggle** (press to start,
> press again to stop) rather than hold — those platforms don't report key
> release to a background window. Change it under Settings → Input.

### Packaged build

`npm run electron:build` produces installers under `release/` for your current
platform (NSIS on Windows, dmg/zip on macOS, AppImage/deb on Linux). See
[`docs/INSTALL.md`](docs/INSTALL.md) for the full build-from-source path.

## Test suites

Model-free (no backend needed):

```bash
npm run acceptance:test    # turn pipeline: pending/acceptance, streaming, controls
npm run inference:test     # backend adapters (request shaping, stream parsing)
npm run templates:test     # prompt template renderers + detection
npm run context:test       # budgeted context assembler
npm run memory:test        # hierarchical story memory
npm run engine:test        # interaction engine (checks, combat, referee)
npm run character:test     # character-creation forge
npm run imagegen:test      # A1111 adapter
npm run fixtures:test      # extractor merge fixtures
```

Live (backend running):

```bash
npm run evals:run          # extractor accuracy gate — required before any extractor change
npm run narrative:ab       # blind A/B harness for narrator prompt changes
```

Latency expectations per hardware tier: [`docs/latency_budgets.md`](docs/latency_budgets.md).

## Repository map

- `core/` — pipeline, world state, memory, context assembly, templates,
  `inference/` (backend adapters), `stt/` (speech-to-text adapters),
  `engine/` (interaction mechanics), `character/` (creation forge)
- `electron/` — main process + preload (the only IPC surface)
- `renderer/` — React UI (Vite)
- `prompts/` — narrator / extractor / summarizer system prompts
- `fixtures/` — extractor eval fixtures + narrative A/B scenarios
- `scripts/` — test suites and harnesses
- `docs/` — install guide, hardware requirements, license boundary, latency
  budgets, playtest guide

## Built with

- [KoboldCPP](https://github.com/LostRuins/koboldcpp) / [llama.cpp](https://github.com/ggml-org/llama.cpp) / [Ollama](https://ollama.com) — local LLM inference (user-supplied, out-of-process)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local speech-to-text
- [@xenova/transformers](https://github.com/xenova/transformers.js) — local embeddings (MiniLM)
- Electron + React + Vite, Node.js (ES modules)
