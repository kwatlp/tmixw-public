import React, { useEffect, useRef, useState } from "react";
import BorderFrame from "./components/BorderFrame.jsx";
import CodexProvider from "./components/codex/CodexProvider.jsx";
import CodexPanel from "./components/codex/CodexPanel.jsx";
import NarrativePanel from "./components/NarrativePanel.jsx";
import VoiceHud from "./components/VoiceHud.jsx";
import InputBar from "./components/InputBar.jsx";
import Settings from "./components/Settings.jsx";
import WorldsModal from "./components/WorldsModal.jsx";

const defaultBg = "art/backgroundimage.jpg";

export default function MainApp() {
  /** Two stacked bg layers for the location crossfade (v0.7.0). */
  const [bgLayers, setBgLayers] = useState(["", ""]);
  const [activeBg, setActiveBg] = useState(0);
  const bgPathRef = useRef("");
  const [currentLocation, setCurrentLocation] = useState("");
  const [ui, setUi] = useState({
    backgroundImage: defaultBg,
    borderMode: "svg",
    borderImage: null,
    locationBackgrounds: {}
  });
  const [thinking, setThinking] = useState(false);
  const [turns, setTurns] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [worldsOpen, setWorldsOpen] = useState(false);
  /** Latest narrator response not yet committed (v0.6.0 acceptance model). */
  const [pending, setPending] = useState(null);
  /** True while narrator tokens are streaming into the last row (v0.7.0). */
  const [streaming, setStreaming] = useState(false);
  const streamedRef = useRef(false);
  /** Codex marker chip click → { entryId, tab, nonce } for CodexProvider. */
  const [reveal, setReveal] = useState(null);
  /** Latest chapter title (world_state.chapters) — narrative column heading. */
  const [chapterTitle, setChapterTitle] = useState("");
  /** Voice HUD (v0.8.4): hidden by default, persisted; recording auto-opens it. */
  const [voiceHudOpen, setVoiceHudOpen] = useState(
    () => localStorage.getItem("tmixw.voiceHud.v1") === "1"
  );
  const [hudRecording, setHudRecording] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem("tmixw.voiceHud.v1", voiceHudOpen ? "1" : "0");
    } catch { /* ignore */ }
  }, [voiceHudOpen]);

  useEffect(() => {
    const off = window.api.onRecording((p) => {
      const rec = p?.phase === "start";
      setHudRecording(rec);
      if (rec) setVoiceHudOpen(true);
    });
    return () => off();
  }, []);

  // Reload UI config on mount and when Settings closes (gallery edits apply live).
  useEffect(() => {
    if (settingsOpen) return;
    let cancelled = false;
    (async () => {
      const cfg = await window.api.getUiConfig();
      if (cancelled) return;
      setUi({
        backgroundImage: cfg.backgroundImage ?? defaultBg,
        borderMode: cfg.borderMode ?? "svg",
        borderImage: cfg.borderImage ?? null,
        locationBackgrounds: cfg.locationBackgrounds ?? {}
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [settingsOpen]);

  // Track where the player is (world_state.current_location, set by the
  // extractor) and the latest chapter title for the narrative heading.
  useEffect(() => {
    const lastChapterTitle = (w) => {
      const chapters = Array.isArray(w?.chapters) ? w.chapters : [];
      return String(chapters[chapters.length - 1]?.title ?? "");
    };
    let cancelled = false;
    (async () => {
      try {
        const w = await window.api.getWorld();
        if (!cancelled) {
          setCurrentLocation(String(w?.current_location ?? ""));
          setChapterTitle(lastChapterTitle(w));
        }
      } catch { /* ignore */ }
    })();
    const off = window.api.onWorldUpdated((p) => {
      setCurrentLocation(String(p?.worldState?.current_location ?? ""));
      setChapterTitle(lastChapterTitle(p?.worldState));
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Gallery binding (v0.7.0 D5): the bg follows current_location, falling
  // back to the default image; changes crossfade via the two stacked layers.
  const loc = currentLocation.trim().toLowerCase();
  const desiredBgPath =
    (loc && ui.locationBackgrounds?.[loc]) || ui.backgroundImage || defaultBg;

  useEffect(() => {
    if (desiredBgPath === bgPathRef.current) return;
    let cancelled = false;
    (async () => {
      const r = await window.api.getBackgroundUrl(desiredBgPath);
      if (cancelled || r.missing || !r.url) return;
      bgPathRef.current = desiredBgPath;
      setActiveBg((prev) => {
        const next = prev === 0 ? 1 : 0;
        setBgLayers((layers) => {
          const n = [...layers];
          n[next] = r.url;
          return n;
        });
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [desiredBgPath]);

  useEffect(() => {
    console.log("[MainApp] mount: wiring pipeline event listeners");
    const offT = window.api.onTranscript((p) => {
      const t = String(p.text ?? "");
      if (p.beforeKobold) return;
      if (!t || t === "[BLANK_AUDIO]") return;
      setTurns((prev) => [...prev, { user: t, narrative: null }]);
    });
    const offB = window.api.onBeforeKobold((p) => {
      setThinking(true);
    });
    // Streamed tokens fill the active (last) row progressively; the final
    // `narrative` event then replaces it with the trimmed full text.
    const offTok = window.api.onNarrativeToken((p) => {
      setThinking(false);
      setStreaming(true);
      streamedRef.current = true;
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], narrative: p.text ?? "" };
        return next;
      });
    });
    const offN = window.api.onNarrative((p) => {
      setThinking(false);
      setStreaming(false);
      const wasStreamed = streamedRef.current;
      streamedRef.current = false;
      setTurns((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0 && (next[i].narrative == null || wasStreamed)) {
          next[i] = { ...next[i], narrative: p.text ?? "" };
        } else {
          next.push({ user: "", narrative: p.text ?? "" });
        }
        return next;
      });
    });
    // Regenerate/continue/rewrite results replace the latest narrator text.
    const offU = window.api.onNarrativeUpdated((p) => {
      setThinking(false);
      setStreaming(false);
      streamedRef.current = false;
      setTurns((prev) => {
        const next = [...prev];
        const i = next.length - 1;
        if (i >= 0 && next[i].narrative != null) {
          next[i] = { ...next[i], narrative: p.text ?? "" };
        }
        return next;
      });
    });
    const offP = window.api.onNarrativePending((p) => {
      setPending({ id: p.id, mode: p.mode, graceMs: p.graceMs });
    });
    const offA = window.api.onNarrativeAccepted(() => setPending(null));
    const offE = window.api.onError((p) => {
      console.error(`[pipeline error] (${p?.phase ?? "?"})`, p?.error ?? p);
      setThinking(false);
      setStreaming(false);
      streamedRef.current = false;
    });
    const offReady = window.api.onReady(() => {});
    const offStop = window.api.onStop(() => {});
    // Co-author wrote new entries into the Codex — drop marker chips into the
    // narrative flow on the turn that created them.
    const offX = window.api.onExtractorOk((p) => {
      const created = Array.isArray(p?.created) ? p.created : [];
      if (created.length === 0) return;
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const i = next.length - 1;
        next[i] = {
          ...next[i],
          markers: [...(next[i].markers ?? []), ...created]
        };
        return next;
      });
    });
    return () => {
      offX();
      offT();
      offB();
      offTok();
      offN();
      offU();
      offP();
      offA();
      offE();
      offReady();
      offStop();
    };
  }, []);

  // World switch (v0.9.0): the transcript belongs to the old world — clear
  // it and all in-flight turn state. The codex re-derives itself from the
  // fresh world:updated the main process emits right after this event.
  useEffect(() => {
    const off = window.api.onWorldsChanged(() => {
      setTurns([]);
      setPending(null);
      setThinking(false);
      setStreaming(false);
      streamedRef.current = false;
    });
    return () => off();
  }, []);

  // Restore the pending indicator after a renderer remount mid-grace-window.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.narrativeGetPending();
        if (!cancelled && r?.pending) {
          setPending({ id: r.pending.id, mode: r.pending.mode, graceMs: r.pending.graceMs });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const id = setTimeout(() => {
      void window.api.rendererReady();
    }, 300);
    return () => clearTimeout(id);
  }, []);

  return (
    <div className="app-root">
      <div className="bg-layer" aria-hidden>
        {bgLayers.map((url, i) =>
          url ? (
            <img key={i} src={url} alt="" style={{ opacity: i === activeBg ? 1 : 0 }} />
          ) : null
        )}
      </div>

      <BorderFrame borderMode={ui.borderMode} borderImage={ui.borderImage} />

      <div className="ui-root">
        <button
          type="button"
          className="codex-icon-btn gear app-settings-btn"
          title="Settings"
          aria-label="Open settings"
          onClick={() => setSettingsOpen(true)}
        >
          ⚙
        </button>
        <CodexProvider reveal={reveal}>
          <CodexPanel onOpenWorlds={() => setWorldsOpen(true)} />
        </CodexProvider>
        <div className="narrative-col">
          <NarrativePanel
            turns={turns}
            thinking={thinking}
            streaming={streaming}
            pending={pending}
            chapterTitle={chapterTitle}
            onReveal={(m) => setReveal({ entryId: m.entryId, tab: m.tab, nonce: Date.now() })}
          />
          {voiceHudOpen ? (
            <VoiceHud recording={hudRecording} onHide={() => setVoiceHudOpen(false)} />
          ) : null}
          <InputBar
            thinking={thinking}
            streaming={streaming}
            settingsOpen={settingsOpen}
            voiceHudOpen={voiceHudOpen}
            onToggleVoiceHud={() => setVoiceHudOpen((v) => !v)}
          />
        </div>
      </div>

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {worldsOpen && <WorldsModal onClose={() => setWorldsOpen(false)} />}
    </div>
  );
}
