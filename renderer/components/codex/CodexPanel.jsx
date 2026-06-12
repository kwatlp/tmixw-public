import React, { useState } from "react";
import { useCodex } from "./CodexProvider.jsx";
import { CODEX_TABS } from "./buildCodexView.js";
import GroupSection from "./GroupSection.jsx";
import NowMarker from "./NowMarker.jsx";

/**
 * The Codex: three player-lens tabs over one record-card component.
 * Renders its own `.left-panel-wrap` so panel collapse can swap the
 * 340px panel for the 36px rail. STORY appends the "now" marker and the
 * quiet End scene / New chapter actions after the Chronicle group.
 */
export default function CodexPanel({ onOpenSettings }) {
  const {
    view,
    activeTab,
    setActiveTab,
    panelCollapsed,
    setPanelCollapsed,
    searchQuery,
    setSearchQuery,
    createGroup,
    dragging,
    canDrop,
    moveEntry,
    search,
    searchActive
  } = useCodex();
  const [newGroupHot, setNewGroupHot] = useState(false);

  if (panelCollapsed) {
    return (
      <div className="left-panel-wrap collapsed">
        <div
          className="panel flush codex-rail"
          title="Expand the codex"
          onClick={() => setPanelCollapsed(false)}
        >
          <span className="codex-rail-glyph">⇥</span>
          <span className="codex-rail-label">codex</span>
        </div>
      </div>
    );
  }

  let groups = view ? view[activeTab] : null;
  // Live filter: non-matching entries hidden, empty groups hidden entirely.
  // Collapse states are untouched — clearing the query restores them as-is.
  if (groups && search) {
    const hits = search.byTab[activeTab];
    groups = groups
      .map((g) => ({ ...g, entries: g.entries.filter((e) => hits.has(e.id)) }))
      .filter((g) => g.entries.length > 0);
  }

  return (
    <div className="left-panel-wrap">
      <div className="panel flush codex-panel">
        <nav className="codex-tabs">
          {CODEX_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={activeTab === t.id ? "codex-tab active" : "codex-tab"}
              onClick={() => setActiveTab(t.id)}
            >
              {/* Cross-tab hint: match counts while a query is active. */}
              {search && search.counts[t.id] > 0
                ? `${t.label} · ${search.counts[t.id]}`
                : t.label}
            </button>
          ))}
          <span className="cdx-spacer" />
          <button
            type="button"
            className="codex-icon-btn"
            title="Collapse the codex"
            aria-label="Collapse the codex"
            onClick={() => setPanelCollapsed(true)}
          >
            ⇤
          </button>
          <button
            type="button"
            className="codex-icon-btn gear"
            title="Settings"
            aria-label="Open settings"
            onClick={onOpenSettings}
          >
            ⚙
          </button>
        </nav>

        <div className="codex-search-wrap">
          <input
            className="codex-search"
            placeholder="Search the codex…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setSearchQuery("");
            }}
          />
        </div>

        <div className="codex-body">
          {!groups ? (
            <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: "0.82rem" }}>
              Loading…
            </p>
          ) : searchActive && groups.length === 0 ? (
            <p style={{ color: "var(--muted)", fontFamily: "var(--sans)", fontSize: "0.82rem", margin: 0 }}>
              No matches.
            </p>
          ) : (
            groups.map((g) => (
              <React.Fragment key={g.id}>
                <GroupSection group={g} />
                {g.id === "story:chronicle" && !searchActive ? (
                  <>
                    <NowMarker />
                    <StoryActions unassignedBeats={view?.unassignedBeats ?? 0} />
                  </>
                ) : null}
              </React.Fragment>
            ))
          )}
        </div>
        {searchActive ? null : (
        <button
          type="button"
          className={newGroupHot ? "cdx-new-group drop-hover" : "cdx-new-group"}
          onClick={() => createGroup(activeTab)}
          onDragOver={(e) => {
            if (!dragging || !canDrop(dragging, "cdx:new")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setNewGroupHot(true);
          }}
          onDragLeave={() => setNewGroupHot(false)}
          onDrop={async (e) => {
            setNewGroupHot(false);
            if (!dragging || !canDrop(dragging, "cdx:new")) return;
            e.preventDefault();
            // Dropping on + New group: create the group with the entry in it,
            // name already in rename mode.
            const entryId = dragging;
            const group = await createGroup(activeTab);
            if (group) await moveEntry(entryId, group.id, null);
          }}
        >
          + New group
        </button>
        )}
      </div>
    </div>
  );
}

/** Quiet memory-tier actions under the Chronicle. */
function StoryActions({ unassignedBeats }) {
  return (
    <div className="cdx-story-actions">
      <button
        type="button"
        className="cdx-mini"
        disabled={unassignedBeats === 0}
        title="Roll the current beats into a scene now"
        onClick={() => window.api.memoryEndScene("")}
      >
        End scene ({unassignedBeats})
      </button>
      <button
        type="button"
        className="cdx-mini"
        title="Scenes ended after this land in a new chapter"
        onClick={() => window.api.memoryStartChapter("")}
      >
        New chapter
      </button>
    </div>
  );
}
