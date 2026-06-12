# Latency budgets — 7B functional tier (v0.7.0 M5)

Roadmap v4 assigns "latency budgets per tier" to v0.7.0. This documents the
measured baseline and the budgets the experience is tuned against. Numbers
come from the per-turn timing now attached to every context report
(`pipeline.getLastContextReport().timing`, visible in Memory tab → context
debug), measured 2026-06-12 with streaming ON through the real turn path
(assembler → mistral template → SSE).

## Measured baseline

**Rig (reference for the 7B tier):** KoboldCPP 1.112.2 ·
Mistral-7B-Instruct-v0.3 Q4_K_M · contextsize 4096 · dev machine.
Prompt sizes ~1.2–2.6k chars (~300–650 est. tokens); throughput observed
≈ 11–15 tokens/s.

| Length preset | TTFT (first token) | Generation | Output |
|---|---|---|---|
| Brief (120)    | 0.9–1.0s | ~5s    | ~1–2 paragraphs |
| Standard (220) | 1.5s     | ~5.6s  | ~1–2 paragraphs |
| Rich (400)     | 0.9–1.4s | 9–13s  | ~3 paragraphs |

Context assembly is negligible (≤2ms). Turn cycle ≈ generation time:
everything else (extraction, memory, summaries) runs off the turn path by
design (v0.5.0/v0.6.0), and acceptance-time extraction overlaps the next
turn's generation.

## Budgets (7B tier)

The spell-breaking threshold is silence, not total time — once tokens are
flowing, long generations read as narration, not lag.

- **Time-to-first-token: ≤ 2s** (typical 0.9–1.5s). This is the number that
  matters for "nothing breaks the spell"; if TTFT regresses past 2s on this
  tier, look at prompt growth first (context debug shows section sizes).
- **Turn cycle, Brief/Standard: ≤ 8s** (typical 5–6s).
- **Turn cycle, Rich: ≤ 15s** (typical 9–13s). Sprawling is explicitly
  uncapped — the player opted into it, and Stop is one click.
- **Context assembly: ≤ 50ms** (typical ≤2ms; budget allows for embedding
  retrieval being enabled). With real token counting (2026-06-12 tech-debt
  session): the very first assembly pays ~50ms for the uncached count
  round-trips, then the per-adapter text cache brings warm assemblies back
  to ~0ms — measured live, KoboldCPP, Mistral-7B Q4_K_M.

## Notes & gotchas observed while measuring

- ~1 in 6 generations against an identical re-prompt returned an immediate
  EOS (empty text in ~50ms). The pipeline now retries such empty stream
  results once, non-streaming (`_generateNarrative`).
- TTFT includes KoboldCPP prompt processing, which scales with prompt size;
  at 4k contextsize and current budgets it stays around a second. Larger
  context budgets (memoryMaxChars, lorebook inject) trade directly against
  TTFT on CPU-bound rigs.
- Budgets assume one KoboldCPP slot: a background extraction in flight when
  the player sends queues the narrative request behind it. Worst case adds
  one extractor generation (~2–5s) to TTFT immediately after an
  auto-accept; in play this is rare (extraction usually finishes inside the
  grace window).

Re-measure with `npm run` turns or in-app via the context debug panel when
hardware, model, or context budgets change; update this file alongside.
