import React, { useCallback, useEffect, useRef, useState } from "react";
import "../styles/wizard.css";

const RECOMMENDED_MODELS = [
  {
    name: "Mistral 7B Instruct — Q4_K_M",
    href: "https://huggingface.co/TheBloke/Mistral-7B-Instruct-v0.2-GGUF"
  },
  {
    name: "Rocinante-X-12B",
    href: "https://huggingface.co/models?search=rocinante-x-12b"
  },
  {
    name: "MN Violet Lotus 12B",
    href: "https://huggingface.co/models?search=violet+lotus+12b"
  }
];

const WHISPER_OPTIONS = [
  { id: "medium", label: "Medium", size: "~1.5 GB", desc: "Best accuracy (recommended)" },
  { id: "small", label: "Small", size: "~466 MB", desc: "Balanced speed/accuracy" },
  { id: "base", label: "Base", size: "~142 MB", desc: "Fastest, lower accuracy" }
];

function formatBytes(n) {
  if (!n || n < 0) return "";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = n / 1024 ** 2;
  return `${mb.toFixed(1)} MB`;
}

function formatEta(received, total, startTime) {
  if (!received || !total || received >= total) return "";
  const elapsed = (Date.now() - startTime) / 1000;
  if (elapsed < 2) return "";
  const rate = received / elapsed;
  const remaining = (total - received) / rate;
  if (remaining < 60) return `~${Math.round(remaining)}s remaining`;
  return `~${Math.round(remaining / 60)}m remaining`;
}

