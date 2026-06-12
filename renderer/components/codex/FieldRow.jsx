import React, { useEffect, useRef, useState } from "react";
import { useCodex } from "./CodexProvider.jsx";
import Highlight from "./Highlight.jsx";

const PROV_TIP = {
  ai: "Written by your co-author — click to edit",
  you: "Written by you — click to edit"
};

function ProvGlyph({ prov }) {
  if (prov === "ai") return <span className="cdx-prov ai">◆</span>;
  if (prov === "you") return <span className="cdx-prov you">✎</span>;
  return null;
}

/**
 * One record-card field row: 76px lowercase label column (12px for chronicle
 * beat bullets), value with provenance glyph, click-to-edit inline input.
 * Enter/blur saves, Esc cancels; saving flips provenance to "you".
 *
 * Chronicle beat rows live on their scene's card but edit their own record —
 * `field.target` overrides the (entryId, fieldKey) the save routes to, and
 * `field.chronBeat` adds quiet hover controls (pin, delete).
 */
export default function FieldRow({ entryId, field }) {
  const { editing, setEditing, editField, search } = useCodex();
  const isEditing =
    editing && editing.entryId === entryId && editing.fieldKey === field.key;
  const query = search?.query;

  const isBullet = field.label === "•";

  return (
    <div className="cdx-field">
      <span className={isBullet ? "cdx-field-label bullet" : "cdx-field-label"}>
        {field.label}
      </span>
      {isEditing ? (
        <FieldEditor entryId={entryId} field={field} onDone={() => setEditing(null)} editField={editField} />
      ) : field.kind === "pills" ? (
        <PillValue
          field={field}
          query={query}
          onEdit={() => setEditing({ entryId, fieldKey: field.key })}
        />
      ) : (
        <span
          className="cdx-field-value"
          title={PROV_TIP[field.prov] ?? "Click to edit"}
          onClick={() => setEditing({ entryId, fieldKey: field.key })}
        >
          {field.value ? <Highlight text={field.value} query={query} /> : "—"}
          <ProvGlyph prov={field.prov} />
        </span>
      )}
      {field.chronBeat && !isEditing ? <BeatControls beat={field.chronBeat} /> : null}
    </div>
  );
}

/** Pin/delete for a chronicle beat — visible on row hover only. */
function BeatControls({ beat }) {
  const [arm, setArm] = useState(false);
  useEffect(() => {
    if (!arm) return undefined;
    const t = setTimeout(() => setArm(false), 3000);
    return () => clearTimeout(t);
  }, [arm]);

  return (
    <span className="cdx-beat-controls">
      <button
        type="button"
        className={beat.pinned ? "cdx-mini pinned" : "cdx-mini"}
        title={beat.pinned ? "Unpin (pinned = always in narrator context)" : "Pin to narrator context"}
        onClick={() => window.api.memoryPin("beat", beat.id, !beat.pinned)}
      >
        {beat.pinned ? "pinned" : "pin"}
      </button>
      <button
        type="button"
        className={arm ? "cdx-mini danger" : "cdx-mini"}
        title="Delete this beat"
        onClick={() => {
          if (arm) window.api.memoryDelete("beat", beat.id);
          else setArm(true);
        }}
      >
        {arm ? "sure?" : "×"}
      </button>
    </span>
  );
}

function PillValue({ field, query, onEdit }) {
  const pills = field.pills ?? [];
  return (
    <span
      className="cdx-pills"
      title={PROV_TIP[field.prov] ?? "Click to edit"}
      onClick={onEdit}
    >
      {pills.length === 0 ? (
        <span className="cdx-field-value" style={{ cursor: "inherit" }}>—</span>
      ) : (
        pills.map((p, i) => (
          <span key={`${p}-${i}`} className="cdx-tag">
            <Highlight text={p} query={query} />
          </span>
        ))
      )}
      <ProvGlyph prov={field.prov} />
    </span>
  );
}

function FieldEditor({ entryId, field, onDone, editField }) {
  const initial =
    field.kind === "pills" ? (field.pills ?? []).join(", ") : field.value ?? "";
  const [draft, setDraft] = useState(initial);
  const ref = useRef(null);
  const committed = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = async () => {
    if (committed.current) return;
    committed.current = true;
    const text = draft;
    let value = text;
    if (field.kind === "pills") {
      value = text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (field.isJson) {
      // Object-valued character fields edit as JSON, matching the old
      // Character tab; malformed input falls back to the raw string.
      try {
        value = JSON.parse(text);
      } catch {
        value = text;
      }
    }
    const target = field.target ?? { entryId, fieldKey: field.key };
    await editField(target.entryId, target.fieldKey, value);
    onDone();
  };

  const cancel = () => {
    committed.current = true;
    onDone();
  };

  const long = field.isJson || initial.length > 60 || initial.includes("\n");

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !(long && e.shiftKey)) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  return long ? (
    <textarea
      ref={ref}
      className="cdx-field-input"
      rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  ) : (
    <input
      ref={ref}
      className="cdx-field-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={onKeyDown}
    />
  );
}
