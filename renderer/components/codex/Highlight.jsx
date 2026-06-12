import React from "react";

/**
 * Substring highlight for search hits: gold-soft background, no font change.
 * Case-insensitive; renders plain text when no query.
 */
export default function Highlight({ text, query }) {
  const t = String(text ?? "");
  const q = String(query ?? "");
  if (!q) return t;
  const lower = t.toLowerCase();
  const parts = [];
  let i = 0;
  for (;;) {
    const hit = lower.indexOf(q, i);
    if (hit < 0) {
      parts.push(t.slice(i));
      break;
    }
    if (hit > i) parts.push(t.slice(i, hit));
    parts.push(
      <span key={hit} className="cdx-hit">
        {t.slice(hit, hit + q.length)}
      </span>
    );
    i = hit + q.length;
  }
  return parts;
}