export default function Wizard({ onDone }) {
  const [step, setStep] = useState(1);

  // FFmpeg state
  const [ffmpegStatus, setFfmpegStatus] = useState("checking"); // checking | found | downloading | done | error | manual
  const [ffmpegPath, setFfmpegPath] = useState("");
  const [ffmpegError, setFfmpegError] = useState("");

  // Mic state
  const [mics, setMics] = useState([]);
  const [mic, setMic] = useState("");
  const [micError, setMicError] = useState("");
  const [testStatus, setTestStatus] = useState("");

  // Whisper model download state
  const [whisperChoice, setWhisperChoice] = useState("medium");
  const [whisperStatus, setWhisperStatus] = useState("idle"); // idle | downloading | done | error
  const [whisperPath, setWhisperPath] = useState("");
  const [whisperError, setWhisperError] = useState("");
  const [downloadProgress, setDownloadProgress] = useState({ received: 0, total: 0, percent: 0 });
  const downloadStartRef = useRef(0);

  // STT backend choice
  const [sttBackend, setSttBackend] = useState("whisper-cpp"); // whisper-cpp | custom
  const [customSttBin, setCustomSttBin] = useState("");
  const [customSttArgs, setCustomSttArgs] = useState("");

  // whisper-cli binary state
  const [whisperCliStatus, setWhisperCliStatus] = useState("checking"); // checking | found | manual | browsed
  const [whisperCliBinPath, setWhisperCliBinPath] = useState("");

  // KoboldCPP binary state
  const [platform, setPlatform] = useState("win32");
  const [koboldStatus, setKoboldStatus] = useState("checking"); // checking | found | manual | browsed
  const [koboldBinPath, setKoboldBinPath] = useState("");

  // KoboldCPP GGUF state
  const [hasBundledModel, setHasBundledModel] = useState(false);
  const [modelPath, setModelPath] = useState("");
  const [modelSize, setModelSize] = useState(0);
  const [modelError, setModelError] = useState("");

  // Player agent opt-in (scaffolding only — config surface, no behavior)
  const [agentEnabled, setAgentEnabled] = useState(false);
  const [agentBackend, setAgentBackend] = useState("none");
  const [agentEndpoint, setAgentEndpoint] = useState("");
  const [agentBin, setAgentBin] = useState("");

  const [busy, setBusy] = useState(false);
  const [finishError, setFinishError] = useState("");
  const micPrefillRef = useRef("");

  const handleBrowseAgentBin = useCallback(async () => {
    try {
      const r = await window.api.settingsBrowseFile({
        title: "Select agent binary",
        extensions: ["exe"]
      });
      if (!r?.canceled && r?.path) setAgentBin(r.path);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    const off = window.api.onWizardDownloadProgress((p) => {
      setDownloadProgress(p);
    });
    return () => off();
  }, []);

  useEffect(() => {
    const off = window.api.onWizardDone(() => {
      onDone?.();
    });
    return () => off();
  }, [onDone]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await window.api.getBootstrap();
        if (cancelled) return;
        setHasBundledModel(Boolean(b?.hasBundledModel));
        if (b?.platform) setPlatform(b.platform);
        const pf = b?.wizardPrefill;
        if (!pf) return;
        if (pf.ffmpegBin) {
          setFfmpegPath(pf.ffmpegBin);
          setFfmpegStatus("found");
        }
        if (pf.whisperBin) {
          setWhisperCliBinPath(pf.whisperBin);
          setWhisperCliStatus("found");
        }
        if (pf.whisperModel) {
          setWhisperPath(pf.whisperModel);
          setWhisperStatus("done");
        }
        if (pf.koboldBin) {
          setKoboldBinPath(pf.koboldBin);
          setKoboldStatus("found");
        }
        if (pf.koboldModel) {
          setModelPath(pf.koboldModel);
        }
        if (pf.sttBackend === "custom" || pf.sttBackend === "whisper-cpp") {
          setSttBackend(pf.sttBackend);
        }
        if (pf.sttCustomBin) setCustomSttBin(pf.sttCustomBin);
        if (pf.sttCustomArgs != null) setCustomSttArgs(pf.sttCustomArgs);
        if (pf.ffmpegDshowAudioDevice) {
          micPrefillRef.current = pf.ffmpegDshowAudioDevice;
          setMic(pf.ffmpegDshowAudioDevice);
        }
      } catch {
        if (cancelled) return;
        setHasBundledModel(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // --- Step 2: FFmpeg check ---
  const checkFfmpeg = useCallback(async () => {
    setFfmpegStatus("checking");
    setFfmpegError("");
    try {
      const r = await window.api.wizardCheckFfmpeg();
      if (r?.found) {
        setFfmpegPath(r.path);
        setFfmpegStatus("found");
      } else {
        setFfmpegStatus("manual");
      }
    } catch (e) {
      setFfmpegError(e?.message ?? String(e));
      setFfmpegStatus("error");
    }
  }, []);

  useEffect(() => {
    if (step === 2 && !ffmpegPath) {
      checkFfmpeg();
    }
  }, [step, checkFfmpeg, ffmpegPath]);

  const handleDownloadFfmpeg = useCallback(async () => {
    setFfmpegStatus("downloading");
    setFfmpegError("");
    setDownloadProgress({ received: 0, total: 0, percent: 0 });
    try {
      const r = await window.api.wizardDownloadFfmpeg();
      if (r?.ok) {
        setFfmpegPath(r.path);
        setFfmpegStatus("done");
      } else if (r?.cancelled) {
        setFfmpegStatus("manual");
      } else {
        setFfmpegError(r?.error ?? "Download failed");
        setFfmpegStatus("error");
      }
    } catch (e) {
      setFfmpegError(e?.message ?? String(e));
      setFfmpegStatus("error");
    }
  }, []);

  // --- Step 3: Mic list ---
  const loadMics = useCallback(async () => {
    setMicError("");
    try {
      const r = await window.api.wizardListMics();
      const devices = Array.isArray(r?.devices) ? r.devices : [];
      setMics(devices);
      const preferred = micPrefillRef.current;
      if (preferred && devices.includes(preferred)) {
        setMic(preferred);
      } else {
        setMic(devices[0] ?? "");
      }
    } catch (e) {
      setMicError(e?.message ?? String(e));
    }
  }, []);

  useEffect(() => {
    if (step === 4) {
      loadMics();
    }
  }, [step, loadMics]);

  const handleTestMic = useCallback(async () => {
    setTestStatus("");
    if (!mic) {
      setTestStatus("Select a microphone first.");
      return;
    }
    setBusy(true);
    try {
      const r = await window.api.wizardTestMic(mic);
      if (!r?.ok || !r.audioBase64) {
        setTestStatus(r?.error ?? "Recording failed.");
        return;
      }
      const url = `data:audio/wav;base64,${r.audioBase64}`;
      const audio = new Audio(url);
      await audio.play();
      setTestStatus("Playback started — you should hear your voice.");
    } catch (e) {
      setTestStatus(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [mic]);

  // --- Step 4: Whisper model download ---
  const handleDownloadWhisper = useCallback(async () => {
    setWhisperError("");
    setWhisperStatus("downloading");
    setDownloadProgress({ received: 0, total: 0, percent: 0 });
    downloadStartRef.current = Date.now();
    try {
      const r = await window.api.wizardDownloadWhisper(whisperChoice);
      if (r?.ok) {
        setWhisperPath(r.path);
        setWhisperStatus("done");
      } else if (r?.cancelled) {
        setWhisperStatus("idle");
      } else {
        setWhisperError("Download failed.");
        setWhisperStatus("error");
      }
    } catch (e) {
      setWhisperError(e?.message ?? String(e));
      setWhisperStatus("error");
    }
  }, [whisperChoice]);

  const handleCancelDownload = useCallback(async () => {
    try {
      await window.api.wizardCancelDownload();
    } catch { /* ignore */ }
  }, []);

  // --- Step 3: whisper-cli detection ---
  const checkWhisperCli = useCallback(async () => {
    setWhisperCliStatus("checking");
    try {
      const r = await window.api.wizardCheckWhisperCli();
      if (r?.found) {
        setWhisperCliBinPath(r.path);
        setWhisperCliStatus("found");
      } else {
        setWhisperCliStatus("manual");
      }
    } catch {
      setWhisperCliStatus("manual");
    }
  }, []);

  useEffect(() => {
    if (step === 3 && !whisperCliBinPath) {
      checkWhisperCli();
    }
  }, [step, checkWhisperCli, whisperCliBinPath]);

  const handleBrowseWhisperCli = useCallback(async () => {
    try {
      const r = await window.api.wizardBrowseWhisperCli();
      if (r?.canceled) return;
      setWhisperCliBinPath(r.path);
      setWhisperCliStatus("browsed");
    } catch { /* ignore */ }
  }, []);

  // --- Step 6: KoboldCPP detection ---
  const checkKobold = useCallback(async () => {
    setKoboldStatus("checking");
    try {
      const r = await window.api.wizardCheckKobold();
      if (r?.found) {
        setKoboldBinPath(r.path);
        setKoboldStatus("found");
      } else {
        setKoboldStatus("manual");
      }
    } catch {
      setKoboldStatus("manual");
    }
  }, []);

  useEffect(() => {
    if (step === 6 && !koboldBinPath) {
      checkKobold();
    }
  }, [step, checkKobold, koboldBinPath]);

  const handleBrowseKobold = useCallback(async () => {
    try {
      const r = await window.api.wizardBrowseKobold();
      if (r?.canceled) return;
      setKoboldBinPath(r.path);
      setKoboldStatus("browsed");
    } catch { /* ignore */ }
  }, []);

  // --- Step 6: GGUF picker ---
  const handlePickModel = useCallback(async () => {
    setModelError("");
    try {
      const r = await window.api.wizardPickModel();
      if (r?.canceled) return;
      setModelPath(String(r?.path ?? ""));
      setModelSize(Number(r?.sizeBytes ?? 0));
    } catch (e) {
      setModelError(e?.message ?? String(e));
    }
  }, []);

  // --- Step 7: Finish ---
  const sttReady = sttBackend === "custom"
    ? Boolean(customSttBin)
    : Boolean(whisperCliBinPath) && (whisperStatus === "done" || whisperPath);

  const canFinish =
    Boolean(mic) &&
    sttReady &&
    Boolean(koboldBinPath) &&
    (hasBundledModel || (modelPath && modelPath.toLowerCase().endsWith(".gguf")));

  const handleFinish = useCallback(async () => {
    setFinishError("");
    if (!canFinish) return;
    setBusy(true);
    try {
      await window.api.wizardComplete({
        ffmpegDshowAudioDevice: mic,
        ffmpegBin: ffmpegPath || undefined,
        whisperBin: whisperCliBinPath || undefined,
        whisperModel: whisperPath || undefined,
        koboldBin: koboldBinPath || undefined,
        koboldModel: hasBundledModel ? "" : modelPath,
        sttBackend,
        sttCustomBin: sttBackend === "custom" ? customSttBin : undefined,
        sttCustomArgs: sttBackend === "custom" ? customSttArgs : undefined,
        agent: {
          enabled: agentEnabled,
          backend: agentEnabled ? agentBackend : "none",
          endpoint: agentEnabled && agentBackend === "kobold" ? agentEndpoint : "",
          bin: agentEnabled && agentBackend === "custom" ? agentBin : "",
          args: ""
        }
      });
    } catch (e) {
      setFinishError(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }, [canFinish, hasBundledModel, mic, modelPath, ffmpegPath, whisperCliBinPath, whisperPath, koboldBinPath, sttBackend, customSttBin, customSttArgs, agentEnabled, agentBackend, agentEndpoint, agentBin]);

  return (
    <div className="wizard-root" role="dialog" aria-label="Setup wizard">
      <div className="wizard-inner">
        {/* Step 1: Welcome */}
        {step === 1 && (
          <section className="wizard-panel">
            <p className="wizard-kicker">kʷátɬp presents</p>
            <h1 className="wizard-title">tmíxʷ</h1>
            <p className="wizard-tagline">
              Your story. Your hardware. Your rules.
            </p>
            <button
              type="button"
              className="wizard-primary"
              onClick={() => setStep(2)}
            >
              Begin Setup
            </button>
          </section>
        )}

        {/* Step 2: FFmpeg check / download */}
        {step === 2 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">FFmpeg</h2>
            <p className="wizard-copy">
              tmíxʷ uses FFmpeg for audio capture. Checking your system…
            </p>

            {ffmpegStatus === "checking" && (
              <p className="wizard-muted">Detecting FFmpeg on PATH…</p>
            )}

            {ffmpegStatus === "found" && (
              <div className="wizard-success">
                <p>FFmpeg found: <code>{ffmpegPath}</code></p>
              </div>
            )}

            {ffmpegStatus === "done" && (
              <div className="wizard-success">
                <p>FFmpeg installed: <code>{ffmpegPath}</code></p>
              </div>
            )}

            {ffmpegStatus === "manual" && (
              <div>
                <p className="wizard-copy">
                  FFmpeg was not found on your system.
                </p>
                {platform === "win32" && (
                  <button
                    type="button"
                    className="wizard-secondary"
                    onClick={handleDownloadFfmpeg}
                  >
                    Download FFmpeg (~90 MB)
                  </button>
                )}
                {platform === "darwin" && (
                  <div className="wizard-install-instructions">
                    <p className="wizard-copy">Install FFmpeg with Homebrew:</p>
                    <code className="wizard-code-block">brew install ffmpeg</code>
                    <p className="wizard-muted">
                      After installing, click Retry to detect it.
                    </p>
                    <button type="button" className="wizard-secondary" onClick={checkFfmpeg}>
                      Retry
                    </button>
                  </div>
                )}
                {platform === "linux" && (
                  <div className="wizard-install-instructions">
                    <p className="wizard-copy">Install FFmpeg with your package manager:</p>
                    <code className="wizard-code-block">sudo apt install ffmpeg</code>
                    <p className="wizard-muted">
                      Or use <code>dnf install ffmpeg</code> (Fedora) / <code>pacman -S ffmpeg</code> (Arch).
                      After installing, click Retry.
                    </p>
                    <button type="button" className="wizard-secondary" onClick={checkFfmpeg}>
                      Retry
                    </button>
                  </div>
                )}
              </div>
            )}

            {ffmpegStatus === "downloading" && (
              <div className="wizard-download-progress">
                <div className="wizard-progress-bar">
                  <div
                    className="wizard-progress-fill"
                    style={{ width: `${Math.max(downloadProgress.percent, 2)}%` }}
                  />
                </div>
                <p className="wizard-muted">
                  {downloadProgress.percent >= 0
                    ? `${downloadProgress.percent}% — ${formatBytes(downloadProgress.received)}`
                    : `Downloading… ${formatBytes(downloadProgress.received)}`}
                </p>
                <button
                  type="button"
                  className="wizard-cancel"
                  onClick={handleCancelDownload}
                >
                  Cancel
                </button>
              </div>
            )}

            {ffmpegStatus === "error" && (
              <div>
                <p className="wizard-error">{ffmpegError}</p>
                <button
                  type="button"
                  className="wizard-secondary"
                  onClick={checkFfmpeg}
                >
                  Retry
                </button>
              </div>
            )}

            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(1)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(3)}
                disabled={ffmpegStatus === "checking" || ffmpegStatus === "downloading"}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {/* Step 3: whisper-cli detection */}
        {step === 3 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">Speech Recognition Engine</h2>
            <p className="wizard-copy">
              Choose how tmíxʷ converts speech to text.
            </p>

            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                className={sttBackend === "whisper-cpp" ? "wizard-primary" : "wizard-secondary"}
                onClick={() => setSttBackend("whisper-cpp")}
              >
                Whisper.cpp (default)
              </button>
              <button
                type="button"
                className={sttBackend === "custom" ? "wizard-primary" : "wizard-secondary"}
                onClick={() => setSttBackend("custom")}
              >
                Custom binary
              </button>
            </div>

            {sttBackend === "whisper-cpp" && (
              <>
                {whisperCliStatus === "checking" && (
                  <p className="wizard-muted">Detecting whisper-cli…</p>
                )}

                {(whisperCliStatus === "found" || whisperCliStatus === "browsed") && (
                  <div className="wizard-success">
                    <p>whisper-cli {whisperCliStatus === "found" ? "found" : "selected"}: <code>{whisperCliBinPath}</code></p>
                  </div>
                )}

                {whisperCliStatus === "manual" && (
                  <div>
                    <p className="wizard-copy">
                      whisper-cli was not found on your system. Download the
                      whisper.cpp release for your platform and extract
                      whisper-cli{platform === "win32" ? ".exe" : ""}.
                    </p>
                    <p className="wizard-copy">
                      <a
                        href="https://github.com/ggerganov/whisper.cpp/releases"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Download from GitHub Releases
                      </a>
                    </p>
                    {platform !== "win32" && (
                      <p className="wizard-muted">
                        On macOS / Linux you can also build from source.
                      </p>
                    )}
                  </div>
                )}

                {(whisperCliStatus === "manual" || whisperCliStatus === "browsed") && (
                  <button
                    type="button"
                    className="wizard-secondary"
                    onClick={handleBrowseWhisperCli}
                  >
                    Browse for whisper-cli…
                  </button>
                )}

                {whisperCliStatus === "manual" && (
                  <button
                    type="button"
                    className="wizard-secondary"
                    onClick={checkWhisperCli}
                    style={{ marginLeft: 8 }}
                  >
                    Retry detection
                  </button>
                )}
              </>
            )}

            {sttBackend === "custom" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label className="wizard-muted" style={{ display: "block", marginBottom: 4 }}>STT binary path</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      type="text"
                      className="wizard-input"
                      value={customSttBin}
                      readOnly
                      placeholder="Select your STT binary…"
                      style={{ flex: 1 }}
                    />
                    <button
                      type="button"
                      className="wizard-secondary"
                      onClick={async () => {
                        try {
                          const r = await window.api.settingsBrowseFile({ title: "Select STT binary", extensions: ["exe"] });
                          if (!r?.canceled && r?.path) setCustomSttBin(r.path);
                        } catch { /* ignore */ }
                      }}
                    >
                      Browse
                    </button>
                  </div>
                </div>
                <div>
                  <label className="wizard-muted" style={{ display: "block", marginBottom: 4 }}>
                    Argument template (use {"{input}"} for WAV path, {"{output}"} for output file)
                  </label>
                  <input
                    type="text"
                    className="wizard-input"
                    value={customSttArgs}
                    onChange={(e) => setCustomSttArgs(e.target.value)}
                    placeholder="-f {input} -o {output}"
                    style={{ width: "100%" }}
                  />
                </div>
              </div>
            )}

            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(2)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(4)}
                disabled={sttBackend === "whisper-cpp" ? !whisperCliBinPath : !customSttBin}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {/* Step 4: Microphone */}
        {step === 4 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">Microphone</h2>
            <p className="wizard-copy">
              Choose the microphone tmíxʷ should listen to. You can test a
              two-second clip before continuing.
            </p>
            {micError ? (
              <p className="wizard-error">{micError}</p>
            ) : null}
            <label className="wizard-label" htmlFor="wizard-mic">
              Input device
            </label>
            <select
              id="wizard-mic"
              className="wizard-select"
              value={mic}
              onChange={(e) => setMic(e.target.value)}
            >
              {mics.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={handleTestMic}
                disabled={busy || !mic}
              >
                Test mic
              </button>
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(3)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(sttBackend === "custom" ? 6 : 5)}
                disabled={!mic}
              >
                Continue
              </button>
            </div>
            {testStatus ? (
              <p className="wizard-muted">{testStatus}</p>
            ) : null}
          </section>
        )}

        {/* Step 5: Whisper model selection + download */}
        {step === 5 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">Speech Recognition</h2>
            <p className="wizard-copy">
              Choose a Whisper model for speech-to-text. Larger models are more
              accurate but take longer to download and use more memory.
            </p>

            {whisperStatus === "idle" || whisperStatus === "error" ? (
              <>
                <div className="wizard-model-options">
                  {WHISPER_OPTIONS.map((opt) => (
                    <label key={opt.id} className="wizard-radio-card">
                      <input
                        type="radio"
                        name="whisper-model"
                        value={opt.id}
                        checked={whisperChoice === opt.id}
                        onChange={() => setWhisperChoice(opt.id)}
                      />
                      <div className="wizard-radio-content">
                        <strong>{opt.label}</strong>
                        <span className="wizard-muted">{opt.size}</span>
                        <span className="wizard-muted">{opt.desc}</span>
                      </div>
                    </label>
                  ))}
                </div>
                {whisperError && <p className="wizard-error">{whisperError}</p>}
                <button
                  type="button"
                  className="wizard-primary"
                  onClick={handleDownloadWhisper}
                >
                  Download Model
                </button>
              </>
            ) : null}

            {whisperStatus === "downloading" && (
              <div className="wizard-download-progress">
                <div className="wizard-progress-bar">
                  <div
                    className="wizard-progress-fill"
                    style={{ width: `${Math.max(downloadProgress.percent, 2)}%` }}
                  />
                </div>
                <p className="wizard-muted">
                  {downloadProgress.percent}% — {formatBytes(downloadProgress.received)} / {formatBytes(downloadProgress.total)}
                  {" "}{formatEta(downloadProgress.received, downloadProgress.total, downloadStartRef.current)}
                </p>
                <button
                  type="button"
                  className="wizard-cancel"
                  onClick={handleCancelDownload}
                >
                  Cancel
                </button>
              </div>
            )}

            {whisperStatus === "done" && (
              <div className="wizard-success">
                <p>Model downloaded successfully.</p>
                <p className="wizard-muted">{whisperPath}</p>
              </div>
            )}

            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(4)}
                disabled={whisperStatus === "downloading"}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(6)}
                disabled={whisperStatus !== "done"}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {/* Step 6: KoboldCPP binary detection */}
        {step === 6 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">KoboldCPP</h2>
            <p className="wizard-copy">
              tmíxʷ uses KoboldCPP to run your language model locally.
              Checking your system…
            </p>

            {koboldStatus === "checking" && (
              <p className="wizard-muted">Detecting KoboldCPP…</p>
            )}

            {(koboldStatus === "found" || koboldStatus === "browsed") && (
              <div className="wizard-success">
                <p>KoboldCPP {koboldStatus === "found" ? "found" : "selected"}: <code>{koboldBinPath}</code></p>
              </div>
            )}

            {koboldStatus === "manual" && (
              <div>
                <p className="wizard-copy">
                  KoboldCPP was not found on your system. Download the variant
                  matching your GPU, then select the executable below.
                </p>
                <ul className="wizard-install-instructions">
                  <li><strong>NVIDIA:</strong> CUDA build (recommended)</li>
                  <li><strong>AMD:</strong> OpenCL / Vulkan build</li>
                  <li><strong>No GPU:</strong> CPU-only build</li>
                </ul>
                <p className="wizard-copy">
                  <a
                    href="https://github.com/LostRuins/koboldcpp/releases"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Download from GitHub Releases
                  </a>
                </p>
                {platform !== "win32" && (
                  <p className="wizard-muted">
                    On macOS / Linux you can also build from source.
                  </p>
                )}
              </div>
            )}

            {(koboldStatus === "manual" || koboldStatus === "browsed") && (
              <button
                type="button"
                className="wizard-secondary"
                onClick={handleBrowseKobold}
              >
                Browse for KoboldCPP…
              </button>
            )}

            {koboldStatus === "manual" && (
              <button
                type="button"
                className="wizard-secondary"
                onClick={checkKobold}
                style={{ marginLeft: 8 }}
              >
                Retry detection
              </button>
            )}

            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(5)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(7)}
                disabled={!koboldBinPath}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {/* Step 7: KoboldCPP GGUF model */}
        {step === 7 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">Language Model</h2>
            {hasBundledModel ? (
              <p className="wizard-copy">Using bundled model in the installer.</p>
            ) : (
              <>
                <p className="wizard-copy">
                  Select a GGUF model for KoboldCPP. A Q4_K_M class 7B–12B model
                  is a good starting point on mid-range GPUs.
                </p>
                <button
                  type="button"
                  className="wizard-secondary"
                  onClick={handlePickModel}
                >
                  Select your GGUF model file
                </button>
                {modelError ? (
                  <p className="wizard-error">{modelError}</p>
                ) : null}
                {modelPath ? (
                  <div className="wizard-model-meta">
                    <div className="wizard-model-name">{modelPath}</div>
                    <div className="wizard-muted">
                      {formatBytes(modelSize)}
                    </div>
                  </div>
                ) : null}
                <div className="wizard-recs">
                  <div className="wizard-label">Recommended models</div>
                  <ul>
                    {RECOMMENDED_MODELS.map((m) => (
                      <li key={m.href}>
                        <a href={m.href} target="_blank" rel="noreferrer">
                          {m.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(6)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(8)}
                disabled={!hasBundledModel && !modelPath}
              >
                Continue
              </button>
            </div>
          </section>
        )}

        {/* Step 8: Player agent opt-in (scaffolding only — no agent behavior ships yet) */}
        {step === 8 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">Player Agent</h2>
            <p className="wizard-copy">
              Optional, for a future release: a player agent that can act on
              your behalf. Nothing runs yet — opting in just records where the
              agent would run. You can enable or change this later in
              Settings → Player Agent.
            </p>
            <label className="wizard-copy" style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={agentEnabled}
                onChange={(e) => setAgentEnabled(e.target.checked)}
              />
              Configure a player agent backend
            </label>
            {agentEnabled && (
              <div style={{ marginTop: 8 }}>
                <select
                  className="wizard-select"
                  value={agentBackend}
                  onChange={(e) => setAgentBackend(e.target.value)}
                >
                  <option value="none">Not configured yet</option>
                  <option value="kobold">KoboldCPP endpoint</option>
                  <option value="custom">Custom binary</option>
                </select>
                {agentBackend === "kobold" && (
                  <input
                    type="text"
                    className="wizard-input"
                    value={agentEndpoint}
                    onChange={(e) => setAgentEndpoint(e.target.value)}
                    placeholder="http://127.0.0.1:5001/api/v1/generate"
                    style={{ marginTop: 8, width: "100%" }}
                  />
                )}
                {agentBackend === "custom" && (
                  <button
                    type="button"
                    className="wizard-secondary"
                    style={{ marginTop: 8 }}
                    onClick={handleBrowseAgentBin}
                  >
                    {agentBin ? agentBin : "Browse for agent binary"}
                  </button>
                )}
              </div>
            )}
            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(7)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={() => setStep(9)}
              >
                {agentEnabled ? "Continue" : "Skip"}
              </button>
            </div>
          </section>
        )}

        {/* Step 9: Finish */}
        {step === 9 && (
          <section className="wizard-panel">
            <h2 className="wizard-heading">You&apos;re set up.</h2>
            <p className="wizard-tagline">tmíxʷ is ready.</p>
            {finishError ? (
              <p className="wizard-error">{finishError}</p>
            ) : null}
            <div className="wizard-actions">
              <button
                type="button"
                className="wizard-secondary"
                onClick={() => setStep(8)}
              >
                Back
              </button>
              <button
                type="button"
                className="wizard-primary"
                onClick={handleFinish}
                disabled={busy || !canFinish}
              >
                Start Playing
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
