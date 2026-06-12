import React, { useEffect, useState } from "react";
import { useCodex } from "./CodexProvider.jsx";
import FieldRow from "./FieldRow.jsx";
import Highlight from "./Highlight.jsx";

/**
 * The one shared record card: header (expand toggle, name, ◆ new marker,
 * status pill), field rows, "+ Add field" footer, and the co-author draft
 * footer (Keep / Rewrite) while `isNew`. Chronicle cards (entry.chron) add
 * stale/edited chips and quiet pin/regenerate/delete actions instead of
 * "+ Add field".
 */
export default function RecordCard({ entry }) {
  const {
    expandedEntries,
    toggleEntry,
    addField,
    keepEntry,
    rewriteEntry,
    dragging,
    setDragging,
    setDropTarget,
    search,
    searchActive
  } = useCodex();
  // Matches render expanded so the hit is visible; transient, never stored.
  const expanded = searchActive || !!expandedEntries[entry.id];
  // Insertion indices map to the unfiltered list — no dragging mid-search.
  const draggable = entry.draggable !== false && !searchActive;

  const classes = [
    "cdx-card",
    entry.isNew ? "is-new" : "",
    dragging === entry.id ? "dragging" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} data-entry-id={entry.id}>
      <div
        className="cdx-card-header"
        draggable={draggable}
        onClick={() => toggleEntry(entry.id)}
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", entry.id);
          e.dataTransfer.effectAllowed = "move";
          setDragging(entry.id);
        }}
        onDragEnd={() => {
          setDragging(null);
          setDropTarget(null);
        }}
      >
        <span className="cdx-card-arrow">{expanded ? "▾" : "▸"}</span>
        <span className="cdx-card-name">
          <Highlight text={entry.name} query={search?.query} />
        </span>
        <span className="cdx-spacer" />
        {entry.isNew ? <span className="cdx-new-marker">◆ new</span> : null}
        {entry.chron?.stale ? (
          <span className="cdx-pill red" title="A beat or scene under this summary changed — regenerate to refresh">
            stale
          </span>
        ) : null}
        {entry.chron?.pinned ? (
          <span className="cdx-pill gold" title="Pinned — always in narrator context">
            pinned
          </span>
        ) : null}
        {entry.pill ? (
          <span className={`cdx-pill ${entry.pill.tone}`}>{entry.pill.text}</span>
        ) : null}
      </div>

      {expanded
        ? entry.fields.map((f) => (
            <FieldRow key={f.key} entryId={entry.id} field={f} />
          ))
        : null}

      {expanded && entry.chron && entry.chron.kind !== "current" ? (
        <ChronicleActions entry={entry} />
      ) : null}

      {expanded && entry.canAddField !== false ? (
        <button
          type="button"
          className="cdx-add-field"
          onClick={() => addField(entry.id)}
        >
          + Add field
        </button>
      ) : null}

      {entry.isNew ? (
        <div className="cdx-draft-footer">
          <button
            type="button"
            className="cdx-btn-ghost"
            onClick={() => rewriteEntry(entry)}
          >
            Rewrite
          </button>
          <button
            type="button"
            className="cdx-btn-gold"
            onClick={() => keepEntry(entry.id)}
          >
            Keep
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Quiet pin / regenerate / delete row for chapter and scene cards. */
function ChronicleActions({ entry }) {
  const kind = entry.chron.kind; // "chapter" | "scene"
  const [busy, setBusy] = useState(false);
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return undefined;
    const t = setTimeout(() => setArm(false), 3000);
    return () => clearTimeout(t);
  }, [arm]);

  const regenerate = async () => {
    setBusy(true);
    try {
      await window.api.memoryRegenerate(
        kind === "chapter" ? { chapterIds: [entry.id] } : { sceneIds: [entry.id] }
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cdx-chron-actions">
      <button
        type="button"
        className={entry.chron.pinned ? "cdx-mini pinned" : "cdx-mini"}
        title={
          entry.chron.pinned
            ? "Unpin (pinned = always in narrator context)"
            : "Pin to narrator context"
        }
        onClick={() => window.api.memoryPin(kind, entry.id, !entry.chron.pinned)}
      >
        {entry.chron.pinned ? "pinned" : "pin"}
      </button>
      <button
        type="button"
        className="cdx-mini"
        disabled={busy}
        title={`Regenerate this ${kind} summary with the local model`}
        onClick={regenerate}
      >
        {busy ? "regenerating…" : "regenerate"}
      </button>
      {entry.chron.edited ? (
        <span className="cdx-mini static" title="Player-authored — never overwritten automatically">
          edited
        </span>
      ) : null}
      <span className="cdx-spacer" />
      <button
        type="button"
        className={arm ? "cdx-mini danger" : "cdx-mini"}
        title={`Delete this ${kind}`}
        onClick={() => {
          if (arm) window.api.memoryDelete(kind, entry.id);
          else setArm(true);
        }}
      >
        {arm ? "sure?" : "delete"}
      </button>
    </div>
  );
}
