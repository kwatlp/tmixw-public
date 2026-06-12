# tmíxʷ

A local, private, voice-driven solo RP narrator. Speak (or type) into an
ongoing story; a narrator AI answers in streamed prose while an extractor AI
silently maintains structured world state — characters, NPCs, quests,
locations, lore, and a hierarchical memory of the whole campaign. Everything
runs on your own machine. No cloud, no API keys, no telemetry.

A Kwatlp studio project. MIT licensed.

**Current version: 0.8.4** (the Codex — UI redesign). Development is
planned against an internal roadmap; the docs kept in this public repo are
the ones useful to users and contributors (`docs/LICENSE_BOUNDARY.md`,
`docs/latency_budgets.md`, `docs/PLAYTEST.md`).

## What it does (as of 0.8.4)

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
- **The Codex (new in 0.8.4)** — the left panel is three player-lens tabs
  (STORY / CAST / WORLD) built from one shared, editable record card. Every
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
- **Voice HUD (new in 0.8.4)** — summonable panel with a live level meter,
  push-to-talk key rebinding, input-device picker, and a send-on-release
  toggle; the transcript lands for review or sends as the key lifts.
- **Narrative controls** — length presets, tone/POV/tense/content-rating
  style directives, freeform style notes, model-aware prompt templates
  (plain / ChatML / Llama 3 / Mistral, auto-detected).
- **Atmosphere** — per-location background art with crossfade, optional
  A1111/Forge endpoint for generating location art.
- **Backend freedom (new in 0.8.0)** — `core/inference/` abstraction with
  adapters for **KoboldCPP** (default, auto-launched), **llama.cpp server /
  any OpenAI-compatible server** (LM Studio, vLLM, …), **Ollama**, and a
  custom-endpoint escape hatch (non-streaming by design — replies arrive
  whole; streaming config silently degrades). Switch in Settings → Backend
  with validate-on-save; no restart. License boundary:
  [`docs/LICENSE_BOUNDARY.md`](docs/LICENSE_BOUNDARY.md).

## Quick start (dev)

Prereqs: Node 18+, a local LLM backend (KoboldCPP with a 7B-class GGUF is
the tested default — Mistral 7B Instruct Q4_K_M recommended), whisper.cpp
binary + model for voice, FFmpeg on PATH for mic capture.

```powershell
npm install
npm run electron:dev
```

First run opens a setup wizard (mic, model, paths) and writes
`core/config.json` (packaged builds: `%AppData%\Roaming\tmixw\core\`).
`core/config.example.json` documents the full config surface, including the
`inference` block for non-KoboldCPP backends.

Packaged build: `npm run electron:build` (artifacts under `release/`).

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
```

Live (backend running):

```powershell
npm run evals:run          # extractor accuracy gate — required before any extractor change
npm run narrative:ab       # blind A/B harness for narrator prompt changes
```

Latency expectations per hardware tier: [`docs/latency_budgets.md`](docs/latency_budgets.md).

## Repository map

- `core/` — pipeline, world state, memory, context assembly, templates,
  `inference/` (backend adapters), `stt/` (speech-to-text adapters)
- `electron/` — main process + preload (the only IPC surface)
- `renderer/` — React UI (Vite)
- `prompts/` — narrator / extractor / summarizer system prompts
- `fixtures/` — extractor eval fixtures + narrative A/B scenarios
- `scripts/` — test suites and harnesses
- `docs/` — license boundary, latency budgets, playtest guide

## Built with

- [KoboldCPP](https://github.com/LostRuins/koboldcpp) / [llama.cpp](https://github.com/ggml-org/llama.cpp) / [Ollama](https://ollama.com) — local LLM inference (user-supplied, out-of-process)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local speech-to-text
- [@xenova/transformers](https://github.com/xenova/transformers.js) — local embeddings (MiniLM)
- Electron + React + Vite, Node.js (ES modules)
