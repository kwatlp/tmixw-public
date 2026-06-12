# tmíxʷ — playtest guide (v0.8.4)

Thanks for trying this. tmíxʷ is a voice-first AI storytelling game that runs
**entirely on your own machine** — you talk, a narrator talks back (in text),
and the game quietly keeps track of your story: characters you meet, quests
you pick up, places you go. Nothing is sent to the cloud. No account, no
subscription, no telemetry.

This is casual playtesting — **just play it like a game.** There is no test
script. Play a few evenings, poke at whatever interests you, and tell me what
delighted you, confused you, or broke.

---

## What you need

- **Windows 10 or 11**, 64-bit
- A **GPU with ~6 GB+ VRAM** (or 16 GB system RAM for CPU-only — slower but works)
- A **microphone** (any headset or laptop mic is fine — you can also just type)
- Roughly **6–10 GB of disk** for the AI models
- ~20 minutes for first-time setup

## Two downloads to grab first

The installer sets up almost everything, but two pieces are yours to bring
(they're how the game stays private — the AI runs locally, under your control):

1. **KoboldCPP** — the local AI engine. Download the single `.exe` for your
   GPU from <https://github.com/LostRuins/koboldcpp/releases> (for NVIDIA
   cards take `koboldcpp.exe`; the page explains the variants). No install —
   just save it somewhere you'll remember.
2. **A language model** (the "brain", ~4.4 GB). Recommended:
   **Mistral-7B-Instruct-v0.3, Q4_K_M** — from
   <https://huggingface.co/bartowski/Mistral-7B-Instruct-v0.3-GGUF>, download
   `Mistral-7B-Instruct-v0.3-Q4_K_M.gguf`. Save it next to KoboldCPP.

You'll also be asked for **whisper-cli** (speech recognition). If the wizard
doesn't find one, grab the latest Windows zip from
<https://github.com/ggerganov/whisper.cpp/releases>, extract it, and point the
wizard at `whisper-cli.exe`.

## Installing

1. Run **`tmixw Setup 0.8.4.exe`**. Windows SmartScreen will warn you because
   the app isn't code-signed yet — click **More info → Run anyway**. (Signing
   is coming; for now you have my word and the source.)
2. The first-run wizard walks you through the rest, in order: **FFmpeg**
   (auto-detected or auto-downloaded), **speech recognition** (point it at
   `whisper-cli.exe` if asked, then pick a model size — **Small** is a good
   default, Medium hears better but downloads ~1.5 GB), **microphone** (pick
   yours, test it — you'll hear a 2-second playback), **KoboldCPP** (browse to
   the `.exe` you downloaded), **language model** (browse to the `.gguf`), and
   an optional **Player Agent** toggle (experimental — fine to skip).
3. When the wizard finishes, the game boots the AI and drops you into the
   story screen. First model load can take a minute.

## How to play

- **Hold the backtick key ( ` )** — top-left, under Esc — **and speak.**
  Release it and your words are transcribed and sent. The narrator's reply
  streams in like prose in a book.
- Don't like talking? **Type instead** — same box, same story.
- Say what you do, ask what you see, talk to people. It's improv with a
  narrator who never gets tired. There's no win condition — it's a campaign,
  and it remembers. Quit whenever; your story picks up where you left off.
- **The Codex** (left panel — STORY / CAST / WORLD) fills itself in as you
  play. When the AI adds someone new you'll see a small **◆ added to Cast**
  chip and a gold-bordered card. You don't have to do anything — but
  **everything in the Codex is yours to edit**: click any field to rewrite
  it, keep or rewrite new entries, drag things into groups you make.
  The AI fills in lore; you always get the last word.
- **■ Stop** interrupts the narrator mid-stream if a reply is going somewhere
  you don't want; then redo, continue, or rewrite it.
- **Settings** (gear) has narration style presets, length, backgrounds per
  location, and the push-to-talk key if backtick doesn't suit you.

## What I'm hoping you'll do

Play **2–3 sessions of an hour or so**, ideally on different days (the game's
long-term memory across restarts is one of the things being proven out).
Then tell me, on Discord, whatever stands out — a few honest sentences beat a
formal report. Things I especially care about:

- Anywhere you felt **confused or stuck** (especially during setup)
- The narrator **forgetting or contradicting** something that happened earlier
- Anything that **interrupted play** when you didn't ask for it
- Moments that just **felt good** — those matter as much as the bugs

## If something breaks

DM me on Discord with what you were doing, what happened, and a screenshot if
it's visual. If a crash or weirdness repeats, do this once:

1. Open `%AppData%\Roaming\tmixw\core\config.json` in Notepad, change
   `"debug": false` to `"debug": true`, save, restart the game.
2. Reproduce the problem, then send me
   `%AppData%\Roaming\tmixw\tmixw-main.log` along with your description.

Your story lives in `%AppData%\Roaming\tmixw\core\world_state.json` — if the
*story data* itself goes weird, send that file too.

## Known quirks (no need to report these)

- If you **rename** a character in the Codex and the narrator mentions their
  old name later, a duplicate "new" card can appear. Just delete it — and do
  tell me how often this bites you; that I do want to know.
- Very occasionally a reply stalls for a beat and restarts — that's an
  automatic retry, not a crash.
- The first reply after launching is slower than the rest (model warm-up).

Thanks for playing. The whole point of this thing is the feeling of a story
that's truly yours, on your own machine — you're the first people outside
the dev box to try it.
