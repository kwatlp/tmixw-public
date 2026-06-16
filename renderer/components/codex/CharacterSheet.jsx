import React from "react";

/**
 * Read-only character sheet (design doc 01 Phase 5). Renders the structured
 * `world_state.character` an app-forge world produces. The editable record-card
 * version still lives in Cast → You; this is the at-a-glance sheet. Shown only
 * for `createdBy: "app-forge"` sheets (CodexPanel gates the tab).
 */
export default function CharacterSheet({ character }) {
  const c = character ?? {};
  const stats = c.stats ?? {};
  const derived = c.derived ?? {};
  const resources = c.resources ?? {};
  const power = c.unique_power ?? null;

  return (
    <div className="char-sheet">
      <header className="char-sheet-head">
        <h2 className="char-sheet-name">{c.name || "Unnamed"}</h2>
        <p className="char-sheet-sub">
          {[c.pronouns, labelOf(c.race), labelOf(c.origin)].filter(Boolean).join(" · ")}
        </p>
        <p className="char-sheet-rank">
          {[c.rank && `Rank ${c.rank}`, c.rankLabel && `(${c.rankLabel})`].filter(Boolean).join(" ")}
          {c.xp ? ` · XP ${c.xp.current ?? 0}/${c.xp.max ?? 0}` : ""}
        </p>
      </header>

      {c.look ? <Block label="Look">{c.look}</Block> : null}
      {c.past ? <Block label="Past">{c.past}</Block> : null}

      {Object.keys(stats).length ? (
        <section className="char-sheet-section">
          <h3 className="char-sheet-h3">Stats</h3>
          <div className="char-stat-grid">
            {Object.entries(stats).map(([k, v]) => (
              <div key={k} className="char-stat">
                <span className="char-stat-name">{k}</span>
                <span className="char-stat-val">{v}</span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {Object.keys(derived).length ? (
        <div className="char-derived">
          {Object.entries(derived).map(([k, v]) => {
            const pool = resources[k];
            return (
              <span key={k} className="char-derived-item">
                <span className="char-derived-key">{k}</span>
                <span className="char-derived-val">{pool ? `${pool.current}/${pool.max}` : v}</span>
              </span>
            );
          })}
        </div>
      ) : null}

      {Array.isArray(c.skills) && c.skills.length ? (
        <Block label="Skills">
          <span className="char-pills">
            {c.skills.map((s, i) => (
              <span key={i} className="char-pill">{s.name}{s.rank ? ` · ${s.rank}` : ""}</span>
            ))}
          </span>
        </Block>
      ) : null}

      {power?.name ? (
        <section className="char-sheet-section">
          <h3 className="char-sheet-h3">Unique Power — {power.name}</h3>
          {power.reliable ? <p className="char-sheet-line"><b>Reliable:</b> {power.reliable}</p> : null}
          {power.stretch ? <p className="char-sheet-line"><b>Stretch:</b> {power.stretch}</p> : null}
          {power.cost ? <p className="char-sheet-line"><b>Cost:</b> {power.cost}</p> : null}
        </section>
      ) : null}

      {Array.isArray(c.traits) && c.traits.length ? (
        <Block label="Traits">
          <span className="char-pills">
            {c.traits.map((t, i) => <span key={i} className="char-pill">{t}</span>)}
          </span>
        </Block>
      ) : null}

      {c.coin && Object.keys(c.coin).length ? (
        <Block label="Coin">
          {Object.entries(c.coin).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(" · ")}
        </Block>
      ) : null}

      {Array.isArray(c.inventory) && c.inventory.length ? (
        <Block label="Inventory">
          <span className="char-pills">
            {c.inventory.map((it, i) => (
              <span key={i} className="char-pill">{it.name}{it.equipped ? " ✓" : ""}</span>
            ))}
          </span>
        </Block>
      ) : null}
    </div>
  );
}

function Block({ label, children }) {
  return (
    <div className="char-sheet-block">
      <span className="char-sheet-block-label">{label}</span>
      <span className="char-sheet-block-body">{children}</span>
    </div>
  );
}

function labelOf(v) {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") return v.label || v.id || "";
  return "";
}
