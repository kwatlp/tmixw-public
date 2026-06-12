import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import buildCodexView, { CODEX_TABS } from "./buildCodexView.js";

/** Case-insensitive match over entry name, field labels/values, and pills. */
function entryMatches(entry, q) {
  if (entry.name.toLowerCase().includes(q)) return true;
  for (const f of entry.fields) {
    if (f.label && f.label.toLowerCase().includes(q)) return true;
    if (f.kind === "pills") {
      if ((f.pills ?? []).some((p) => p.toLowerCase().includes(q))) return true;
    } else if ((f.value ?? "").toLowerCase().includes(q)) {
      return true;
    }
  }
  return false;
}

/**
 * Single world subscription + codex view-model + UI state for the panel.
 * Replaces the old per-tab getWorld()/onWorldUpdated pattern (each of the
 * six tabs re-fetched the full world independently).
 *
 * View state (collapse/expand/active tab/panel rail) persists in
 * localStorage; real data (groups, membership, provenance, drafts) lives in
 * world_state.json's codex block and is written via window.api.codex*.
 */

const CodexContext = createContext(null);

export function useCodex() {
  const ctx = useContext(CodexContext);
  if (!ctx) throw new Error("useCodex outside CodexProvider");
  return ctx;
}

const UI_KEY = "tmixw.codexUi.v1";

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export default function CodexProvider({ children, reveal }) {
  const ui0 = useRef(loadUiState()).current;

  const [world, setWorld] = useState(null);
  const [activeTab, setActiveTabRaw] = useState(ui0.activeTab ?? "story");
  const [collapsedGroups, setCollapsedGroups] = useState(ui0.collapsedGroups ?? {});
  const [expandedEntries, setExpandedEntries] = useState(ui0.expandedEntries ?? {});
  const [panelCollapsed, setPanelCollapsed] = useState(!!ui0.panelCollapsed);
  /** { entryId, fieldKey } | null — at most one inline edit at a time. */
  const [editing, setEditing] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  /** groupId whose name is being edited inline. */
  const [renamingGroup, setRenamingGroup] = useState(null);
  /** entryId being dragged; null when idle. */
  const [dragging, setDragging] = useState(null);
  /** { groupId, index|null } — current valid drop target while dragging. */
  const [dropTarget, setDropTarget] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const w = await window.api.getWorld();
      if (alive) setWorld(w);
    })();
    // Never write back from this handler — world:updated must stay read-only
    // here or codex IPC calls would loop.
    const off = window.api.onWorldUpdated((p) => {
      if (p?.worldState) setWorld(p.worldState);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        UI_KEY,
        JSON.stringify({ activeTab, collapsedGroups, expandedEntries, panelCollapsed })
      );
    } catch {
      // ignore (storage full/unavailable)
    }
  }, [activeTab, collapsedGroups, expandedEntries, panelCollapsed]);

  const view = useMemo(() => (world ? buildCodexView(world) : null), [world]);

  // --- Search (spec: ~120ms debounce, codex-wide, never touches data) ------
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim().toLowerCase()), 120);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const searchActive = debouncedQuery.length > 0;

  /** Per-tab match sets + counts; null when no query. */
  const search = useMemo(() => {
    if (!searchActive || !view) return null;
    const byTab = {};
    const counts = {};
    for (const { id: tab } of CODEX_TABS) {
      const set = new Set();
      for (const g of view[tab] ?? []) {
        for (const e of g.entries) {
          if (entryMatches(e, debouncedQuery)) set.add(e.id);
        }
      }
      byTab[tab] = set;
      counts[tab] = set.size;
    }
    return { byTab, counts, query: debouncedQuery };
  }, [searchActive, debouncedQuery, view]);

  // --- Reveal (narrative marker chip → jump to the entry) ------------------
  // `reveal` = { entryId, tab, nonce } lifted from MainApp; each click bumps
  // the nonce. Expands the panel, switches tab, opens group + card, scrolls.
  useEffect(() => {
    if (!reveal || !view) return undefined;
    const tab = CODEX_TABS.some((t) => t.id === reveal.tab) ? reveal.tab : null;
    if (!tab) return undefined;
    setPanelCollapsed(false);
    setEditing(null);
    setActiveTabRaw(tab);
    const group = (view[tab] ?? []).find((g) =>
      g.entries.some((e) => e.id === reveal.entryId)
    );
    if (group) {
      setCollapsedGroups((s) => (s[group.id] ? { ...s, [group.id]: false } : s));
    }
    setExpandedEntries((s) =>
      s[reveal.entryId] ? s : { ...s, [reveal.entryId]: true }
    );
    const t = setTimeout(() => {
      document
        .querySelector(`[data-entry-id="${CSS.escape(reveal.entryId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 150);
    return () => clearTimeout(t);
    // Re-run per click (nonce), not per world refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);

  /** Tab click cancels any in-progress edit/rename (spec behavior table). */
  const setActiveTab = useCallback((tab) => {
    setEditing(null);
    setRenamingGroup(null);
    setDragging(null);
    setDropTarget(null);
    setActiveTabRaw(tab);
  }, []);

  const toggleGroup = useCallback((groupId) => {
    setCollapsedGroups((s) => ({ ...s, [groupId]: !s[groupId] }));
  }, []);

  const toggleEntry = useCallback((entryId) => {
    setExpandedEntries((s) => ({ ...s, [entryId]: !s[entryId] }));
  }, []);

  const expandEntry = useCallback((entryId) => {
    setExpandedEntries((s) => (s[entryId] ? s : { ...s, [entryId]: true }));
  }, []);

  const editField = useCallback(async (entryId, fieldKey, value) => {
    setEditing(null);
    await window.api.codexEditField(entryId, fieldKey, value);
  }, []);

  const addField = useCallback(
    async (entryId) => {
      const res = await window.api.codexAddField(entryId);
      if (res?.ok && res.fieldKey) {
        expandEntry(entryId);
        setEditing({ entryId, fieldKey: res.fieldKey });
      }
    },
    [expandEntry]
  );

  const keepEntry = useCallback(async (entryId) => {
    await window.api.codexKeepEntry(entryId);
  }, []);

  /** Rewrite = keep + expand + open the first field in edit mode. */
  const rewriteEntry = useCallback(
    async (entry) => {
      await window.api.codexKeepEntry(entry.id);
      expandEntry(entry.id);
      const first = entry.fields[0];
      if (first) setEditing({ entryId: entry.id, fieldKey: first.key });
    },
    [expandEntry]
  );

  /** Creates a custom group already in rename mode (spec). */
  const createGroup = useCallback(async (tab, name) => {
    const res = await window.api.codexGroupCreate(tab, name);
    const group = res?.group ?? null;
    if (group) setRenamingGroup(group.id);
    return group;
  }, []);

  const renameGroup = useCallback(async (groupId, name) => {
    setRenamingGroup(null);
    const next = String(name ?? "").trim();
    if (next) await window.api.codexGroupRename(groupId, next);
  }, []);

  /** Empty custom groups only — core refuses non-empty ones. */
  const deleteGroup = useCallback(async (groupId) => {
    await window.api.codexGroupDelete(groupId);
  }, []);

  const moveEntry = useCallback(async (entryId, groupId, index = null) => {
    setDragging(null);
    setDropTarget(null);
    await window.api.codexMoveEntry(entryId, groupId, index);
  }, []);

  /**
   * Drop rules, mirroring core/codex.js constraints: the player character
   * stays in You; chronicle records reorder within Chronicle only; nothing
   * else may enter Chronicle or You. Same-tab is implied (only one tab is
   * visible).
   */
  const canDrop = useCallback((entryId, groupId) => {
    if (!entryId || entryId === "pc" || entryId === "chron:current") return false;
    const chron = /^(beat_|scene_|chap_)/.test(entryId);
    if (chron) return groupId === "story:chronicle";
    return groupId !== "story:chronicle" && groupId !== "cast:you";
  }, []);

  const value = useMemo(
    () => ({
      world,
      view,
      activeTab,
      setActiveTab,
      collapsedGroups,
      toggleGroup,
      expandedEntries,
      toggleEntry,
      expandEntry,
      panelCollapsed,
      setPanelCollapsed,
      editing,
      setEditing,
      searchQuery,
      setSearchQuery,
      editField,
      addField,
      keepEntry,
      rewriteEntry,
      createGroup,
      renamingGroup,
      setRenamingGroup,
      renameGroup,
      deleteGroup,
      dragging,
      setDragging,
      dropTarget,
      setDropTarget,
      moveEntry,
      canDrop,
      search,
      searchActive
    }),
    [
      world,
      view,
      activeTab,
      setActiveTab,
      collapsedGroups,
      toggleGroup,
      expandedEntries,
      toggleEntry,
      expandEntry,
      panelCollapsed,
      editing,
      searchQuery,
      editField,
      addField,
      keepEntry,
      rewriteEntry,
      createGroup,
      renamingGroup,
      renameGroup,
      deleteGroup,
      dragging,
      dropTarget,
      moveEntry,
      canDrop,
      search,
      searchActive
    ]
  );

  return <CodexContext.Provider value={value}>{children}</CodexContext.Provider>;
}
