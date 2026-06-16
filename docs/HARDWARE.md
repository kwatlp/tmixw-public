# Hardware requirements

tmíxʷ runs entirely on your machine: an Electron desktop app, a local
speech-to-text pass (whisper.cpp), local embeddings (MiniLM), and — the heavy
part — a local LLM backend (KoboldCPP by default) running a 7B-class model.
The LLM is what your hardware needs to feed. Everything below is sized against
the **tested reference: a 7B model at Q4_K_M quantization (~4.4 GB) with a
4096-token context**, which is what the wizard recommends.

If you run a bigger model (13B, 70B) or a longer context, scale RAM/VRAM up
accordingly. If you run a smaller one (3B), you can go below the minimums here.

The single number that defines the experience is **time-to-first-token
(TTFT)** — the silence before the narrator starts typing. The budget is
**≤ 2 s** (typically ~1 s on the reference rig). GPU offload is what keeps you
there; CPU-only still works but TTFT and tokens/sec degrade. See
[`latency_budgets.md`](latency_budgets.md) for the measured numbers.

## Minimum

The floor for a playable 7B Q4 experience. Expect slower first-token times and
lower tokens/sec than the reference rig, especially CPU-only.

| Component | Minimum |
|---|---|
| **OS** | Windows 10/11 64-bit · macOS 13+ (Apple Silicon) · Linux x64 (glibc 2.31+) |
| **CPU** | Modern 4-core x86-64 (AVX2) or Apple Silicon M1 |
| **RAM** | **16 GB** — required if running the model CPU-only; the model plus app must fit in memory |
| **GPU / VRAM** | **~6 GB VRAM** for GPU offload (NVIDIA, AMD, or Intel Arc). Optional — CPU-only works with 16 GB RAM, just slower |
| **Disk** | **~6–10 GB free** — language model (~4.4 GB), Whisper model (~0.5–1.5 GB), app + binaries |
| **Audio** | Any microphone (headset or laptop mic). Optional — you can type instead |
| **Node.js** | 18+ **only if running from source**; packaged builds bundle their own runtime |

Notes on the minimum tier:

- **CPU-only is supported, not punished.** With 16 GB RAM and no usable GPU,
  a 7B Q4 still runs; you'll see higher TTFT and ~single-digit tokens/sec
  instead of the 11–15 tok/s reference. The spell-breaking threshold is
  silence before the first token, so a CPU-only rig benefits most from the
  **Brief** length preset.
- **6 GB VRAM** holds a 7B Q4 with partial-to-full offload at 4096 context.
  Less than that means more layers spill to CPU.
- On **Apple Silicon**, 8 GB unified memory is the realistic floor for 7B Q4;
  16 GB is much more comfortable since the app, OS, and model share that pool.

## Ideal

A comfortable rig that hits the latency budgets with headroom and leaves room
for a larger model or longer context.

| Component | Ideal |
|---|---|
| **OS** | Windows 11 64-bit · macOS 14+ (Apple Silicon) · current Linux x64 |
| **CPU** | 8-core+ recent desktop/laptop (AVX2/AVX-512), or Apple Silicon M3/M4 |
| **RAM** | **32 GB** — model fully resident with room for the app, browser, and a bigger context |
| **GPU / VRAM** | **12–16 GB VRAM** — full offload of a 7B at 4096+ context with margin, or a 13B Q4. NVIDIA (CUDA) is the smoothest path; modern Intel Arc / AMD via Vulkan also fully offload |
| **Disk** | **20 GB+ free SSD** — room for multiple models, Whisper Medium, and location art |
| **Audio** | A dedicated USB or headset mic for cleaner transcription |

On an ideal rig you can comfortably raise `contextsize` (longer campaign
memory in the narrator's head), switch Whisper to **Medium** for better
transcription, and run **Rich** length presets without the turn cycle
feeling like lag.

## Per-platform notes

**Windows** — the primary tested platform. x64 only. The packaged build ships
as an NSIS installer and a portable directory; SmartScreen will warn on the
unsigned installer (see the README troubleshooting section).

**macOS** — **Apple Silicon (arm64) only.** There are no Intel-Mac builds. Use
the `koboldcpp-mac-arm64` backend binary. Push-to-talk defaults to **toggle**
(press to start, press again to stop) because macOS doesn't report key-release
to a background window. The build is signed and notarized (Developer ID), so it
opens normally — no Gatekeeper workaround needed.

**Linux** — x64 and arm64 AppImage / deb. FFmpeg from your distro (`apt install
ffmpeg`), official KoboldCPP Linux binaries, and a whisper.cpp build (CUDA or
Vulkan optional). Push-to-talk also defaults to toggle.

## What the GPU choice actually changes

The backend (KoboldCPP) ships in different builds per GPU vendor, and picking
the wrong one is the most common "it runs but it's slow" cause:

- **NVIDIA** → the CUDA/cuBLAS `koboldcpp.exe`. Full offload, smoothest path.
- **Intel Arc / AMD** → the **Vulkan** build. The default NVIDIA `.exe` will
  *not* accelerate these — it falls back to CPU. Grab the Vulkan-capable
  KoboldCPP build to actually use the GPU.
- **No discrete GPU** → CPU-only. Works with 16 GB+ RAM; just bring patience
  and lean on the Brief preset.

This matters more than raw VRAM size: a 16 GB Intel Arc GPU driven by the
wrong (NVIDIA-only) backend build performs like a CPU-only machine.

## Bring-your-own pieces (none are bundled)

tmíxʷ never ships a model or an LLM. You supply:

- **A local LLM backend** — KoboldCPP (default, tested on **1.112.2**),
  llama.cpp server, Ollama, LM Studio, or any OpenAI-compatible server.
- **A GGUF model** — recommended **Mistral-7B-Instruct-v0.3 Q4_K_M (~4.4 GB)**.
- **whisper.cpp** (`whisper-cli`) + a Whisper model — the wizard can download
  these; **Small** is the default, **Medium** (~1.5 GB) hears better.
- **FFmpeg** — auto-detected or auto-downloaded by the wizard (Windows), or
  `brew install ffmpeg` / `apt install ffmpeg` elsewhere.
