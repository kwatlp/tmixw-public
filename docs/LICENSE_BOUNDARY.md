# License boundary (v0.8.0)

tmíxʷ is MIT-licensed (see `LICENSE`). The roadmap's commercial sibling
(siséye) requires that nothing copyleft is linked into, bundled with, or
derived from this codebase. This file records where every external piece
sits relative to that boundary. Update it whenever a backend or bundled
binary changes.

## In-process (ships inside the app — must be MIT/Apache-class)

| Component | License | How it ships |
|---|---|---|
| Electron, React, Vite | MIT | npm dependencies |
| @xenova/transformers + all-MiniLM-L6-v2 | Apache-2.0 | npm dependency + model cache |
| koffi (Win32 keystate polling) | MIT | npm dependency |
| electron-log | MIT | npm dependency |
| whisper.cpp binaries (`resources/bin/`) | MIT | bundled, invoked as child processes |

## Out-of-process (user-supplied or user-run; spoken to over local HTTP or stdio)

| Component | License | Boundary |
|---|---|---|
| **KoboldCPP** | **AGPL-3.0** | **Never bundled or linked.** The user supplies their own binary (wizard "browse" / PATH); the app optionally spawns it as a separate process and communicates exclusively over local HTTP (`core/inference/koboldcpp.js`). No KoboldCPP code, headers, or assets exist in this repository or its distributables. |
| llama.cpp server | MIT | User-run server, HTTP only (`core/inference/openai_completions.js`) |
| Ollama | MIT | User-run server, HTTP only (`core/inference/ollama.js`) |
| Any OpenAI-compatible / custom endpoint | various | User-run, HTTP only (`openai_completions.js` / `custom.js`) |
| FFmpeg | LGPL/GPL (build-dependent; the wizard's download is a GPL build) | Never linked or bundled — user-supplied or wizard-downloaded to the user's data dir, invoked as a separate process for audio capture |
| A1111/Forge image endpoint (optional) | AGPL-3.0 (A1111) | User-run server, HTTP only (`core/imagegen.js`); feature is off without an endpoint |
| GGUF / Whisper / SD model weights | per-model | User's own files; never distributed |

## The rule

Process boundary + user-supplied binary + standard protocol (HTTP/stdio) =
the copyleft does not attach to this codebase. Concretely:

- Spawning the user's KoboldCPP binary with `--model …` and POSTing JSON to
  it is *use*, not linking or derivation.
- Distributing KoboldCPP (bundling the exe in the installer, downloading it
  on the user's behalf) would change the analysis — **do not add a
  KoboldCPP auto-download** without revisiting this document. (The wizard's
  FFmpeg download is acceptable: GPL attaches to FFmpeg itself, which we
  pass through unmodified to the user's machine, not to this app; but keep
  installs in the user data dir, never inside the app bundle.)
- The v0.8.0 inference abstraction (`core/inference/`) exists precisely so
  the default can move to an MIT backend (llama.cpp server) whenever that
  becomes operationally convenient — no architectural dependency on the
  AGPL component remains.
