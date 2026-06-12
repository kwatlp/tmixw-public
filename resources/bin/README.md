# Bundled Windows binaries (`resources/bin/`)

These files are **not committed to git** (see repo `.gitignore`). As of v0.2.0+, **no binaries are required for the build** — all three external binaries (FFmpeg, whisper-cli, KoboldCPP) are provisioned by the first-run wizard. Place binaries here only for **dev convenience** (runtime resolution still checks this folder as a fallback in unpackaged dev runs).

**Binaries placed here are NOT shipped** (fixed 2026-06-12): the `extraResources` filter in `package.json` copies only this README into the packaged app's `bin/`, so dev-convenience files stay on your machine. (Builds ≤ 0.8.4 leaked the full whisper.cpp release payload into the installer; `scripts/check-phase4-resources.js` now warns at build time as a regression guard.) Packaged runtime resolution is `process.resourcesPath/bin/` (effectively empty) → `<userData>/bin/` (wizard-provisioned) → PATH, per `core/bin_paths.js`.

## Distribution (v0.2.0+)

Ships as an **NSIS installer + portable zip** from `npm run electron:build`. No bundled binaries are required. The first-run wizard handles all external dependencies:

- **FFmpeg** — detected on PATH or downloaded on Windows
- **whisper-cli** — detected on PATH or user browses for their own build
- **Whisper model** — user picks size (Medium/Small/Base), wizard downloads from Hugging Face to `<userData>/models/`
- **KoboldCPP** — detected on PATH or user browses for their GPU-specific build
- **GGUF model** — user selects via file picker (or uses a bundled model if present under `models/`)

## Layout

| File | Purpose |
|------|---------|
| `ffmpeg.exe` | DirectShow listing + mic capture. **Not bundled** — wizard detects PATH or downloads to `<userData>/bin/`. Placed here only for dev convenience. |
| `whisper-cli.exe` | whisper.cpp CLI transcribe. **Not bundled** — wizard detects PATH or user browses for their own build. Placed here only for dev convenience. |
| `koboldcpp.exe` | KoboldCpp Windows binary (managed by Electron main; port **5001**). **Not bundled** — wizard detects PATH or user browses for their own build. Placed here only for dev convenience. |
| `models/` (optional) | Place a default `*.gguf` here to skip the model picker in the first-run wizard. |

## Whisper model (wizard-downloaded)

The Whisper model (`ggml-medium.bin`, `ggml-small.bin`, or `ggml-base.bin`) is **not bundled**. The first-run wizard presents three options (Medium ~1.5 GB / Small ~466 MB / Base ~142 MB) and downloads the chosen model from Hugging Face to `<userData>/models/<filename>`. The model path is written to `config.json` and resolved by `core/bin_paths.js` at runtime.

If you need a model in dev without running the wizard, place it in `resources/bin/` — `bin_paths.js` still checks there as a fallback.

## Where to download (tested stack)

Versions move quickly; the following were **smoke-tested** against this repo's pipeline (Windows 10/11, 2025-2026). Prefer the **latest stable** matching your hardware; if a link 404s, use the project's releases page.

### FFmpeg

- **Source:** [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/) (full build) or [BtbN ffmpeg-builds](https://github.com/BtbN/FFmpeg-Builds/releases).
- **Dev placement:** `resources/bin/ffmpeg.exe` (extract `bin/ffmpeg.exe` from the downloaded archive).

### whisper.cpp CLI (wizard-provisioned)

As of v0.2.0, whisper-cli is **not bundled**. The first-run wizard detects `whisper-cli` on PATH or prompts the user to download and browse for their own build.

- **Source:** [ggerganov/whisper.cpp releases](https://github.com/ggerganov/whisper.cpp/releases) — Windows `whisper-cli.exe`.
- **Weights:** Downloaded automatically by the wizard. Manual download: `ggml-medium.bin` / `ggml-small.bin` / `ggml-base.bin` from [huggingface.co/ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp/tree/main).

### KoboldCpp (wizard-provisioned)

As of v0.2.0, KoboldCPP is **not bundled**. The first-run wizard detects `koboldcpp` on PATH or prompts the user to download and browse for their own build. Multiple variants exist (CUDA, OpenCL, Vulkan, CPU-only), so auto-download is not appropriate — the user must choose the right build for their GPU.

- **Source:** [LostRuins/koboldcpp releases](https://github.com/LostRuins/koboldcpp/releases)
- **Windows:** `koboldcpp.exe` (CUDA/CL/CPU variant per your machine). The wizard writes the selected path to `config.json` under `koboldBin`.
- **macOS / Linux:** Download the release binary or build from source. Ensure it's on PATH or select via the wizard.

If you need KoboldCPP in dev without running the wizard, place it in `resources/bin/` — `bin_paths.js` still checks there as a fallback.

### Optional bundled GGUF

- Put one or more `*.gguf` files under `resources/bin/models/`. The app picks the **first** name sorted lexicographically if multiple exist.
- Ships **user-selected** GGUF via the wizard unless this folder is populated.

## Main-process debug log (packaged builds)

Launching **`tmixw.exe` from PowerShell does not show `console.log` from the main process.** To capture **`[main]`**, **`[ptt]`**, and **`[pipeline]`** lines to a file:

1. Set env **`TMIXW_DEBUG=1`** before starting the app, **or**
2. Set **`"debug": true`** in `%AppData%\Roaming\tmixw\core\config.json` (after the wizard has run once).

Logs append to **`%AppData%\Roaming\tmixw\tmixw-main.log`** via **`electron-log`** ( **`console.*`** is mirrored to that file only when one of the above is set).

## Legal / size note

Binaries and models are third-party artifacts. You are responsible for complying with their licenses and for the download sizes when including a typical 7B-12B GGUF for local testing.
