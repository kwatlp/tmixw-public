import React, { useEffect, useRef, useState } from "react";
import { useCodex } from "./CodexProvider.jsx";
import RecordCard from "./RecordCard.jsx";

/**
 * Collapsible group of record cards. Header: disclosure arrow, uppercase
 * name, entry count; custom groups add a ✎ rename affordance (inline input,
 * Enter/blur saves, Esc cancels) and a × delete when empty. Groups are drop
 * targets: the header (append) and the open card list (gold insertion line
 * at the index).
 */
export default function GroupSection({ group }) {
  const {
    collapsedGroups,
    toggleGroup,
    renamingGroup,
    setRenamingGroup,
    renameGroup,
    deleteGroup,
    dragging,
    dropTarget,
    setDropTarget,
    moveEntry,
    canDrop,
    searchActive
  } = useCodex();
  // During a search, matching entries always render (expanded); the stored
  // collapse state is preserved untouched for when the query clears.
  const collapsed = searchActive ? false : !!collapsedGroups[group.id];
  const renaming = renamingGroup === group.id;
  const validTarget = dragging != null && canDrop(dragging, group.id);
  const headerHot =
    validTarget && dropTarget?.groupId === group.id && dropTarget.index == null;

  const onHeaderDragOver = (e) => {
    if (!validTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTarget({ groupId: group.id, index: null });
  };

  const onHeaderDrop = (e) => {
    if (!validTarget) return;
    e.preventDefault();
    moveEntry(dragging, group.id, null);
  };

  const onBodyDragOver = (e, index) => {
    if (!validTarget) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dropTarget?.groupId !== group.id || dropTarget.index !== index) {
      setDropTarget({ groupId: group.id, index });
    }
  };

  const onBodyDrop = (e, index) => {
    if (!validTarget) return;
    e.preventDefault();
    e.stopPropagation();
    moveEntry(dragging, group.id, index);
  };

  return (
    <section>
      <div
        className={headerHot ? "cdx-group-header drop-hover" : "cdx-group-header"}
        onClick={() => (renaming ? null : toggleGroup(group.id))}
        onDragOver={onHeaderDragOver}
        onDrop={onHeaderDrop}
        onDragLeave={() => {
          if (headerHot) setDropTarget(null);
        }}
      >
        <span className="cdx-group-arrow">{collapsed ? "▸" : "▾"}</span>
        {renaming ? (
          <GroupRenameInput
            initial={group.name}
            onSave={(name) => renameGroup(group.id, name)}
            onCancel={() => setRenamingGroup(null)}
          />
        ) : (
          <>
            <span className="cdx-group-name">{group.name}</span>
            <span className="cdx-group-count">{group.entries.length}</span>
            <span className="cdx-spacer" />
            {group.custom ? (
              <>
                <button
                  type="button"
                  className="cdx-group-affordance"
                  title="Rename group"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenamingGroup(group.id);
                  }}
                >
                  ✎
                </button>
                {group.entries.length === 0 ? (
                  <button
                    type="button"
                    className="cdx-group-affordance"
                    title="Delete empty group"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteGroup(group.id);
                    }}
                  >
                    ×
                  </button>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
      {!collapsed ? (
        <div className="cdx-group-body">
          {group.entries.map((e, i) => (
            <React.Fragment key={e.id}>
              {validTarget &&
              dropTarget?.groupId === group.id &&
              dropTarget.index === i ? (
                <div className="cdx-insert-line" />
              ) : null}
              <div
                onDragOver={(ev) => {
                  const rect = ev.currentTarget.getBoundingClientRect();
                  const before = ev.clientY < rect.top + rect.height / 2;
                  onBodyDragOver(ev, before ? i : i + 1);
                }}
                onDrop={(ev) =>
                  onBodyDrop(ev, dropTarget?.groupId === group.id ? dropTarget.index : i)
                }
              >
                <RecordCard entry={e} groupId={group.id} />
              </div>
            </React.Fragment>
          ))}
          {validTarget &&
          dropTarget?.groupId === group.id &&
          dropTarget.index === group.entries.length ? (
            <div className="cdx-insert-line" />
          ) : null}
          {group.entries.length === 0 && group.custom ? (
            <div
              className="cdx-group-empty"
              onDragOver={(e) => onBodyDragOver(e, 0)}
              onDrop={(e) => onBodyDrop(e, 0)}
            >
              empty — drag entries here
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function GroupRenameInput({ initial, onSave, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef(null);
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      className="cdx-group-rename"
      value={draft}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (!done.current) {
          done.current = true;
          onSave(draft);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done.current = true;
          onSave(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
    />
  );
}
