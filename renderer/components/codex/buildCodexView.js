/**
 * Pure view-model builder: world state → Record<tab, Group[]>.
 *
 * Everything in the Codex is an Entry (record card with Fields) inside a
 * Group inside a tab. The world-state collections stay the storage of
 * record; `world.codex` (schema v4) overlays grouping, provenance, and
 * draft flags. See docs/UIUX Wireframe/README.md.
 *
 * Entry: { id, name, pill?, isNew?, canAddField, draggable, fields[] }
 * Field: { key, label, kind: "text"|"pills", value?, pills?, prov?, isJson? }
 * Group: { id, name, custom, entries[] }
 */

export const CODEX_TABS = [
  { id: "story", label: "Story" },
  { id: "cast", label: "Cast" },
  { id: "world", label: "World" }
];

function provOf(cx, entryId, key) {
  return cx?.prov?.[entryId]?.[key];
}

function pillLabel(item) {
  if (item && typeof item === "object") {
    return String(item.name ?? item.title ?? item.label ?? "Item");
  }
  return String(item ?? "");
}

/** Map a raw record value onto a Field; lists render as pills, never raw JSON. */
function fieldFrom(key, value, prov, label = key) {
  if (Array.isArray(value)) {
    return { key, label, kind: "pills", pills: value.map(pillLabel), prov };
  }
  if (value && typeof value === "object") {
    return {
      key,
      label,
      kind: "text",
      value: JSON.stringify(value, null, 2),
      isJson: true,
      prov
    };
  }
  return { key, label, kind: "text", value: value == null ? "" : String(value), prov };
}

function extraFieldsFor(cx, entryId) {
  return (cx?.extraFields?.[entryId] ?? []).map((f) =>
    fieldFrom(f.key, f.value, provOf(cx, entryId, f.key), f.label ?? f.key)
  );
}

function pcEntry(world, cx) {
  const ch = world.character ?? {};
  const fields = [];
  for (const k of Object.keys(ch)) {
    if (k === "name") continue; // shown as the card name
    fields.push(fieldFrom(k, ch[k], provOf(cx, "pc", k)));
  }
  return {
    id: "pc",
    name: String(ch.name ?? "You"),
    isNew: false,
    canAddField: true,
    draggable: false,
    fields
  };
}

