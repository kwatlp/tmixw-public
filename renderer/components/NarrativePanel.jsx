import React, { useEffect, useRef, useState, useCallback } from "react";
import MessageFin from "./MessageFin.jsx";

const TAB_LABELS = { story: "Story", cast: "Cast", world: "World" };

export default function NarrativePanel({
  turns,
  thinking,
  resolving,
  streaming,
  pending,
  chapterTitle,
  onReveal,
  onSpeak
}) {
  const busy = thinking || streaming;
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, thinking]);

  const lastNarrativeIdx = (() => {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].narrative != null) return i;
    }
    return -1;
  })();

  return (
    <div
      className="panel"
      style={{ flex: 1, minHeight: 0, overflowY: "auto", marginBottom: 8, padding: "28px 36px" }}
    >
      <div style={{ maxWidth: "68ch", display: "flex", flexDirection: "column", gap: 20 }}>
        {chapterTitle ? (
          <h2
            style={{
              margin: 0,
              fontFamily: "var(--serif)",
              fontWeight: 600,
              fontSize: "1.4rem",
              color: "var(--gold)"
            }}
          >
            {chapterTitle}
          </h2>
        ) : null}
        {turns.map((row, i) => (
          <div key={i}>
            {row.user ? (
              <p
                style={{
                  margin: "0 0 0.5rem 0",
                  fontFamily: "var(--serif)",
                  fontStyle: "italic",
                  fontSize: "1.05rem",
                  lineHeight: 1.6,
                  color: "var(--muted)",
                  whiteSpace: "pre-wrap"
                }}
              >
                You — {row.user}
              </p>
            ) : null}
            {/* Roll line sits above the prose (design doc 02 §6.2). */}
            <MechanicsSections sections={row.sections} kinds={["roll"]} />
            {(resolving || thinking) && i === turns.length - 1 && !row.narrative ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--focus)", fontFamily: "var(--sans)", fontSize: "0.9em" }}>
                <span className="pulse-dot" style={{ background: "var(--focus)" }} />
                <span>
                  {resolving && !thinking
                    ? "Resolving…"
                    : row.sections?.length
                      ? "Narrating…"
                      : "Thinking…"}
                </span>
              </div>
            ) : null}
            {row.narrative ? (
              <p
                className="narrative-text"
                style={{ margin: 0, whiteSpace: "pre-wrap", fontSize: "1.05rem", lineHeight: 1.6 }}
              >
                {row.narrative}
              </p>
            ) : null}
            {/* Combat / enemy / status / loot blocks sit under the prose. */}
            <MechanicsSections sections={row.sections} kinds={["combat", "enemies", "loot", "status"]} />
            {row.markers?.length ? (
              <div style={{ marginTop: 8 }}>
                {row.markers.map((m, j) => (
                  <button
                    key={`${m.entryId}-${j}`}
                    type="button"
                    className="narrative-marker-chip"
                    title="Open this entry in the Codex"
                    onClick={() => onReveal?.(m)}
                  >
                    ◆ {m.name} added to {TAB_LABELS[m.tab] ?? m.tab} — view
                  </button>
                ))}
              </div>
            ) : null}
            {/* Completion indicator (doc 03) + read-aloud (doc 05): bottom-right. */}
            {row.narrative ? (
              <div className="msg-fin-row">
                {onSpeak ? (
                  <button
                    type="button"
                    className="msg-readaloud"
                    title="Read this aloud"
                    aria-label="Read this message aloud"
                    onClick={() => onSpeak(row.narrative)}
                  >
                    🔊
                  </button>
                ) : null}
                <MessageFin
                  meta={row.meta}
                  streaming={streaming && i === lastNarrativeIdx}
                  busy={busy}
                  isLast={i === lastNarrativeIdx}
                />
              </div>
            ) : null}
            {i === lastNarrativeIdx && row.narrative ? (
              <ResponseControls thinking={busy} pending={pending} />
            ) : null}
          </div>
        ))}
        {turns.length === 0 && !thinking ? (
          <p style={{ color: "var(--muted)", margin: 0 }}>
            Hold ` (backtick) or use the mic to speak, or type below.
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>
      <LoreCorrection />
    </div>
  );
}

/**
 * App-rendered mechanical blocks (design doc 02 §6.2): the engine's numbers,
 * composited with the model's prose. Always correct because they come from the
 * ResolutionResult, never from parsing the narration. `kinds` filters which
 * section types render here (roll above the prose, combat/status/loot below).
 * Each type gets a dedicated layout (Phase 5) so a fight reads as a fight.
 */
function MechanicsSections({ sections, kinds }) {
  const list = (Array.isArray(sections) ? sections : []).filter((s) => kinds.includes(s?.type));
  if (list.length === 0) return null;
  return (
    <div className="mech-stack">
      {list.map((s, i) => (
        <MechSection key={i} section={s} />
      ))}
    </div>
  );
}

function MechSection({ section: s }) {
  switch (s?.type) {
    case "status":
      return <StatusSection s={s} />;
    case "enemies":
      return <EnemiesSection s={s} />;
    case "combat":
      return <CombatSection s={s} />;
    case "roll":
      return <RollSection s={s} />;
    default:
      return <LinesSection s={s} />;
  }
}

const SectionShell = ({ title, type, className = "", children }) => (
  <div className={`mech-section ${className}`}>
    <span className="mech-section-title">⟦ {title || type} ⟧</span>
    {children}
  </div>
);

/** % full for a `cur/max` pair, clamped to [0, 100]. */
const pctFull = (cur, max) => {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((Number(cur) / m) * 100)));
};

/** Cue + tint per engine-reported roll outcome (no prose parsing — doc 02 §6.2). */
const OUTCOME_CUE = {
  crit: { mark: "✦", cls: "crit" },
  success: { mark: "✓", cls: "hit" },
  fail: { mark: "✗", cls: "miss" }
};

/** roll: check/attack line(s), tinted + cued by the engine's `outcome` field. */
function RollSection({ s }) {
  const lines = s.lines ?? [];
  const cue = OUTCOME_CUE[s.outcome];
  return (
    <SectionShell title={s.title} type="Roll" className="mech-roll">
      <span className="mech-lines">
        {lines.map((ln, i) => (
          <span key={i} className={`mech-roll-line${cue ? ` ${cue.cls}` : ""}`}>
            {ln}
            {cue ? ` ${cue.mark}` : ""}
          </span>
        ))}
      </span>
    </SectionShell>
  );
}

/** combat: the round's blow-by-blow; tone (deal/take/miss) comes from the engine. */
function CombatSection({ s }) {
  const events = s.events ?? [];
  if (events.length === 0) return null;
  return (
    <SectionShell title={s.title} type="Round" className="mech-combat">
      <ul className="mech-combat-list">
        {events.map((e, i) => (
          <li key={i} className={`mech-combat-line ${e.tone ?? "miss"}${e.slain ? " slain" : ""}`}>
            {e.text}
          </li>
        ))}
      </ul>
    </SectionShell>
  );
}

/** enemies: one row per foe with a vitality bar (engine-supplied fields). */
function EnemiesSection({ s }) {
  const rows = s.enemies ?? [];
  if (rows.length === 0) return null;
  return (
    <SectionShell title={s.title} type="Enemies" className="mech-enemies">
      <div className="mech-enemy-rows">
        {rows.map((r, i) => (
          <div key={i} className={`mech-enemy${r.slain ? " slain" : ""}`}>
            <span className="mech-enemy-name">{r.name}</span>
            {r.max != null ? (
              <span className="mech-bar" title={`${r.cur}/${r.max}`}>
                <span className="mech-bar-fill foe" style={{ width: `${pctFull(r.cur, r.max)}%` }} />
              </span>
            ) : null}
            <span className="mech-enemy-vit">{r.slain ? "slain" : `${r.cur}/${r.max}`}</span>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

/** Bar tint per status pool (palette-consistent: vit=oxblood, others=gold). */
const STAT_TONE = { VIT: "vit", STA: "sta", AET: "aet", XP: "xp" };

/** status: the compact post-action snapshot; cur/max pools get a slim bar. */
function StatusSection({ s }) {
  const entries = Object.entries(s.snapshot ?? {});
  if (entries.length === 0) return null;
  return (
    <SectionShell title={s.title} type="Status" className="mech-status-section">
      <span className="mech-status">
        {entries.map(([k, v]) => {
          const m = /^(\d+)\/(\d+)$/.exec(String(v));
          return (
            <span key={k} className="mech-stat">
              <span className="mech-stat-key">{k}</span>
              {m ? (
                <span className="mech-bar mech-bar-sm" title={String(v)}>
                  <span
                    className={`mech-bar-fill ${STAT_TONE[k] || "xp"}`}
                    style={{ width: `${pctFull(m[1], m[2])}%` }}
                  />
                </span>
              ) : null}
              <span className="mech-stat-val">{v}</span>
            </span>
          );
        })}
      </span>
    </SectionShell>
  );
}

/** Fallback (loot, unknown): the lines joined inline. */
function LinesSection({ s }) {
  return (
    <SectionShell title={s.title} type={s.type}>
      <span className="mech-lines">{(s.lines ?? []).join("  ·  ")}</span>
    </SectionShell>
  );
}

/**
 * Footer controls for the latest narrator message (v0.6.0 D3): Regenerate,
 * Continue, Rewrite-with-instruction. The pending dot is passive — acceptance
 * is automatic (silent-update feel); no countdowns, no modals. Controls are
 * disabled while a generation is in flight (regenerate-spam guard).
 */
function ResponseControls({ thinking, pending }) {
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const inputRef = useRef(null);

  useEffect(() => {
    if (rewriteOpen) inputRef.current?.focus();
  }, [rewriteOpen]);

  const disabled = thinking;

  const act = (fn) => () => {
    if (disabled) return;
    setRewriteOpen(false);
    fn().catch((err) => console.error("[ResponseControls]", err));
  };

  const submitRewrite = () => {
    const t = instruction.trim();
    if (!t || disabled) return;
    setInstruction("");
    setRewriteOpen(false);
    window.api.narrativeRewrite(t).catch((err) => console.error("[ResponseControls]", err));
  };

  const btnStyle = {
    background: "none",
    border: "none",
    padding: "2px 6px",
    cursor: disabled ? "default" : "pointer",
    color: "var(--muted)",
    fontFamily: "var(--sans)",
    fontSize: "0.72rem",
    opacity: disabled ? 0.4 : 1
  };

  return (
    <div className="response-controls" style={{ marginTop: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
        {pending ? (
          <span
            title="Not yet saved — accepts automatically"
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: "var(--gold)",
              opacity: 0.55,
              marginRight: 6,
              flexShrink: 0
            }}
          />
        ) : null}
        <button type="button" style={btnStyle} disabled={disabled} title="Regenerate — same context, fresh result" onClick={act(() => window.api.narrativeRegenerate())}>
          ↻ Redo
        </button>
        <button type="button" style={btnStyle} disabled={disabled} title="Continue — extend this response" onClick={act(() => window.api.narrativeContinue())}>
          → Continue
        </button>
        <button
          type="button"
          style={{ ...btnStyle, color: rewriteOpen ? "var(--gold)" : btnStyle.color }}
          disabled={disabled}
          title="Rewrite with an instruction (this response only)"
          onClick={() => !disabled && setRewriteOpen((o) => !o)}
        >
          ✎ Rewrite
        </button>
        {pending ? (
          <button type="button" style={btnStyle} disabled={disabled} title="Keep this response now (otherwise it saves on its own)" onClick={act(() => window.api.narrativeAccept())}>
            ✓ Keep
          </button>
        ) : null}
      </div>
      {rewriteOpen ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <input
            ref={inputRef}
            type="text"
            value={instruction}
            disabled={disabled}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitRewrite();
              if (e.key === "Escape") setRewriteOpen(false);
            }}
            placeholder="e.g. more dialogue, slower pacing, less gore"
            style={{
              flex: 1,
              maxWidth: 380,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid var(--hair)",
              background: "var(--panel-recess)",
              color: "var(--bone)",
              fontSize: "0.78rem",
              fontFamily: "var(--sans)",
              outline: "none"
            }}
          />
          <button
            type="button"
            className="btn gold-line"
            disabled={disabled || !instruction.trim()}
            onClick={submitRewrite}
            style={{ padding: "2px 10px", fontSize: "0.72rem" }}
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Human-readable lines for what a corrector diff changed.
 * @returns {string[]}
 */
function summarizeDiff(diff) {
  const lines = [];
  if (!diff || typeof diff !== "object") return lines;
  const pc = diff.player_character ?? diff.character_updates;
  if (pc && typeof pc === "object") {
    for (const [k, v] of Object.entries(pc)) {
      lines.push(v === null ? `Removed character field: ${k}` : `Character: ${k} → ${typeof v === "string" ? v : JSON.stringify(v)}`);
    }
  }
  for (const n of diff.npcs ?? []) {
    if (n?.name) lines.push(`NPC: ${n.name}${n.status ? ` (${n.status})` : ""}${n.notes ? ` — ${n.notes}` : ""}`);
  }
  for (const q of diff.quests ?? []) {
    if (q?.title) lines.push(`Quest: ${q.title}${q.status ? ` → ${q.status}` : ""}`);
  }
  for (const l of diff.locations ?? []) {
    if (l?.name) lines.push(`Location: ${l.name}`);
  }
  for (const e of diff.lorebook ?? []) {
    if (e?.title) lines.push(`Lorebook: "${e.title}"`);
  }
  if (lines.length === 0) lines.push("No changes detected in the correction.");
  return lines;
}

function LoreCorrection() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [toast, setToast] = useState("");
  const [lastDiff, setLastDiff] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const loadHistory = useCallback(async () => {
    try {
      const h = await window.api.loreGetHistory();
      setHistory(Array.isArray(h) ? h : []);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (open) loadHistory();
  }, [open, loadHistory]);

  const submit = useCallback(async () => {
    const val = text.trim();
    if (!val || submitting) return;
    setSubmitting(true);
    try {
      const result = await window.api.loreApplyCorrection(val);
      if (result?.ok) {
        setText("");
        setToast("");
        setLastDiff(result.diff ?? null);
        await loadHistory();
      } else {
        setLastDiff(null);
        setToast("Failed to apply correction");
        setTimeout(() => setToast(""), 4000);
      }
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, loadHistory]);

  const undo = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const r = await window.api.loreUndoLast();
      if (r?.ok) {
        setLastDiff(null);
        setToast("Reverted");
        setTimeout(() => setToast(""), 3000);
        await loadHistory();
      }
    } finally {
      setSubmitting(false);
    }
  }, [submitting, loadHistory]);

  return (
    <div style={{ marginTop: 12, borderTop: "1px solid var(--hair)", paddingTop: 8 }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="label"
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        {open ? "▼" : "▶"} Correct Lore
      </button>

      {open && (
        <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="e.g. The capital of Valdris is Ashenmoor"
            disabled={submitting}
            style={{
              flex: 1,
              padding: "6px 10px",
              borderRadius: 6,
              border: "1px solid var(--hair)",
              background: "var(--panel-recess)",
              color: "var(--bone)",
              fontSize: "0.85rem",
              fontFamily: "var(--sans)",
              outline: "none"
            }}
          />
          <button
            type="button"
            className="btn gold-line"
            onClick={submit}
            disabled={submitting || !text.trim()}
            style={{ padding: "6px 14px", fontSize: "0.8rem", opacity: submitting || !text.trim() ? 0.5 : 1 }}
          >
            {submitting ? "…" : "Apply"}
          </button>
        </div>
      )}

      {toast && (
        <div style={{
          marginTop: 6,
          fontSize: "0.78rem",
          color: toast.includes("Failed") ? "var(--oxblood)" : "var(--gold)",
          fontFamily: "var(--sans)"
        }}>
          {toast}
        </div>
      )}

      {open && lastDiff && (
        <div style={{
          marginTop: 8,
          padding: "8px 10px",
          border: "1px solid rgba(212,175,55,0.2)",
          borderRadius: 6,
          background: "var(--gold-ghost)"
        }}>
          <div className="label" style={{ fontSize: "0.75rem", marginBottom: 4 }}>
            What changed
          </div>
          {summarizeDiff(lastDiff).map((line, i) => (
            <div key={i} style={{ fontSize: "0.8rem", color: "var(--bone)", fontFamily: "var(--sans)" }}>
              {line}
            </div>
          ))}
        </div>
      )}

      {open && history.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            onClick={() => setHistoryOpen((o) => !o)}
            className="label"
            style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: "0.75rem" }}
          >
            {historyOpen ? "▼" : "▶"} Recent corrections ({history.length})
          </button>
          {historyOpen && (
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
              {[...history].reverse().map((h, i) => (
                <div key={h.id} style={{
                  padding: "6px 10px",
                  border: "1px solid var(--hair)",
                  borderRadius: 6,
                  fontSize: "0.78rem",
                  fontFamily: "var(--sans)",
                  color: "var(--bone)"
                }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ flex: 1 }}>{h.correctionText}</span>
                    {i === 0 && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={undo}
                        disabled={submitting}
                        style={{ padding: "2px 10px", fontSize: "0.72rem" }}
                      >
                        Undo
                      </button>
                    )}
                  </div>
                  <div style={{ color: "var(--muted)", marginTop: 2 }}>
                    {summarizeDiff(h.diff).join(" · ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
