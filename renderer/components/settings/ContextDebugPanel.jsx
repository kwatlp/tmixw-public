import React, { useEffect, useState } from "react";

/**
 * Context-assembly report for the last turn (moved out of the old Memory tab
 * in v0.8.4 — the Codex carries no debug lens). Read-only.
 */
export default function ContextDebugPanel() {
  const [report, setReport] = useState(null);
  const [missing, setMissing] = useState(false);

  const load = async () => {
    const r = await window.api.contextLastReport();
    setReport(r);
    setMissing(!r);
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="panel tight" style={{ background: "var(--panel-recess)", fontSize: "0.8rem" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <strong style={{ color: "var(--bone)" }}>Narrator context — last turn</strong>
        <button type="button" className="chip" onClick={load} style={{ cursor: "pointer", marginLeft: "auto" }}>
          refresh
        </button>
      </div>
      {missing ? (
        <p style={{ color: "var(--muted)", margin: 0 }}>No turn assembled yet this session.</p>
      ) : !report ? (
        <p style={{ color: "var(--muted)", margin: 0 }}>Loading…</p>
      ) : (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ color: "var(--gold)", textAlign: "left" }}>
                <th style={{ padding: "2px 6px" }}>section</th>
                <th style={{ padding: "2px 6px" }}>items</th>
                <th style={{ padding: "2px 6px" }}>chars</th>
                <th style={{ padding: "2px 6px" }}>~tokens</th>
                <th style={{ padding: "2px 6px" }}>dropped</th>
              </tr>
            </thead>
            <tbody style={{ color: "var(--muted)" }}>
              {report.sections.map((s) => (
                <tr key={s.label} style={{ borderTop: "1px solid var(--hair)" }}>
                  <td style={{ padding: "2px 6px" }}>{s.label}</td>
                  <td style={{ padding: "2px 6px" }}>{s.count ?? ""}</td>
                  <td style={{ padding: "2px 6px" }}>{s.chars}</td>
                  <td style={{ padding: "2px 6px" }}>{s.estTokens}</td>
                  <td style={{ padding: "2px 6px" }}>{s.dropped ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ color: "var(--muted)", margin: "6px 0 0" }}>
            total {report.totalChars} chars (~{report.totalEstTokens} tokens, chars/4 estimate) · {report.ts}
          </p>
          {report.timing ? (
            <p style={{ color: "var(--muted)", margin: "4px 0 0" }}>
              latency: assemble {report.timing.assembleMs}ms
              {report.timing.ttftMs != null ? ` · first token ${report.timing.ttftMs}ms` : ""}
              {report.timing.generateMs != null ? ` · generate ${report.timing.generateMs}ms` : ""}
              {report.timing.turnMs != null ? ` · turn ${report.timing.turnMs}ms` : ""}
              {report.timing.streamed === false ? " (non-streaming)" : ""}
            </p>
          ) : null}
          {(() => {
            const r = report.sections.find((s) => s.label === "retrieval");
            if (!r?.matches?.length) return null;
            return (
              <p style={{ color: "var(--muted)", margin: "4px 0 0" }}>
                recalled: {r.matches.map((m) => `${m.kind} ${m.id} (${m.score})`).join(", ")}
              </p>
            );
          })()}
        </>
      )}
    </div>
  );
}