function npcStatusPill(status) {
  const s = String(status ?? "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const tone = /dead|hostile|enemy/.test(lower)
    ? "red"
    : /friend|ally/.test(lower)
      ? "gold"
      : "plain";
  return { text: s, tone };
}

function npcEntry(npc, cx) {
  const id = npc.id;
  const fields = [];
  for (const k of Object.keys(npc)) {
    if (k === "id" || k === "name") continue;
    fields.push(fieldFrom(k, npc[k], provOf(cx, id, k)));
  }
  fields.push(...extraFieldsFor(cx, id));
  return {
    id,
    name: String(npc.name ?? "Unnamed"),
    pill: npcStatusPill(npc.status),
    isNew: !!cx?.isNew?.[id],
    canAddField: true,
    draggable: true,
    fields
  };
}

function questStatusPill(status) {
  const s = String(status ?? "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  const tone = /complete|done/.test(lower)
    ? "green"
    : /fail|abandon/.test(lower)
      ? "red"
      : /active/.test(lower)
        ? "gold"
        : "plain";
  return { text: s, tone };
}

function questEntry(q, cx) {
  const id = q.id;
  const fields = [];
  const keys = Object.keys(q).filter((k) => k !== "id" && k !== "title");
  keys.sort((a, b) => (a === "status" ? -1 : b === "status" ? 1 : 0));
  for (const k of keys) {
    fields.push(fieldFrom(k, q[k], provOf(cx, id, k)));
  }
  fields.push(...extraFieldsFor(cx, id));
  return {
    id,
    name: String(q.title ?? "Untitled"),
    pill: questStatusPill(q.status),
    isNew: !!cx?.isNew?.[id],
    canAddField: true,
    draggable: true,
    fields
  };
}

/** Field that edits a different backing record than the card it sits on
 * (chronicle: beat rows live on their scene's card). */
function targetedField(target, key, label, value, prov, deletable = false) {
  return {
    key: `${target}:${key}`,
    label,
    kind: "text",
    value: value == null ? "" : String(value),
    prov,
    target: { entryId: target, fieldKey: key },
    deletable
  };
}

function beatField(b, cx) {
  return {
    ...targetedField(b.id, "text", "•", b.text, provOf(cx, b.id, "text"), true),
    chronBeat: { id: b.id, pinned: !!b.pinned }
  };
}

function chapterEntry(ch, cx) {
  return {
    id: ch.id,
    name: String(ch.title ?? "") || "Untitled chapter",
    isNew: false,
    canAddField: false,
    draggable: true, // reorder within Chronicle only (core enforces)
    chron: {
      kind: "chapter",
      stale: !!ch.stale,
      edited: !!ch.edited,
      pinned: !!ch.pinned
    },
    fields: [
      targetedField(ch.id, "title", "title", ch.title, provOf(cx, ch.id, "title")),
      targetedField(ch.id, "summary", "summary", ch.summary, provOf(cx, ch.id, "summary"))
    ]
  };
}

function sceneEntry(scene, beats, cx) {
  return {
    id: scene.id,
    name: String(scene.title ?? "") || "Untitled scene",
    isNew: false,
    canAddField: false,
    draggable: true, // reorder within Chronicle only (core enforces)
    chron: {
      kind: "scene",
      stale: !!scene.stale,
      edited: !!scene.edited,
      pinned: !!scene.pinned
    },
    fields: [
      targetedField(scene.id, "title", "title", scene.title, provOf(cx, scene.id, "title")),
      targetedField(scene.id, "summary", "summary", scene.summary, provOf(cx, scene.id, "summary")),
      ...beats.map((b) => beatField(b, cx))
    ]
  };
}

/**
 * Chronicle cards: chapters → their scenes (chronological), orphan scenes,
 * then an implicit "Current scene" card holding not-yet-rolled-up beats.
 * The chronicle *is* the log — every line is an editable record.
 */
function chronicleEntries(world, cx) {
  const beats = (world.session_beats ?? []).filter(
    (b) => b && typeof b === "object"
  );
  const scenes = world.scenes ?? [];
  const chapters = world.chapters ?? [];

  const beatsByScene = new Map();
  const unassigned = [];
  for (const b of beats) {
    if (b.sceneId) {
      if (!beatsByScene.has(b.sceneId)) beatsByScene.set(b.sceneId, []);
      beatsByScene.get(b.sceneId).push(b);
    } else {
      unassigned.push(b);
    }
  }
  const scenesByChapter = new Map();
  const orphanScenes = [];
  for (const s of scenes) {
    if (s.parentId && chapters.some((c) => c.id === s.parentId)) {
      if (!scenesByChapter.has(s.parentId)) scenesByChapter.set(s.parentId, []);
      scenesByChapter.get(s.parentId).push(s);
    } else {
      orphanScenes.push(s);
    }
  }

  const entries = [];
  for (const ch of chapters) {
    entries.push(chapterEntry(ch, cx));
    for (const s of scenesByChapter.get(ch.id) ?? []) {
      entries.push(sceneEntry(s, beatsByScene.get(s.id) ?? [], cx));
    }
  }
  for (const s of orphanScenes) {
    entries.push(sceneEntry(s, beatsByScene.get(s.id) ?? [], cx));
  }
  // Player reorder of chronicle cards is display-only (groupOrder), never a
  // mutation of beat/scene storage; the implicit current-scene card stays last.
  const order = cx?.groupOrder?.["story:chronicle"];
  if (Array.isArray(order) && order.length > 0) {
    const rank = new Map(order.map((id, i) => [id, i]));
    entries.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });
  }
  if (unassigned.length > 0) {
    entries.push({
      id: "chron:current",
      name: "Current scene",
      isNew: false,
      canAddField: false,
      draggable: false,
      chron: { kind: "current" },
      fields: unassigned.map((b) => beatField(b, cx))
    });
  }
  return { entries, unassignedCount: unassigned.length };
}

function loreEntry(e, cx) {
  const id = e.id;
  const fields = [
    fieldFrom("content", e.content, provOf(cx, id, "content")),
    {
      key: "keywords",
      label: "keywords",
      kind: "pills",
      pills: (e.keywords ?? []).map(pillLabel),
      prov: provOf(cx, id, "keywords")
    },
    ...extraFieldsFor(cx, id)
  ];
  return {
    id,
    name: String(e.title ?? "Untitled"),
    isNew: !!cx?.isNew?.[id],
    canAddField: true,
    draggable: true,
    fields
  };
}

