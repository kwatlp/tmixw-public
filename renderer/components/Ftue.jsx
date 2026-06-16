import React, { useCallback, useEffect, useState } from "react";
import "../styles/wizard.css";

/**
 * First-time user experience (post-wizard). Showcases the installed story
 * templates and lets the player start their first world from one — or skip
 * and begin with a blank world. No forced choice: the blank path is a
 * first-class option, not a fallback.
 *
 * Picking a template applies it in place to the pristine first-run world
 * (main: `worlds:applyTemplateToActive`), so the player lands in one seeded
 * world rather than a blank "My World" plus a themed second one. If no
 * templates are discovered, the FTUE has nothing to show and dismisses
 * itself immediately.
 */
export default function Ftue({ onDone }) {
  const [templates, setTemplates] = useState(null); // null = loading
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = (await window.api.worldsTemplates()) ?? [];
        if (cancelled) return;
        if (list.length === 0) {
          onDone?.();
          return;
        }
        setTemplates(list);
      } catch {
        if (!cancelled) onDone?.();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  const startWithTemplate = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const r = await window.api.ftueApplyTemplate(selected);
      if (r && r.ok === false) {
        setError(r.error || "Could not start that story.");
        return;
      }
      onDone?.();
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [selected, onDone]);

  const startBlank = useCallback(() => {
    if (busy) return;
    onDone?.();
  }, [busy, onDone]);

  if (templates === null) {
    return (
      <div className="wizard-root" role="status" aria-label="Loading">
        <div className="wizard-inner">
          <p className="wizard-muted" style={{ margin: 0 }}>
            Loading…
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-root" role="dialog" aria-label="Choose a story">
      <div className="wizard-inner">
        <section className="wizard-panel ftue-panel">
          <p className="wizard-kicker">Your first world</p>
          <h2 className="wizard-title">Pick a story to begin</h2>
          <p className="wizard-copy">
            A story template seeds your world with its lore, cast, opening
            scene, and a narrator voice — so you start mid-adventure instead of
            on a blank page. Or begin empty and shape your own from nothing.
          </p>

          <div className="ftue-grid">
            {templates.map((t) => {
              const isSel = selected === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  className={isSel ? "ftue-card selected" : "ftue-card"}
                  aria-pressed={isSel}
                  disabled={busy}
                  onClick={() => setSelected(isSel ? "" : t.id)}
                >
                  <span className="ftue-card-name">{t.name}</span>
                  {t.genre ? (
                    <span className="ftue-card-genre">{t.genre}</span>
                  ) : null}
                  {t.tagline ? (
                    <span className="ftue-card-tagline">{t.tagline}</span>
                  ) : null}
                  {t.summary ? (
                    <span className="ftue-card-summary">{t.summary}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {error ? <p className="wizard-error">{error}</p> : null}

          <div className="wizard-actions ftue-actions">
            <button
              type="button"
              className="wizard-secondary"
              onClick={startBlank}
              disabled={busy}
            >
              Start with a blank world
            </button>
            <button
              type="button"
              className="wizard-primary"
              onClick={startWithTemplate}
              disabled={busy || !selected}
            >
              {busy ? "Preparing…" : "Begin this story"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
