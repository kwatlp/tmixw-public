import React, { useEffect, useRef, useState } from "react";

const LENGTH_PILLS = [
  { id: "brief", label: "Brief", title: "Brief — 1-2 tight paragraphs" },
  { id: "standard", label: "Std", title: "Standard" },
  { id: "rich", label: "Rich", title: "Rich — detailed, atmospheric" },
  { id: "sprawling", label: "Sprawl", title: "Sprawling — expansive scenes" }
];

// Mirror of core/style_presets.js ids/labels (directives live in core).
const STYLE_AXES = [
  { axis: "tone", label: "Tone", options: [["neutral", "Neutral"], ["grim", "Grim"], ["whimsical", "Whimsical"], ["heroic", "Heroic"], ["eerie", "Eerie"]] },
  { axis: "pov", label: "POV", options: [["second", "Second person"], ["third", "Third person"]] },
  { axis: "tense", label: "Tense", options: [["present", "Present"], ["past", "Past"]] },
  { axis: "rating", label: "Rating", options: [["standard", "Standard"], ["family", "Family-friendly"], ["mature", "Mature"]] }
];

const DEFAULT_STYLE = { tone: "neutral", pov: "second", tense: "present", rating: "standard", notes: "" };

const MAX_INPUT_HEIGHT = 144; // ~6 rows, then the textarea scrolls

