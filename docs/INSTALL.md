# Installing & running tmíxʷ (Windows · macOS)

A platform-by-platform guide for **testers and contributors**. It covers two
paths:

- **A. Install a packaged build** — grab an installer, double-click, play. No
  Node, no toolchain.
- **B. Run / build from source** — for contributors who want to change code or
  produce installers themselves.

Whichever path you take, you also need a **local LLM backend** (you bring your
own model — tmíxʷ never ships one). That's covered in
[§3](#3-the-llm-backend-required-on-every-platform) and applies to every
platform.

> Current version: **0.9.1**. Builds are **Apple Silicon (arm64) only** on
> macOS and **x64** on Windows. Minimum OS: Windows 10/11 64-bit · macOS 13+.
> Full requirements: [`HARDWARE.md`](HARDWARE.md).

---

## 1. Quick decision

| You want to… | Use path | Section |
|---|---|---|
| Just test the app as a player | **A — packaged build** | [§2](#2-path-a--install-a-packaged-build) |
| Change code, run tests, or cut a release | **B — from source** | [§4](#4-path-b--run--build-from-source) |

Both paths still require the LLM backend in [§3](#3-the-llm-backend-required-on-every-platform).

---

## 2. Path A — install a packaged build

### Where the builds are

Windows installers are checked into [`release/`](../release) (e.g.
`tmixw Setup 0.9.1.exe`). macOS `dmg`/`zip` artifacts are produced by a signed
local Mac build (see [§4](#4-path-b--run--build-from-source)); if you don't have
one, ask the maintainer for the current `.dmg` or build it yourself.

### Windows (x64)

1. Download `tmixw Setup 0.9.1.exe` from `release/`.
2. Double-click it. The build is **code-signed (Publisher: Brennen Kennedy)**,
   so it should install without a SmartScreen warning. If an **older, unsigned**
   build does trip SmartScreen, click **More info → Run anyway**.
3. The NSIS installer drops a Start-menu / desktop shortcut. Launch **tmíxʷ**.
4. Continue to the [first-run wizard](#5-first-run-wizard-all-platforms).

User data (config, worlds) lives at `%AppData%\Roaming\tmixw\core\`.

### macOS (Apple Silicon only)

1. Get the arm64 `tmixw-0.9.1-arm64.dmg` (or `.zip`).
2. Open the DMG and drag **tmíxʷ** to **Applications**.
3. The shipped build is **signed and notarized (Developer ID)**, so it opens
   with **zero Gatekeeper friction** — no right-click → Open workaround needed.
   (If you were ever handed an *unsigned* dev artifact, that one would need
   right-click → **Open** the first time. The official build does not.)
4. Launch it. On first voice use, macOS prompts for **microphone** access,
   attributed to tmíxʷ — click **Allow** (or skip and just type).
5. Continue to the [first-run wizard](#5-first-run-wizard-all-platforms).

> **No Intel-Mac build exists.** 7B local inference is marginal on Intel, so
> only arm64 (M1 or newer) is produced. On an Intel Mac, use the
> run-from-source path and expect degraded performance.

> **macOS speech-to-text caveat:** there's no bundled arm64 `whisper-cli` yet.
> If voice transcription can't find a binary, install it with
> `brew install whisper-cpp` — tmíxʷ resolves it from your `PATH`. Typed play
> works without it.

---

## 3. The LLM backend (required on every platform)

tmíxʷ talks to a **local, OpenAI-compatible LLM server** that you run yourself.
Nothing leaves your machine.

- **Tested default: [KoboldCPP](https://github.com/LostRuins/koboldcpp)**
  loaded with a 7B-class GGUF —
  [Mistral 7B Instruct Q4_K_M](https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF)
  is the recommended starting model (~4.4 GB).
- Streaming is verified against **KoboldCPP 1.112.2**
  (`/api/extra/generate/stream`). Much older builds may not stream — update if
  narration arrives all-at-once or validate-on-save fails.
- [llama.cpp server](https://github.com/ggml-org/llama.cpp),
  [Ollama](https://ollama.com), or any other OpenAI-compatible server also
  works — you pick the backend in the wizard.

**Pick the right KoboldCPP build for your GPU** (the #1 cause of "it's slow"):

| Hardware | Build |
|---|---|
| NVIDIA | default CUDA `koboldcpp.exe` |
| Intel Arc / AMD | the **Vulkan** build (CUDA silently falls back to CPU on these) |
| No discrete GPU | CPU-only is fine on 16 GB+ RAM, just slower |
| macOS arm64 | `koboldcpp-mac-arm64` |

Keep `contextsize` at or under the model's native window (**4096** for the
recommended Mistral 7B) — going higher makes KoboldCPP error or truncate and
inflates time-to-first-token. See [`HARDWARE.md`](HARDWARE.md) for sizing.

---

## 4. Path B — run / build from source

For contributors. Requires **Node.js 18+** (`node -v`; Node 16 or earlier fails
the ESM/native steps).

```bash
git clone <repo>
cd tmixw
npm install
npm run electron:dev      # launches Vite + Electron in dev mode
```

### Build installers for your current platform

```bash
npm run electron:build
```

`electron-builder` writes installers to `release/` **for the OS you run it on**
— you cannot cross-build Windows installers on a Mac or vice-versa:

- **Windows** → NSIS `.exe` (x64). Signing uses `build/azure-sign.cjs`; set
  `TMIXW_SKIP_WIN_SIGN=1` (as `electron:build:dir` does) to skip signing for a
  local unsigned `--dir` build.
- **macOS** → `dmg` + `zip` (arm64). Unsigned by default
  (`CSC_IDENTITY_AUTO_DISCOVERY=false`). To produce the signed + notarized
  build, follow [`macos_signing.md`](macos_signing.md): import the Developer ID
  cert, export `APPLE_TEAM_ID` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD`,
  `unset CSC_IDENTITY_AUTO_DISCOVERY`, then `npm run electron:build`. It signs,
  notarizes, staples, and re-signs the nested ffmpeg/whisper-cli binaries
  automatically.

Verify a Mac build:

```sh
spctl -a -vvv "release/mac-arm64/tmixw.app"   # expect: accepted, Developer ID
```

### Run the test suites

```bash
npm test          # full suite (fixtures, acceptance, engine, ptt, tts, memory, …)
```

---

## 5. First-run wizard (all platforms)

On first launch the wizard walks you through, in order:

1. **Microphone** — pick your input device (or skip; you can type).
2. **FFmpeg** — auto-downloaded on Windows; on macOS use `brew install ffmpeg`.
   Without it, voice capture fails but typed play still works.
3. **Whisper model** — downloaded for you, or point at your own.
4. **LLM backend & model** — choose KoboldCPP / llama.cpp / Ollama and your
   GGUF, then validate the connection.

It writes `core/config.json` (in packaged builds, under the per-user data dir —
`%AppData%\Roaming\tmixw\core\` on Windows, the equivalent on macOS). Every
option is documented in [`config.example.json`](../config.example.json).

Re-run it any time from **Settings → Paths → Restart Setup Wizard** (preserves
FFmpeg/Whisper/backend paths but clears saved worlds — back up first).

### Your first session

A blank "My World" is created. Hold the push-to-talk key (**backtick** by
default) and speak, or type in the input box, to begin. The narrator streams
prose; the left-hand **Codex** fills with characters, places, and lore. For a
running start, open the **Worlds** picker (❖) → **New World** → the
*Solterra: Guildblade* template.

> **Push-to-talk on macOS:** defaults to **toggle** (press to start, press
> again to stop) rather than hold — macOS doesn't report key-release to a
> background window. Change it under **Settings → Input**.

---

## 6. Troubleshooting cheatsheet

| Symptom | Fix |
|---|---|
| Won't start from source | Node too old — use Node 18/20 LTS (`node -v`). |
| Narration arrives all at once | KoboldCPP too old — update to ≥ 1.112.2. |
| Generation is slow | Wrong KoboldCPP build — Vulkan for Intel Arc/AMD, CUDA for NVIDIA. |
| `whisper-cli` not found (Win) | Grab the latest [whisper.cpp](https://github.com/ggerganov/whisper.cpp/releases) zip; point the wizard at `whisper-cli.exe`. |
| Voice not working (macOS) | `brew install whisper-cpp` and `brew install ffmpeg`. |
| Rambling / malformed replies | Prompt template mis-detected — set it manually in Settings. |
| Windows SmartScreen warning | Only on unsigned/old builds — **More info → Run anyway**. |
| Booted past the wizard with stale paths | Old 0.9.0 beta bug — **Settings → Paths → Restart Setup Wizard**. |

See the README's *Common version & setup issues* section for the long-form
versions of each.
