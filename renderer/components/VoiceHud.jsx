import React, { useCallback, useEffect, useRef, useState } from "react";

/**
 * Summonable voice HUD (v0.8.4): docked between the narrative panel and the
 * input bar; hidden by default — typists never see it. Level meter is
 * renderer-side metering only (getUserMedia + AnalyserNode); actual capture
 * stays ffmpeg in the main process, so a metering failure degrades to idle
 * bars without breaking push-to-talk.
 *
 * Transcript appears on release (whisper transcribes the recorded WAV):
 * while recording the row shows "Listening…"; with send-on-release ON the
 * transcript sends as the key lifts, OFF it lands in the input for review.
 */
const BAR_HEIGHTS = [5, 8, 11, 14, 16, 11, 7];

export default function VoiceHud({ recording, onHide }) {
  const [cfg, setCfg] = useState(null);
  const [devices, setDevices] = useState([]);
  const [level, setLevel] = useState(0);
  const [meterError, setMeterError] = useState(false);
  const [rebinding, setRebinding] = useState(false);
  const [rebindNote, setRebindNote] = useState("");
  const [heard, setHeard] = useState("");

  const loadCfg = useCallback(async () => {
    try {
      setCfg(await window.api.voiceGetConfig());
    } catch {
      setCfg({ autoSend: false, device: "", pttKey: "Backquote", pttLabel: "`" });
    }
  }, []);

  useEffect(() => {
    loadCfg();
    (async () => {
      try {
        const r = await window.api.settingsGetMicList();
        setDevices(Array.isArray(r?.devices) ? r.devices : []);
      } catch {
        setDevices([]);
      }
    })();
  }, [loadCfg]);

  // Level meter — open only while the HUD is visible, released on unmount.
  useEffect(() => {
    let stream = null;
    let ctx = null;
    let raf = 0;
    let cancelled = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 512;
        src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          // RMS with a little gain so speech reaches the top bars.
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        if (!cancelled) setMeterError(true);
      }
    })();
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
    };
  }, []);

  // Transcript row: "Listening…" while recording, the transcript on release.
  useEffect(() => {
    if (recording) setHeard("");
    const offDraft = window.api.onTranscriptDraft((p) => {
      const t = String(p?.text ?? "").trim();
      if (t && t !== "[BLANK_AUDIO]") setHeard(t);
    });
    const offFinal = window.api.onTranscript((p) => {
      const t = String(p?.text ?? "").trim();
      if (t && t !== "[BLANK_AUDIO]") setHeard(t);
    });
    return () => {
      offDraft();
      offFinal();
    };
  }, [recording]);

  // Rebind: capture the next keypress.
  useEffect(() => {
    if (!rebinding) return undefined;
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      setRebinding(false);
      if (e.key === "Escape") return;
      const r = await window.api.pttSetKey(e.code);
      if (r?.ok) {
        setRebindNote("");
        loadCfg();
      } else {
        setRebindNote("key not supported");
        setTimeout(() => setRebindNote(""), 2500);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [rebinding, loadCfg]);

  const setAutoSend = async (autoSend) => {
    setCfg((c) => (c ? { ...c, autoSend } : c));
    await window.api.voiceSetConfig({ autoSend });
  };

  const setDevice = async (device) => {
    setCfg((c) => (c ? { ...c, device } : c));
    await window.api.voiceSetConfig({ device });
  };

  const litBars = Math.round(level * BAR_HEIGHTS.length);

  return (
    <div className="panel tight voice-hud">
      <div className="voice-hud-header">
        <span className="voice-hud-kicker">Voice</span>
        <span className="voice-meter" title={meterError ? "meter unavailable" : "input level"}>
          {BAR_HEIGHTS.map((h, i) => (
            <span
              key={i}
              className={
                !meterError && i < litBars
                  ? recording
                    ? "voice-bar live"
                    : "voice-bar lit"
                  : "voice-bar"
              }
              style={{ height: h }}
            />
          ))}
        </span>
        {recording ? <span className="voice-recording">● recording</span> : null}
        <span className="cdx-spacer" />
        <button type="button" className="voice-hud-hide" onClick={onHide}>
          hide ⌄
        </button>
      </div>

      <div className="voice-hud-controls">
        <span className="voice-control">
          <span className="voice-control-label">Push-to-talk</span>
          <button
            type="button"
            className={rebinding ? "voice-keycap listening" : "voice-keycap"}
            title="Click, then press the key to bind"
            onClick={() => setRebinding(true)}
          >
            {rebinding ? "press a key…" : cfg?.pttLabel ?? "`"}
          </button>
          {rebindNote ? <span className="voice-help">{rebindNote}</span> : null}
        </span>

        <span className="voice-control">
          <span className="voice-control-label">Device</span>
          <select
            className="voice-device"
            value={cfg?.device ?? ""}
            onChange={(e) => setDevice(e.target.value)}
          >
            <option value="">auto</option>
            {devices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </span>

        <span className="voice-control">
          <span className="voice-control-label">Send on release</span>
          <button
            type="button"
            role="switch"
            aria-checked={cfg?.autoSend === true}
            className={cfg?.autoSend ? "voice-toggle on" : "voice-toggle"}
            onClick={() => setAutoSend(!(cfg?.autoSend === true))}
          >
            <span className="voice-toggle-knob" />
          </button>
          <span className="voice-help">
            {cfg?.autoSend ? "sends as you release the key" : "review the transcript first"}
          </span>
        </span>
      </div>

      {recording || heard ? (
        <div className="voice-hearing">
          <span className="voice-control-label">{recording ? "Hearing…" : "Heard"}</span>
          <span className="voice-hearing-text">
            {recording && !heard ? "Listening…" : heard}
          </span>
        </div>
      ) : null}
    </div>
  );
}