export default function InputBar({
  thinking,
  streaming,
  settingsOpen,
  voiceHudOpen,
  onToggleVoiceHud
}) {
  const [text, setText] = useState("");
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [lengthPreset, setLengthPreset] = useState("standard");
  const [styleOpen, setStyleOpen] = useState(false);
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const taRef = useRef(null);
  const styleWrapRef = useRef(null);

  useEffect(() => {
    return window.api.onRecording((ev) => {
      if (ev.phase === "start") {
        setRecording(true);
      } else {
        setRecording(false);
        setTranscribing(true);
      }
    });
  }, []);

  // Voice transcription drafts into the input (no auto-send). Appends to any
  // existing draft so multiple recordings build a multi-paragraph entry.
  useEffect(() => {
    return window.api.onTranscriptDraft((p) => {
      setTranscribing(false);
      const t = String(p?.text ?? "").trim();
      if (!t || t === "[BLANK_AUDIO]") return;
      setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")}\n${t}` : t));
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = el.value.length;
        }
      });
    });
  }, []);

  // Auto-send mode / blank audio / short recordings emit a plain transcript
  // event; errors can also end transcription. All clear the spinner state,
  // and errors also clear recording so the PTT button can't stick red.
  useEffect(() => window.api.onTranscript(() => setTranscribing(false)), []);
  useEffect(() => {
    return window.api.onError(() => {
      setTranscribing(false);
      setRecording(false);
    });
  }, []);

  // Auto-grow with content up to MAX_INPUT_HEIGHT, then scroll.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [text]);

  // Sync with config on mount and whenever the Settings modal closes, so the
  // quick control and the Settings dropdowns never disagree.
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.api.settingsGet();
        if (cancelled) return;
        setLengthPreset(cfg?.narrative?.lengthPreset ?? "standard");
        setStyle({ ...DEFAULT_STYLE, ...(cfg?.narrative?.style ?? {}) });
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [settingsOpen]);

  // Close the style popover on any outside click.
  useEffect(() => {
    if (!styleOpen) return;
    const onDown = (e) => {
      if (!styleWrapRef.current?.contains(e.target)) setStyleOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [styleOpen]);

  const pickStyle = async (axis, value) => {
    setStyle((prev) => ({ ...prev, [axis]: value }));
    try {
      await window.api.setNarrativeStyle({ [axis]: value });
    } catch (err) {
      console.error("[InputBar] setNarrativeStyle rejected", err);
    }
  };

  const saveNotes = async (notes) => {
    try {
      await window.api.setNarrativeStyle({ notes });
    } catch (err) {
      console.error("[InputBar] setNarrativeStyle(notes) rejected", err);
    }
  };

  const pickLength = async (id) => {
    setLengthPreset(id);
    try {
      await window.api.setLengthPreset(id);
    } catch (err) {
      console.error("[InputBar] setLengthPreset rejected", err);
    }
  };

  const send = async () => {
    const t = text.trim();
    if (!t || thinking || streaming) return;
    setText("");
    try {
      await window.api.submitText(t);
    } catch (err) {
      console.error("[InputBar] submitText rejected", err);
    }
  };

  const stopGen = async () => {
    try {
      await window.api.narrativeStopGeneration();
    } catch (err) {
      console.error("[InputBar] stopGeneration rejected", err);
    }
  };

  const disabled = thinking || streaming;

  return (
    <div className="panel tight" style={{ flexShrink: 0, display: "flex", alignItems: "flex-end", gap: 10 }}>
      <button
        type="button"
        title="Push to talk"
        disabled={disabled}
        onMouseDown={() => { if (!disabled) window.api.pttStart(); }}
        onMouseUp={() => window.api.pttEnd()}
        onMouseLeave={() => recording && window.api.pttEnd()}
        className={recording ? "pulse-dot" : ""}
        style={{
          width: 36,
          height: 36,
          flexShrink: 0,
          borderRadius: "50%",
          border: `1px solid var(--hair-strong)`,
          background: recording ? "var(--rec-red)" : "transparent",
          color: recording ? "#1a1410" : "var(--muted)",
          cursor: disabled ? "not-allowed" : "pointer",
          boxShadow: recording ? "0 0 12px var(--rec-red)" : "none",
          transition: "background 0.15s ease, box-shadow 0.15s ease, color 0.15s ease"
        }}
      >
        ●
      </button>
      <button
        type="button"
        title={voiceHudOpen ? "Hide the voice HUD" : "Show the voice HUD"}
        onClick={onToggleVoiceHud}
        style={{
          height: 36,
          padding: "0 6px",
          flexShrink: 0,
          background: "transparent",
          border: "none",
          fontFamily: "var(--sans)",
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--muted)",
          cursor: "pointer",
          transition: "color 0.15s ease"
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "var(--bone)")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
      >
        Voice {voiceHudOpen ? "▴" : "▾"}
      </button>
      <textarea
        ref={taRef}
        rows={1}
        value={text}
        disabled={disabled || transcribing}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        placeholder={
          streaming
            ? "Narrating…"
            : thinking
              ? "Generating…"
              : transcribing
                ? "Transcribing…"
                : "Type a message… (Shift+Enter for a new line)"
        }
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 40,
          maxHeight: MAX_INPUT_HEIGHT,
          borderRadius: 6,
          border: `1px solid var(--hair)`,
          background: "var(--panel-recess)",
          color: "var(--bone)",
          padding: "9px 12px",
          fontFamily: "var(--sans)",
          resize: "none",
          overflowY: "auto",
          lineHeight: "22px"
        }}
      />
      <div ref={styleWrapRef} style={{ position: "relative", flexShrink: 0 }}>
        <button
          type="button"
          title="Narrative style & length"
          onClick={() => setStyleOpen((o) => !o)}
          style={{
            height: 40,
            padding: "0 14px",
            border: "1px solid var(--hair-strong)",
            borderRadius: 6,
            background: styleOpen ? "var(--gold-ghost)" : "transparent",
            color: styleOpen ? "var(--gold)" : "var(--bone)",
            fontSize: "0.82rem",
            fontFamily: "var(--sans)",
            cursor: "pointer",
            transition: "background 0.15s ease, color 0.15s ease"
          }}
        >
          Style ▾
        </button>
        {styleOpen && (
          <div
            style={{
              position: "absolute",
              bottom: 46,
              right: 0,
              width: 280,
              padding: 12,
              borderRadius: 8,
              border: "1px solid var(--hair)",
              background: "var(--panel, rgba(20,18,14,0.96))",
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              zIndex: 30
            }}
          >
            <div className="label" style={{ fontSize: "0.7rem" }}>Length</div>
            <div style={{ display: "flex", border: "1px solid var(--hair)", borderRadius: 6, overflow: "hidden" }}>
              {LENGTH_PILLS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={p.title}
                  onClick={() => pickLength(p.id)}
                  style={{
                    flex: 1,
                    height: 30,
                    border: "none",
                    borderLeft: p.id !== "brief" ? "1px solid var(--hair)" : "none",
                    background: lengthPreset === p.id ? "var(--gold-ghost)" : "transparent",
                    color: lengthPreset === p.id ? "var(--gold)" : "var(--muted)",
                    fontSize: "0.72rem",
                    fontFamily: "var(--sans)",
                    cursor: "pointer"
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {STYLE_AXES.map(({ axis, label, options }) => (
              <div key={axis} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="label" style={{ fontSize: "0.7rem", width: 52, flexShrink: 0 }}>{label}</span>
                <select
                  value={style[axis]}
                  onChange={(e) => pickStyle(axis, e.target.value)}
                  style={{
                    flex: 1,
                    height: 28,
                    borderRadius: 6,
                    border: "1px solid var(--hair)",
                    background: "var(--panel-recess)",
                    color: "var(--bone)",
                    fontSize: "0.75rem",
                    fontFamily: "var(--sans)"
                  }}
                >
                  {options.map(([id, optLabel]) => (
                    <option key={id} value={id}>{optLabel}</option>
                  ))}
                </select>
              </div>
            ))}
            <input
              type="text"
              value={style.notes}
              placeholder="Style notes (applied every response)"
              onChange={(e) => setStyle((prev) => ({ ...prev, notes: e.target.value }))}
              onBlur={(e) => saveNotes(e.target.value.trim())}
              onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              style={{
                height: 28,
                padding: "0 8px",
                borderRadius: 6,
                border: "1px solid var(--hair)",
                background: "var(--panel-recess)",
                color: "var(--bone)",
                fontSize: "0.75rem",
                fontFamily: "var(--sans)",
                outline: "none"
              }}
            />
          </div>
        )}
      </div>
      {streaming ? (
        <button
          type="button"
          className="btn gold-line"
          title="Stop generating — keeps what's written so far"
          onClick={stopGen}
          style={{ height: 40, padding: "0 18px" }}
        >
          ■ Stop
        </button>
      ) : (
        <button
          type="button"
          className="btn primary"
          disabled={disabled || !text.trim()}
          onClick={send}
          style={{
            height: 40,
            padding: "0 20px",
            opacity: disabled || !text.trim() ? 0.5 : 1
          }}
        >
          Send
        </button>
      )}
    </div>
  );
}
