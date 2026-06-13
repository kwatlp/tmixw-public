# tmíxʷ

A local, private, voice-driven solo RP narrator. Speak (or type) into an
ongoing story; a narrator AI answers in streamed prose while an extractor AI
silently maintains structured world state — characters, NPCs, quests,
locations, lore, and a hierarchical memory of the whole campaign. Everything
runs on your own machine. No cloud, no API keys, no telemetry.

A Kwatlp studio project. MIT licensed. Runs on Windows, macOS, and Linux.

**Current version: 0.9.0** (Worlds, Templates, Bestiary, Ports). Development is
planned against an internal roadmap; the docs kept in this public repo are the
ones useful to users and contributors (`docs/LICENSE_BOUNDARY.md`,
`docs/latency_budgets.md`, `docs/PLAYTEST.md`). Changing the code? See
[CONTRIBUTING.md](CONTRIBUTING.md).

## What it does (as of 0.9.0)

- **Multiple worlds (new in 0.9.0)** — keep separate campaigns side by side.
  Create, name, switch, rename, and delete worlds from a picker; each world is
  its own directory (state, session, memory). Deletes are recoverable from a
  trash folder. An existing single-world save migrates in automatically on
  first launch (backed up first).
- **Story templates (new in 0.9.0)** — start a new world from a genre starter
  instead of a blank slate. A template seeds NPCs, locations, lore, and an
  opening beat, and gives the narrator a campaign-specific voice. The bundled
  *Solterra: Guildblade* template ships a full GM bestiary that stays the
  narrator's secret reference, never the player's. Drop a folder in
  `templates/` to add your own.
- **Bestiary (new in 0.9.0)** — a fourth Codex tab: a field journal that fills
  in as you meet creatures, recording only what you've seen or been told —
  never the GM-side stat blocks or a monster's hidden weakness.
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
- **The Codex** — the left panel is player-lens tabs (STORY / CAST / WORLD,
  plus BESTIARY in 0.9.0) built from one shared, editable record card. Every
  value is click-to-edit with provenance (◆ co-author / ✎ you); AI-written
  entries land directly, flagged `◆ new` with Keep/Rewrite (untouched drafts
  auto-keep — never a review queue). Player groups (rename, delete,
  drag-and-drop), codex-wide live search with cross-tab match counts,
  collapse-to-rail, and inline narrative marker chips that jump to the entry
  the co-author just wrote.
- **Whole-story memory** — beats roll into scene and chapter summaries;
  pinned entries, vector retrieval, and a budgeted context assembler keep
  long campaigns in the narrator's head. Fully player-editable in the STORY
  tab's Chronicle (context-assembly debug now lives in Settings → Debug).
- **Voice HUD** — summonable panel with a live level meter, push-to-talk key
  rebinding, input-device picker, and a send-on-release toggle; the
  transcript lands for review or sends as the key lifts.
- **Narrative controls** — length presets, tone/POV/tense/content-rating
  style directives, freeform style notes, model-aware prompt templates
  (plain / ChatML / Llama 3 / Mistral, auto-detected).
- **Atmosphere** — per-location background art with crossfade, optional
  A1111/Forge endpoint for generating location art.
- **Backend freedom** — `core/inference/` abstraction with adapters for
  **KoboldCPP** (default, auto-launched), **llama.cpp server / any
  OpenAI-compatible server** (LM Studio, vLLM, …), **Ollama**, and a
  custom-endpoint escape hatch (non-streaming by design — replies arrive
  whole; streaming config silently degrades). Switch in Settings → Backend
  with validate-on-save; no restart. License boundary:
  [`docs/LICENSE_BOUNDARY.md`](docs/LICENSE_BOUNDARY.md).

## Quick start

You run two things: **tmíxʷ itself**, and a **local LLM backend** that it
talks to. tmíxʷ never ships a model or an LLM — you bring your own, and
everything stays on your machine.

### 1. Prerequisites

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
platform (NSIS on Windows, dmg/zip on macOS, AppImage/deb on Linux).

## Known issues

- **First-run setup on early 0.9.0 packaged builds.** An early 0.9.0 build
  could skip the first-run wizard on a clean machine. Current builds run the
  wizard normally on a fresh install. If an older build left you stuck with
  settings you didn't choose, reset with **Settings → Paths → Restart Setup
  Wizard**.

## Test suites

Model-free (no backend needed):

```powershell
npm run acceptance:test    # turn pipeline: pending/acceptance, streaming, controls
npm run inference:test     # backend adapters (request shaping, stream parsing)
npm run templates:test     # prompt template renderers + detection
npm run context:test       # budgeted context assembler
npm run memory:test        # hierarchical story memory
npm run imagegen:test      # A1111 adapter
npm run fixtures:test      # extractor merge fixtures
npm run worlds:test        # multi-world store: path seam, registry, legacy save migration
npm run story_templates:test # story-template loader: validation, discovery, apply, GM context
npm run ptt:test           # push-to-talk mode resolution + toggle latch
```

`npm test` runs all of the above in sequence (the CI matrix gate on
Windows/macOS/Linux).

Live (backend running):

```powershell
npm run evals:run          # extractor accuracy gate — required before any extractor change
npm run narrative:ab       # blind A/B harness for narrator prompt changes
```

Latency expectations per hardware tier: [`docs/latency_budgets.md`](docs/latency_budgets.md).

## Repository map

- `core/` — pipeline, world state, multi-world store (`worlds.js`,
  `app_paths.js`), story-template loader (`story_templates.js`), memory,
  context assembly, prompt templates, `inference/` (backend adapters), `stt/`
  (speech-to-text adapters)
- `electron/` — main process + preload (the only IPC surface)
- `renderer/` — React UI (Vite); the Codex lives in `components/codex/`
- `prompts/` — narrator / extractor / summarizer system prompts
- `templates/` — bundled story templates (manifest schema + Solterra starter)
- `fixtures/` — extractor eval fixtures + narrative A/B scenarios
- `scripts/` — test suites and harnesses
- `docs/` — license boundary, latency budgets, playtest guide

## Built with

- [KoboldCPP](https://github.com/LostRuins/koboldcpp) / [llama.cpp](https://github.com/ggml-org/llama.cpp) / [Ollama](https://ollama.com) — local LLM inference (user-supplied, out-of-process)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local speech-to-text
- [@xenova/transformers](https://github.com/xenova/transformers.js) — local embeddings (MiniLM)
- Electron + React + Vite, Node.js (ES modules)
