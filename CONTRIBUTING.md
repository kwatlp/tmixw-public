# Contributing to tmíxʷ

tmíxʷ is a local, private, voice-driven solo-RP narrator (see the
[README](README.md) for what it does and how to run it). This document is for
people changing the code.

## Dev setup

```bash
git clone <repo>
cd tmixw
npm install
npm run electron:dev
```

`electron:dev` starts Vite and Electron together. First launch opens a setup
wizard that writes `core/config.json`.

### What the wizard handles vs. what you bring

The wizard can fetch some pieces for you and points you at the rest:

| Piece | Where it comes from |
|---|---|
| **whisper.cpp binary** | bundled in `resources/bin/` (invoked as a child process) |
| **Whisper model** (`ggml-*.bin`) | wizard download, or point it at your own file |
| **FFmpeg** (mic capture) | wizard download to your user-data dir, or supply on PATH |
| **LLM backend** (KoboldCPP / llama.cpp server / Ollama / OpenAI-compatible) | **you supply** — the wizard browses to your KoboldCPP binary or you run a server and give the URL |
| **GGUF model weights** | **you supply** — Mistral 7B Instruct Q4_K_M is the tested default |

The LLM backend and its model weights are always user-supplied — never
bundled or downloaded by the app. That separation is a license requirement,
not just a packaging choice (see *License boundary* below).

## Tests

All suites are **model-free** (no backend, no GPU, no network) and run in a
few seconds:

```bash
npm test          # runs every suite below in sequence — the PR gate
```

| Suite | Covers |
|---|---|
| `npm run fixtures:test` | extractor diff-apply + world-state migrations |
| `npm run acceptance:test` | turn pipeline: pending/acceptance, streaming, controls |
| `npm run worlds:test` | multi-world store: path seam, registry, legacy migration |
| `npm run story_templates:test` | story-template validation, discovery, apply, GM context |
| `npm run ptt:test` | push-to-talk mode resolution + toggle latch |
| `npm run templates:test` | prompt-template renderers + detection |
| `npm run context:test` | budgeted context assembler |
| `npm run memory:test` | hierarchical story memory |
| `npm run inference:test` | backend adapters (request shaping, stream parsing) |
| `npm run imagegen:test` | A1111 image adapter |

Two suites need a running backend and are **not** part of `npm test`:

- `npm run evals:run` — extractor accuracy gate. **Required before merging any
  change to the extractor prompt or `applyExtractorDiff`.**
- `npm run narrative:ab` — blind A/B harness for narrator-prompt changes.

CI (`.github/workflows/build.yml`) runs `npm test` + a renderer build +
`electron-builder --dir` on Windows, macOS, and Linux. CI does **not**
exercise the audio loop (mic capture, PTT, backend spawn) — that stays a
hands-on check on real hardware.

## Conventions enforced here

These are load-bearing, not style preferences:

- **No new npm dependencies without discussion.** The dependency list is
  deliberately tiny and license-screened. Prefer a hand-rolled solution; open
  an issue before adding a package.
- **IPC is `namespace:action`.** Every renderer↔main call goes through
  `electron/preload.cjs` (the only IPC surface) using names like
  `worlds:create`, `codex:editField`. No `nodeIntegration` in the renderer.
- **`_generate` / `_generateStream` are a test contract.** The pipeline's
  generation seams are overridden by the model-free suites. Keep them
  injectable; don't inline the backend call.
- **World-state schema changes require a migration + a version bump.** Bump
  `WORLD_STATE_SCHEMA_VERSION` in `core/world_state.js`, add a `schemaVersion <
  N` branch to `migrateWorldState()` (idempotent — a second run changes
  nothing), and add a `fixtures/extractor/migration_*.json` case. Migrations
  back up the file first.
- **The path seam is `core/app_paths.js`.** All world-scoped file access
  (`world_state.json`, `session.json`, `memory_vectors.json`) goes through its
  getters so multi-world resolution stays in one place. Don't build those
  paths from `getWritableCoreDir()` directly.
- **Honest verification.** If a change needs live or hands-on testing that you
  couldn't run, say so in the PR — don't imply a green model-free suite means
  the audio loop or a long campaign was verified.
- **Watch for line-ending churn and a truncated `.gitignore` (recurring).**
  Some editors re-save whole files with CRLF, producing diffs where every
  line shows as changed (e.g. `327 insertions(+), 327 deletions(-)` — equal
  counts are the tell) and, in at least one session, a `.gitignore`
  truncated mid-line to `# Personal edit` — which silently drops the
  `.cursor/` / `.claude/` / `core/config.packaged.starter.json` ignore rules
  and would re-commit personal tooling + machine-path config. Before
  staging, sanity-check `git diff --stat` (ignore equal-count files) and
  `git diff .gitignore`. A repo `.gitattributes` with `* text=auto eol=lf`
  is the durable fix.

## License boundary

tmíxʷ is MIT-licensed. Its commercial sibling (siséye) requires that nothing
copyleft is linked into, bundled with, or derived from this codebase. The
rule: **process boundary + user-supplied binary + standard protocol
(HTTP/stdio) = the copyleft does not attach.** Concretely, the app spawns the
user's own KoboldCPP (AGPL) binary and talks to it over local HTTP — that is
*use*, not derivation. **Do not add a KoboldCPP auto-download**, and don't
bundle any AGPL/GPL component, without reading and updating
[`docs/LICENSE_BOUNDARY.md`](docs/LICENSE_BOUNDARY.md) — the full table of
where every external piece sits.