/**
 * Distribute pool entries into [leading groups] + [custom groups] +
 * [fallback "Ungrouped"], honoring membership overrides and explicit
 * in-group order. Entries without a membership override land in
 * `defaultGroupId` (the fallback unless stated otherwise — STORY threads
 * default into the leading "Threads" group). The fallback group is dropped
 * when empty.
 */
function composeTab({
  leading = [],
  pool,
  customGroups,
  fallbackId,
  fallbackName,
  defaultGroupId = fallbackId,
  cx
}) {
  const membership = cx?.membership ?? {};
  const groupOrder = cx?.groupOrder ?? {};
  const buckets = new Map();
  const groups = [];

  for (const g of leading) {
    buckets.set(g.id, g);
    groups.push(g);
  }
  for (const g of customGroups) {
    const view = { id: g.id, name: g.name, custom: true, entries: [] };
    buckets.set(g.id, view);
    groups.push(view);
  }
  const fallback = { id: fallbackId, name: fallbackName, custom: false, entries: [] };
  buckets.set(fallbackId, fallback);
  groups.push(fallback);

  const defaultBucket = buckets.get(defaultGroupId) ?? fallback;
  for (const entry of pool) {
    const target = buckets.get(membership[entry.id]) ?? defaultBucket;
    target.entries.push(entry);
  }

  // Explicit order (drag-and-drop) first, remaining entries in collection order.
  for (const g of groups) {
    const order = groupOrder[g.id];
    if (!Array.isArray(order) || order.length === 0) continue;
    const rank = new Map(order.map((id, i) => [id, i]));
    g.entries.sort((a, b) => {
      const ra = rank.has(a.id) ? rank.get(a.id) : Infinity;
      const rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
      return ra - rb;
    });
  }

  // "Ungrouped" is the fallback bucket and is hidden when empty; built-in
  // and custom groups always render (a custom group may be staging).
  return groups.filter((g) => g !== fallback || g.entries.length > 0);
}

export default function buildCodexView(world) {
  const cx = world?.codex ?? {};
  const customGroups = (cx.groups ?? []).filter((g) => g?.custom);

  // STORY — Threads (quests) default into the leading "Threads" group and
  // may move to custom groups; Chronicle is a fixed built-in group rendered
  // last (the now marker follows it).
  const chronicle = chronicleEntries(world, cx);
  const storyGroups = composeTab({
    leading: [{ id: "story:threads", name: "Threads", custom: false, entries: [] }],
    pool: (world.quests ?? [])
      .filter((q) => q && typeof q === "object" && typeof q.id === "string")
      .map((q) => questEntry(q, cx)),
    customGroups: customGroups.filter((g) => g.tab === "story"),
    fallbackId: "story:ungrouped",
    fallbackName: "Ungrouped",
    defaultGroupId: "story:threads",
    cx
  });
  storyGroups.push({
    id: "story:chronicle",
    name: "Chronicle",
    custom: false,
    entries: chronicle.entries
  });

  const cast = composeTab({
    leading: [
      { id: "cast:you", name: "You", custom: false, entries: [pcEntry(world, cx)] }
    ],
    pool: (world.npcs ?? [])
      .filter((n) => n && typeof n === "object" && typeof n.id === "string")
      .map((n) => npcEntry(n, cx)),
    customGroups: customGroups.filter((g) => g.tab === "cast"),
    fallbackId: "cast:ungrouped",
    fallbackName: "Ungrouped",
    cx
  });

  const worldTab = composeTab({
    pool: (world.lorebook ?? [])
      .filter((e) => e && typeof e === "object" && typeof e.id === "string")
      .map((e) => loreEntry(e, cx)),
    customGroups: customGroups.filter((g) => g.tab === "world"),
    fallbackId: "world:ungrouped",
    fallbackName: "Ungrouped",
    cx
  });

  return {
    story: storyGroups,
    cast,
    world: worldTab,
    /** Beats not yet rolled into a scene — drives the "End scene" action. */
    unassignedBeats: chronicle.unassignedCount
  };
}
