import React from "react";

/** The "now" marker after the Chronicle — new beats append above it. */
export default function NowMarker() {
  return (
    <div className="cdx-now">
      <span className="cdx-now-dot" />
      <span className="cdx-now-label">now</span>
    </div>
  );
}
