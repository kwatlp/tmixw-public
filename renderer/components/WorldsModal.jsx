import React, { useCallback, useEffect, useState } from "react";
import "../styles/settings.css";

/**
 * World picker (v0.9.0 M2, plan D4): current world, list, New World /
 * Switch / Rename / Delete. Deliberately a modal, not a home screen — the
 * wizard owns first-run, this owns everything after. Deletes are soft
 * (worlds/.trash/), and the active world can't be deleted, only left.
 * Switching closes the modal; MainApp clears the transcript on
 * `worlds:changed` and the fresh `world:updated` re-derives the codex.
 */
export default function WorldsModal({ onClose }) {
  /** @type {[{activeWorldId: string|null, worlds: object[]}|null, Function]} */
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  /** Installed story templates; "" = Blank World. */
  const [templates, setTemplates] = useState([]);
  const [templateId, setTemplateId] = useState("");
  const [renameId, setRenameId] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await window.api.worldsList());
      setTemplates((await window.api.worldsTemplates()) ?? []);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn) => {
    setBusy(true);
    setError("");
    try {
      const r = await fn();
      if (r && r.ok === false) {
        setError(r.error || "Something went wrong.");
        return null;
      }
      return r;
    } catch (e) {
      setError(String(e?.message ?? e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const doSwitch = async (id) => {
    const r = await run(() => window.api.worldsSwitch(id));
    if (r) onClose();
  };

  const doCreate = async () => {
    const r = await run(() =>
      window.api.worldsCreate({ name: newName, templateId: templateId || null })
    );
    if (r) onClose();
  };

  const doRename = async (id) => {
    const r = await run(() => window.api.worldsRename(id, renameVal));
    if (r) {
      setRenameId(null);
      await load();
    }
  };

  const doDelete = async (id) => {
    const r = await run(() => window.api.worldsDelete(id));
    setConfirmDeleteId(null);
    if (r) await load();
  };

  const fmtDate = (iso) => {
    if (!iso) return "never";
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric"
      });
    } catch {
      return iso;
    }
  };

  const worlds = data?.worlds ?? [];
  const activeId = data?.activeWorldId ?? null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal worlds-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Worlds</h2>
          <button type="button" className="settings-close" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body worlds-body">
          {error && <div className="worlds-error">{error}</div>}

          {data == null ? (
            <div className="worlds-empty">Loading…</div>
          ) : worlds.length === 0 ? (
            <div className="worlds-empty">No worlds yet — create one below.</div>
          ) : (
            <ul className="worlds-list">
              {worlds.map((w) => {
                const active = w.id === activeId;
                return (
                  <li key={w.id} className={active ? "worlds-row active" : "worlds-row"}>
                    <div className="worlds-row-main">
                      {renameId === w.id ? (
                        <input
                          className="settings-input worlds-rename-input"
                          value={renameVal}
                          autoFocus
                          disabled={busy}
                          onChange={(e) => setRenameVal(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") void doRename(w.id);
                            if (e.key === "Escape") setRenameId(null);
                          }}
                        />
                      ) : (
                        <span className="worlds-name">
                          {w.name}
                          {active && <span className="worlds-active-badge">active</span>}
                        </span>
                      )}
                      <span className="worlds-dates">
                        created {fmtDate(w.createdAt)} · last played {fmtDate(w.lastPlayedAt)}
                      </span>
                    </div>
                    <div className="worlds-row-actions">
                      {renameId === w.id ? (
                        <>
                          <button
                            type="button"
                            className="worlds-btn"
                            disabled={busy || !renameVal.trim()}
                            onClick={() => doRename(w.id)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="worlds-btn quiet"
                            disabled={busy}
                            onClick={() => setRenameId(null)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          {!active && (
                            <button
                              type="button"
                              className="worlds-btn"
                              disabled={busy}
                              onClick={() => doSwitch(w.id)}
                            >
                              {busy ? "…" : "Switch"}
                            </button>
                          )}
                          <button
                            type="button"
                            className="worlds-btn quiet"
                            disabled={busy}
                            onClick={() => {
                              setRenameId(w.id);
                              setRenameVal(w.name);
                              setConfirmDeleteId(null);
                            }}
                          >
                            Rename
                          </button>
                          {!active &&
                            (confirmDeleteId === w.id ? (
                              <button
                                type="button"
                                className="worlds-btn danger"
                                disabled={busy}
                                onClick={() => doDelete(w.id)}
                              >
                                Really delete?
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="worlds-btn quiet"
                                disabled={busy}
                                onClick={() => setConfirmDeleteId(w.id)}
                              >
                                Delete
                              </button>
                            ))}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="worlds-new-row">
            <input
              className="settings-input worlds-new-input"
              placeholder="New world name…"
              value={newName}
              disabled={busy}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim()) void doCreate();
              }}
            />
            {templates.length > 0 && (
              <select
                className="settings-input worlds-template-select"
                value={templateId}
                disabled={busy}
                onChange={(e) => setTemplateId(e.target.value)}
                title="Story template for the new world"
              >
                <option value="">Blank World</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="settings-save-btn"
              disabled={busy || !newName.trim()}
              onClick={doCreate}
            >
              {busy ? "Working…" : "New World"}
            </button>
          </div>
          {templateId && (
            <div className="worlds-hint">
              {templates.find((t) => t.id === templateId)?.tagline ?? ""}
            </div>
          )}
          <div className="worlds-hint">
            Deleted worlds are moved to the trash folder, not erased. Switching
            worlds stops the current session cleanly first.
          </div>
        </div>
      </div>
    </div>
  );
}
