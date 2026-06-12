import React, { useCallback, useEffect, useState } from "react";
import ContextDebugPanel from "./settings/ContextDebugPanel.jsx";
import "../styles/settings.css";

const TABS = [
  { id: "kobold", label: "Backend" },
  { id: "stt", label: "STT" },
  { id: "narrative", label: "Narrative" },
  { id: "extractor", label: "Extractor" },
  { id: "loreCorrection", label: "Lore Correction" },
  { id: "lorebook", label: "Lorebook" },
  { id: "input", label: "Input" },
  { id: "atmosphere", label: "Atmosphere" },
  { id: "agent", label: "Player Agent" },
  { id: "worldData", label: "World Data" },
  { id: "debug", label: "Debug" },
  { id: "paths", label: "Paths" }
];

function SliderField({ label, value, onChange, min, max, step, restart }) {
  return (
    <div className="settings-field">
      <label className="settings-field-label">
        {label}
        {restart && <span className="settings-restart-badge">⟳ restart</span>}
      </label>
      <div className="settings-slider-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value ?? min}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span className="settings-slider-value">{value ?? min}</span>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, min, max, restart }) {
  return (
    <div className="settings-field">
      <label className="settings-field-label">
        {label}
        {restart && <span className="settings-restart-badge">⟳ restart</span>}
      </label>
      <input
        type="number"
        className="settings-input"
        min={min}
        max={max}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      />
    </div>
  );
}

function TextField({ label, value, onChange, restart, placeholder }) {
  return (
    <div className="settings-field">
      <label className="settings-field-label">
        {label}
        {restart && <span className="settings-restart-badge">⟳ restart</span>}
      </label>
      <input
        type="text"
        className="settings-input"
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function ToggleField({ label, value, onChange }) {
  return (
    <div className="settings-field settings-field-toggle">
      <label className="settings-field-label">{label}</label>
      <button
        type="button"
        className={`settings-toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        aria-pressed={value}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  );
}

function TextareaField({ label, value, onChange, onReset }) {
  return (
    <div className="settings-field">
      <div className="settings-field-label-row">
        <label className="settings-field-label">{label}</label>
        {onReset && (
          <button type="button" className="settings-link-btn" onClick={onReset}>
            Reset to default
          </button>
        )}
      </div>
      <textarea
        className="settings-textarea"
        value={value ?? ""}
        rows={8}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

function FilePickerField({ label, value, onChange, restart, extensions, configKey }) {
  const handleBrowse = useCallback(async () => {
    try {
      const r = await window.api.settingsBrowseFile({
        title: `Select ${label}`,
        extensions: extensions ?? []
      });
      if (!r?.canceled && r?.path) {
        onChange(r.path);
      }
    } catch { /* ignore */ }
  }, [label, extensions, onChange]);

  return (
    <div className="settings-field">
      <label className="settings-field-label">
        {label}
        {restart && <span className="settings-restart-badge">⟳ restart</span>}
      </label>
      <div className="settings-file-row">
        <input
          type="text"
          className="settings-input settings-input-file"
          value={value ?? ""}
          readOnly
          title={value ?? ""}
        />
        <button
          type="button"
          className="settings-browse-btn"
          onClick={handleBrowse}
        >
          Browse
        </button>
      </div>
    </div>
  );
}

const BACKEND_OPTIONS = [
  ["koboldcpp", "KoboldCPP (default — auto-launched)"],
  ["llamacpp", "llama.cpp server"],
  ["openai", "OpenAI-compatible server (LM Studio, vLLM, …)"],
  ["ollama", "Ollama"],
  ["custom", "Custom endpoint"]
];

/** Inference backend selection (v0.8.0 D7) — formerly the KoboldCPP tab. */
function BackendTab({ draft, setField }) {
  const [status, setStatus] = useState("unknown");
  const [validation, setValidation] = useState(null);
  const [validating, setValidating] = useState(false);
  const inference = draft.inference ?? {};
  const backend = inference.backend ?? "koboldcpp";
  const custom = inference.custom ?? {};

  const setInf = (key, val) => setField("inference", { ...inference, [key]: val });
  const setCustom = (key, val) =>
    setField("inference", { ...inference, custom: { ...custom, [key]: val } });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.koboldStatus();
        if (cancelled) return;
        setStatus(r?.running ? "running" : "stopped");
      } catch {
        if (!cancelled) setStatus("stopped");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const validate = async () => {
    setValidating(true);
    setValidation(null);
    try {
      const r = await window.api.validateInference(inference);
      setValidation(r);
    } catch (err) {
      setValidation({ ok: false, error: String(err?.message ?? err) });
    } finally {
      setValidating(false);
    }
  };

  return (
    <div className="settings-tab-body">
      <div className="settings-field">
        <label className="settings-field-label">Inference backend</label>
        <select
          className="settings-select"
          value={backend}
          onChange={(e) => { setInf("backend", e.target.value); setValidation(null); }}
        >
          {BACKEND_OPTIONS.map(([id, label]) => (
            <option key={id} value={id}>{label}</option>
          ))}
        </select>
      </div>

      {backend !== "koboldcpp" && backend !== "custom" && (
        <TextField
          label="Server URL"
          value={inference.url ?? ""}
          placeholder={backend === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8080"}
          onChange={(v) => setInf("url", v)}
        />
      )}
      {backend === "ollama" && (
        <TextField
          label="Ollama model tag"
          value={inference.model ?? ""}
          placeholder="mistral:7b"
          onChange={(v) => setInf("model", v)}
        />
      )}
      {backend === "custom" && (
        <>
          <TextField
            label="Endpoint URL (POST)"
            value={custom.url ?? ""}
            placeholder="http://127.0.0.1:9000/generate"
            onChange={(v) => setCustom("url", v)}
          />
          <TextareaField
            label='Body template (JSON with {{prompt}}, {{max_length}}, {{temperature}}, {{top_p}}, {{stop_json}})'
            value={custom.bodyTemplate ?? ""}
            onChange={(v) => setCustom("bodyTemplate", v)}
          />
          <TextField
            label='Response path to the completion text (e.g. "choices.0.text")'
            value={custom.responsePath ?? ""}
            onChange={(v) => setCustom("responsePath", v)}
          />
        </>
      )}

      <div className="settings-field">
        <button
          type="button"
          className="btn gold-line"
          disabled={validating}
          onClick={validate}
          style={{ padding: "4px 16px", fontSize: "0.8rem" }}
        >
          {validating ? "Checking…" : "Validate backend"}
        </button>
        {validation && (
          <span
            style={{
              marginLeft: 10,
              fontSize: "0.8rem",
              color: validation.ok ? "var(--gold)" : "var(--oxblood, #a33)"
            }}
          >
            {validation.ok ? `✓ ${validation.model || "reachable"}` : `✗ ${validation.error}`}
          </span>
        )}
      </div>

      {backend === "koboldcpp" && (
        <>
          <FilePickerField
            label="Model path (.gguf)"
            value={draft.koboldModel}
            restart
            onChange={(path) => setField("koboldModel", path)}
            extensions={["gguf"]}
          />
          <NumberField
            label="Context size"
            value={draft.koboldContextSize ?? 4096}
            onChange={(v) => setField("koboldContextSize", v)}
            min={512}
            max={16384}
            restart
          />
          <NumberField
            label="KoboldCPP port"
            value={draft.koboldPort ?? 5001}
            onChange={(v) => setField("koboldPort", v)}
            min={1024}
            max={65535}
            restart
          />
          <TextField
            label="Host"
            value={draft.koboldHost ?? "127.0.0.1"}
            onChange={(v) => setField("koboldHost", v)}
            restart
          />
          <ToggleField
            label="Auto-launch KoboldCPP"
            value={draft.koboldAutoLaunch !== false}
            onChange={(v) => setField("koboldAutoLaunch", v)}
          />
          <div className="settings-field">
            <label className="settings-field-label">Status</label>
            <span className={`settings-status settings-status-${status}`}>
              {status === "running" ? "🟢 Running" : status === "stopped" ? "🔴 Not running" : "…"}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// Mirror of core/length_presets.js max_length values (renderer cannot import core ESM).
const LENGTH_PRESET_INFO = {
  brief: { label: "Brief", max_length: 120 },
  standard: { label: "Standard", max_length: 220 },
  rich: { label: "Rich", max_length: 400 },
  sprawling: { label: "Sprawling", max_length: 700 }
};

// Mirror of core/style_presets.js labels (ids must match; directives live in core).
const STYLE_OPTIONS = {
  tone: [
    ["neutral", "Neutral"],
    ["grim", "Grim"],
    ["whimsical", "Whimsical"],
    ["heroic", "Heroic"],
    ["eerie", "Eerie"]
  ],
  pov: [
    ["second", "Second person (you)"],
    ["third", "Third person"]
  ],
  tense: [
    ["present", "Present tense"],
    ["past", "Past tense"]
  ],
  rating: [
    ["standard", "Standard"],
    ["family", "Family-friendly"],
    ["mature", "Mature"]
  ]
};

const STYLE_LABELS = { tone: "Tone", pov: "Point of view", tense: "Tense", rating: "Content rating" };

function GenParamsTab({ draft, setField, prefix, onResetPrompt, promptLabel, lengthControl }) {
  const params = draft[prefix] ?? {};
  const setParam = (key, val) => {
    setField(prefix, { ...params, [key]: val });
  };
  const lengthPreset = params.lengthPreset ?? "standard";
  const presetInfo = lengthControl ? LENGTH_PRESET_INFO[lengthPreset] : null;

  return (
    <div className="settings-tab-body">
      {lengthControl && (
        <div className="settings-field">
          <label className="settings-field-label">Response length</label>
          <select
            className="settings-select"
            value={lengthPreset}
            onChange={(e) => setParam("lengthPreset", e.target.value)}
          >
            {Object.entries(LENGTH_PRESET_INFO).map(([id, p]) => (
              <option key={id} value={id}>{p.label}</option>
            ))}
            <option value="custom">Custom (use Max length slider)</option>
          </select>
        </div>
      )}
      {lengthControl && (
        <>
          {Object.keys(STYLE_OPTIONS).map((axis) => (
            <div className="settings-field" key={axis}>
              <label className="settings-field-label">{STYLE_LABELS[axis]}</label>
              <select
                className="settings-select"
                value={params.style?.[axis] ?? STYLE_OPTIONS[axis][0][0]}
                onChange={(e) =>
                  setParam("style", { ...(params.style ?? {}), [axis]: e.target.value })
                }
              >
                {STYLE_OPTIONS[axis].map(([id, label]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>
          ))}
          <TextField
            label="Style notes (freeform, always in the narrator's directives)"
            value={params.style?.notes ?? ""}
            placeholder="e.g. lots of NPC dialogue, keep scenes grounded"
            onChange={(v) => setParam("style", { ...(params.style ?? {}), notes: v })}
          />
          <NumberField
            label="Auto-keep delay for responses (ms, 0 = immediate)"
            value={params.acceptGraceMs ?? 8000}
            onChange={(v) => setParam("acceptGraceMs", v ?? 8000)}
            min={0}
            max={120000}
          />
          <div className="settings-field">
            <label className="settings-field-label">Prompt template</label>
            <select
              className="settings-select"
              value={params.template ?? "auto"}
              onChange={(e) => setParam("template", e.target.value)}
            >
              <option value="auto">Auto (detect from model name)</option>
              <option value="plain">Plain (User:/Assistant: lines)</option>
              <option value="chatml">ChatML (Qwen, Hermes, …)</option>
              <option value="llama3">Llama 3</option>
              <option value="mistral">Mistral [INST]</option>
            </select>
          </div>
        </>
      )}
      <SliderField label="Temperature" value={params.temperature} onChange={(v) => setParam("temperature", v)} min={0} max={2} step={0.05} />
      {presetInfo ? (
        <div className="settings-field">
          <label className="settings-field-label">Max length</label>
          <span style={{ fontSize: "0.85rem", color: "var(--muted)" }}>
            {presetInfo.max_length} (set by the {presetInfo.label} preset)
          </span>
        </div>
      ) : (
        <SliderField label="Max length" value={params.max_length} onChange={(v) => setParam("max_length", v)} min={50} max={1024} step={10} />
      )}
      <SliderField label="Top-p" value={params.top_p} onChange={(v) => setParam("top_p", v)} min={0} max={1} step={0.05} />
      <NumberField label="Top-k" value={params.top_k} onChange={(v) => setParam("top_k", v)} min={0} max={200} />
      <SliderField label="Rep pen" value={params.rep_pen} onChange={(v) => setParam("rep_pen", v)} min={1} max={1.5} step={0.01} />
      <TextField label="Stop sequences (comma-separated)" value={(params.stop_sequence ?? []).join(", ")} onChange={(v) => setParam("stop_sequence", v.split(",").map(s => s.trim()).filter(Boolean))} />
      <TextareaField
        label={promptLabel ?? "System prompt"}
        value={params._systemPrompt ?? ""}
        onChange={(v) => setParam("_systemPrompt", v)}
        onReset={onResetPrompt}
      />
    </div>
  );
}

/**
 * Per-location background gallery (v0.7.0 D5). Rows come from the world's
 * visited locations; images may live anywhere on disk. Keys are lowercased
 * location names (matching the renderer's current_location lookup).
 */
function AtmosphereTab({ draft, setField }) {
  const ui = draft.ui ?? {};
  const gallery = ui.locationBackgrounds ?? {};
  const imagegen = draft.imagegen ?? {};
  const [locations, setLocations] = useState([]);
  const [generating, setGenerating] = useState("");
  const [genError, setGenError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const w = await window.api.getWorld();
        if (cancelled) return;
        const names = (w?.locations ?? [])
          .map((l) => String(l?.name ?? "").trim())
          .filter(Boolean);
        setLocations(names);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const setUi = (key, val) => setField("ui", { ...ui, [key]: val });
  const setLocationBg = (name, p) => {
    const next = { ...gallery };
    const key = name.toLowerCase();
    if (p) next[key] = p;
    else delete next[key];
    setUi("locationBackgrounds", next);
  };

  const imagegenConfigured = Boolean(String(imagegen.endpoint ?? "").trim());
  const generateFor = async (name) => {
    setGenerating(name);
    setGenError("");
    try {
      const r = await window.api.imagegenGenerateLocation(name);
      if (r?.ok && r.path) {
        setLocationBg(name, r.path);
      } else {
        setGenError(r?.error ?? "Generation failed.");
      }
    } catch (err) {
      setGenError(String(err?.message ?? err));
    } finally {
      setGenerating("");
    }
  };

  return (
    <div className="settings-tab-body">
      <FilePickerField
        label="Default background"
        value={ui.backgroundImage ?? ""}
        onChange={(p) => setUi("backgroundImage", p)}
        extensions={["png", "jpg", "jpeg"]}
      />
      <TextField
        label="Image generation endpoint (A1111/Forge, optional — blank = off)"
        value={imagegen.endpoint ?? ""}
        placeholder="http://127.0.0.1:7860"
        onChange={(v) => setField("imagegen", { ...imagegen, endpoint: v })}
      />
      {genError && (
        <div style={{ fontSize: "0.78rem", color: "var(--oxblood, #a33)", marginBottom: 6 }}>
          {genError}
        </div>
      )}
      <div className="settings-field">
        <label className="settings-field-label">Location backgrounds</label>
        {locations.length === 0 && (
          <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
            No locations in the world yet — they appear here as the story visits them.
          </span>
        )}
      </div>
      {locations.map((name) => (
        <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ width: 160, flexShrink: 0, fontSize: "0.82rem", color: "var(--bone)" }}>
            {name}
          </span>
          <span
            style={{
              flex: 1,
              fontSize: "0.75rem",
              color: gallery[name.toLowerCase()] ? "var(--bone)" : "var(--muted)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}
            title={gallery[name.toLowerCase()] ?? ""}
          >
            {gallery[name.toLowerCase()] ?? "(default)"}
          </span>
          <button
            type="button"
            className="btn ghost"
            style={{ padding: "2px 10px", fontSize: "0.72rem" }}
            onClick={async () => {
              const r = await window.api.settingsBrowseFile({
                title: `Background for ${name}`,
                extensions: ["png", "jpg", "jpeg"]
              });
              if (!r?.canceled && r?.path) setLocationBg(name, r.path);
            }}
          >
            Browse
          </button>
          {imagegenConfigured && (
            <button
              type="button"
              className="btn ghost"
              disabled={Boolean(generating)}
              title="Generate scene art from this location's facts"
              style={{ padding: "2px 10px", fontSize: "0.72rem" }}
              onClick={() => generateFor(name)}
            >
              {generating === name ? "…" : "Generate"}
            </button>
          )}
          {gallery[name.toLowerCase()] && (
            <button
              type="button"
              className="btn ghost"
              style={{ padding: "2px 10px", fontSize: "0.72rem" }}
              onClick={() => setLocationBg(name, "")}
            >
              Clear
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function LorebookTab({ draft, setField }) {
  const lb = draft.lorebook ?? {};
  const setLb = (key, val) => {
    setField("lorebook", { ...lb, [key]: val });
  };
  return (
    <div className="settings-tab-body">
      <SliderField label="Max entries injected" value={lb.maxEntries ?? 5} onChange={(v) => setLb("maxEntries", v)} min={1} max={20} step={1} />
      <NumberField label="Max inject chars" value={lb.maxInjectChars ?? 3500} onChange={(v) => setLb("maxInjectChars", v)} min={500} max={10000} />
      <NumberField label="Match message window (blank = all)" value={lb.maxMatchMessages} onChange={(v) => setLb("maxMatchMessages", v)} min={1} max={100} />
      <ToggleField label="Vector search enabled" value={lb.vectorEnabled !== false} onChange={(v) => setLb("vectorEnabled", v)} />
      <SliderField label="Vector similarity threshold" value={lb.vectorSimilarityThreshold ?? 0.35} onChange={(v) => setLb("vectorSimilarityThreshold", v)} min={0} max={1} step={0.05} />
    </div>
  );
}

function SttTab({ draft, setField }) {
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState(null);
  const backend = draft.sttBackend ?? "whisper-cpp";

  const handleValidate = useCallback(async () => {
    const bin = draft.sttCustomBin;
    if (!bin) { setValidation({ ok: false, error: "No binary selected" }); return; }
    setValidating(true);
    try {
      const result = await window.api.validateSttBinary(bin);
      setValidation(result);
    } catch (err) {
      setValidation({ ok: false, error: String(err) });
    }
    setValidating(false);
  }, [draft.sttCustomBin]);

  return (
    <div className="settings-tab-body">
      <div className="settings-field">
        <label className="settings-field-label">STT Backend</label>
        <select
          className="settings-select"
          value={backend}
          onChange={(e) => setField("sttBackend", e.target.value)}
        >
          <option value="whisper-cpp">Whisper.cpp (default)</option>
          <option value="custom">Custom binary</option>
        </select>
      </div>

      {backend === "custom" && (
        <>
          <FilePickerField
            label="Custom STT binary"
            value={draft.sttCustomBin}
            onChange={(path) => { setField("sttCustomBin", path); setValidation(null); }}
            extensions={["exe"]}
          />
          <TextField
            label="Argument template"
            value={draft.sttCustomArgs ?? ""}
            onChange={(v) => setField("sttCustomArgs", v)}
            placeholder="-f {input} -o {output}"
          />
          <div className="settings-field">
            <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 8 }}>
              Use {"{input}"} for the WAV path. Use {"{output}"} if your binary writes to a file; omit it if it prints to stdout.
            </div>
            <button
              type="button"
              className="settings-browse-btn"
              onClick={handleValidate}
              disabled={validating}
            >
              {validating ? "Validating…" : "Validate binary"}
            </button>
            {validation && (
              <div style={{
                marginTop: 6,
                fontSize: "0.8rem",
                color: validation.ok ? "#6a9f6a" : "#e55"
              }}>
                {validation.ok ? "Valid" : validation.error}
              </div>
            )}
          </div>
        </>
      )}

      {backend === "whisper-cpp" && (
        <>
          <FilePickerField
            label="Whisper binary"
            value={draft.whisperBin}
            onChange={(path) => setField("whisperBin", path)}
            extensions={["exe"]}
          />
          <FilePickerField
            label="Whisper model"
            value={draft.whisperModel}
            onChange={(path) => setField("whisperModel", path)}
            extensions={["bin"]}
          />
        </>
      )}
    </div>
  );
}

function InputTab({ draft, setField }) {
  const ptt = draft.pushToTalk ?? {};
  const setPtt = (key, val) => {
    setField("pushToTalk", { ...ptt, [key]: val });
  };
  return (
    <div className="settings-tab-body">
      <TextField
        label="PTT accelerator key"
        value={ptt.electronAccelerator ?? "`"}
        onChange={(v) => setPtt("electronAccelerator", v)}
      />
      <ToggleField
        label="Auto-send voice transcription (skip editing)"
        value={ptt.autoSend === true}
        onChange={(v) => setPtt("autoSend", v)}
      />
      <SliderField label="Space release delay (ms)" value={ptt.spaceReleaseMs ?? 750} onChange={(v) => setPtt("spaceReleaseMs", v)} min={300} max={1500} step={50} />
      <SliderField label="Restart debounce (ms)" value={ptt.restartDebounceMs ?? 400} onChange={(v) => setPtt("restartDebounceMs", v)} min={100} max={800} step={50} />
      <SliderField label="Min record duration (ms)" value={ptt.minRecordMs ?? 350} onChange={(v) => setPtt("minRecordMs", v)} min={100} max={1000} step={50} />
    </div>
  );
}

function AgentTab({ draft, setField }) {
  const agent = draft.agent ?? {};
  const setAgent = (key, val) => {
    setField("agent", { ...agent, [key]: val });
  };
  return (
    <div className="settings-tab-body">
      <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 10 }}>
        Scaffolding only — agent behavior arrives in a later version. These
        settings configure where a player agent would run; nothing acts on
        them yet.
      </div>
      <ToggleField
        label="Enable player agent"
        value={agent.enabled === true}
        onChange={(v) => setAgent("enabled", v)}
      />
      {agent.enabled === true && (
        <>
          <div className="settings-field">
            <label className="settings-field-label">Agent backend</label>
            <select
              className="settings-select"
              value={agent.backend ?? "none"}
              onChange={(e) => setAgent("backend", e.target.value)}
            >
              <option value="none">None (not configured)</option>
              <option value="kobold">KoboldCPP endpoint</option>
              <option value="custom">Custom binary</option>
            </select>
          </div>
          {agent.backend === "kobold" && (
            <TextField
              label="Endpoint URL"
              value={agent.endpoint ?? ""}
              onChange={(v) => setAgent("endpoint", v)}
              placeholder="http://127.0.0.1:5001/api/v1/generate"
            />
          )}
          {agent.backend === "custom" && (
            <>
              <FilePickerField
                label="Agent binary"
                value={agent.bin}
                onChange={(path) => setAgent("bin", path)}
                extensions={["exe"]}
              />
              <TextField
                label="Arguments"
                value={agent.args ?? ""}
                onChange={(v) => setAgent("args", v)}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

const WORLD_SECTIONS = [
  { id: "character", label: "Character", count: (w) => Object.keys(w.character ?? {}).length, unit: "fields" },
  { id: "npcs", label: "NPCs", count: (w) => (w.npcs ?? []).length, unit: "entries" },
  { id: "quests", label: "Quests", count: (w) => (w.quests ?? []).length, unit: "entries" },
  { id: "locations", label: "Locations", count: (w) => (w.locations ?? []).length, unit: "entries" },
  {
    id: "lorebook",
    label: "Lorebook",
    count: (w) => (w.lorebook ?? []).length,
    unit: "entries"
  },
  { id: "session_beats", label: "Session beats", count: (w) => (w.session_beats ?? []).length, unit: "beats" }
];

function WorldDataTab() {
  const [world, setWorld] = useState(null);
  const [confirming, setConfirming] = useState(null);
  const [clearing, setClearing] = useState(false);

  const loadWorld = useCallback(async () => {
    try {
      const w = await window.api.getWorld();
      setWorld(w ?? {});
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadWorld(); }, [loadWorld]);

  const handleClear = useCallback(async (sectionId) => {
    setClearing(true);
    try {
      await window.api.worldResetSections([sectionId]);
      await loadWorld();
    } catch { /* ignore */ }
    setConfirming(null);
    setClearing(false);
  }, [loadWorld]);

  if (!world) return <div className="settings-tab-body" />;

  return (
    <div className="settings-tab-body">
      <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginBottom: 10 }}>
        Clearing takes effect immediately (no Save needed). A backup of the
        current world state is written first. Clearing any section also clears
        the lore correction undo history.
      </div>
      {WORLD_SECTIONS.map((s) => {
        const n = s.count(world);
        const isConfirming = confirming === s.id;
        return (
          <div key={s.id} className="settings-field" style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <label className="settings-field-label" style={{ flex: 1, marginBottom: 0 }}>
              {s.label}
              <span style={{ color: "var(--muted)", marginLeft: 8, fontSize: "0.78rem" }}>
                {n} {s.unit}
              </span>
            </label>
            {isConfirming ? (
              <>
                <span style={{ fontSize: "0.8rem", color: "#e55" }}>
                  Clear {n} {s.unit}?
                </span>
                <button
                  type="button"
                  className="settings-danger-btn"
                  disabled={clearing}
                  onClick={() => handleClear(s.id)}
                >
                  {clearing ? "Clearing…" : "Confirm"}
                </button>
                <button
                  type="button"
                  className="settings-cancel-btn"
                  disabled={clearing}
                  onClick={() => setConfirming(null)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                className="settings-browse-btn"
                disabled={n === 0}
                onClick={() => setConfirming(s.id)}
              >
                Clear
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PathsTab({ draft, setField }) {
  const [mics, setMics] = useState([]);
  const [micLoading, setMicLoading] = useState(false);

  const refreshMics = useCallback(async () => {
    setMicLoading(true);
    try {
      const r = await window.api.settingsGetMicList();
      setMics(Array.isArray(r?.devices) ? r.devices : []);
    } catch { /* ignore */ }
    setMicLoading(false);
  }, []);

  useEffect(() => { refreshMics(); }, [refreshMics]);

  return (
    <div className="settings-tab-body">
      <FilePickerField
        label="Whisper binary"
        value={draft.whisperBin}
        restart
        onChange={(path) => setField("whisperBin", path)}
        extensions={["exe"]}
      />
      <FilePickerField
        label="Whisper model"
        value={draft.whisperModel}
        restart
        onChange={(path) => setField("whisperModel", path)}
        extensions={["bin"]}
      />
      <div className="settings-field">
        <button
          type="button"
          className="settings-link-btn"
          onClick={() => setField("_rerunWizard", true)}
          style={{ alignSelf: "flex-start" }}
        >
          Re-download or change Whisper model (via wizard)
        </button>
      </div>
      <FilePickerField
        label="FFmpeg binary"
        value={draft.ffmpegBin}
        restart
        onChange={(path) => setField("ffmpegBin", path)}
        extensions={["exe"]}
      />
      <FilePickerField
        label="KoboldCPP binary"
        value={draft.koboldBin}
        restart
        onChange={(path) => setField("koboldBin", path)}
        extensions={["exe"]}
      />
      <div className="settings-field">
        <div className="settings-field-label-row">
          <label className="settings-field-label">Mic device</label>
          <button type="button" className="settings-link-btn" onClick={refreshMics} disabled={micLoading}>
            {micLoading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <select
          className="settings-select"
          value={draft.ffmpegDshowAudioDevice ?? ""}
          onChange={(e) => setField("ffmpegDshowAudioDevice", e.target.value)}
        >
          <option value="">—</option>
          {mics.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      </div>
      <div className="settings-divider" />
      <FilePickerField
        label="Background image"
        value={draft.ui?.backgroundImage}
        onChange={(path) => setField("ui.backgroundImage", path)}
        extensions={["jpg", "jpeg", "png", "webp"]}
      />
      <div className="settings-field">
        <label className="settings-field-label">Border mode</label>
        <select
          className="settings-select"
          value={draft.ui?.borderMode ?? "svg"}
          onChange={(e) => setField("ui.borderMode", e.target.value)}
        >
          <option value="svg">SVG</option>
          <option value="image">Image</option>
          <option value="none">None</option>
        </select>
      </div>
      {draft.ui?.borderMode === "image" && (
        <FilePickerField
          label="Border image"
          value={draft.ui?.borderImage}
          onChange={(path) => setField("ui.borderImage", path)}
          extensions={["png"]}
        />
      )}
      <div className="settings-divider" />
      <button
        type="button"
        className="settings-danger-btn"
        onClick={() => setField("_rerunWizard", true)}
      >
        Re-run setup wizard
      </button>
    </div>
  );
}

// Fields that genuinely require an app restart (KoboldCPP launch params, PTT
// shortcut registration). Everything else hot-applies via pipeline.updateConfig.
const RESTART_FIELDS = ["koboldModel", "koboldContextSize", "koboldPort", "koboldHost", "koboldBin"];

function restartFieldsChanged(a, b) {
  if (!a || !b) return false;
  for (const k of RESTART_FIELDS) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return true;
  }
  return (
    (a.pushToTalk?.electronAccelerator ?? "`") !==
    (b.pushToTalk?.electronAccelerator ?? "`")
  );
}

export default function Settings({ onClose }) {
  const [tab, setTab] = useState("kobold");
  const [draft, setDraft] = useState(null);
  const [original, setOriginal] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await window.api.settingsGet();
        if (cancelled) return;
        setDraft(cfg ?? {});
        setOriginal(cfg ?? {});
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const setField = useCallback((key, value) => {
    setDraft((prev) => {
      if (!prev) return prev;
      if (key.startsWith("ui.")) {
        const uiKey = key.slice(3);
        return { ...prev, ui: { ...(prev.ui ?? {}), [uiKey]: value } };
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const handleResetPrompt = useCallback(async (type) => {
    try {
      const r = await window.api.settingsResetPrompt(type);
      if (r?.text != null) {
        setDraft((prev) => ({
          ...prev,
          [type]: { ...(prev?.[type] ?? {}), _systemPrompt: r.text }
        }));
      }
    } catch { /* ignore */ }
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      if (draft._rerunWizard) {
        const saveCfg = { ...draft, wizardComplete: false };
        delete saveCfg._rerunWizard;
        await window.api.settingsSave(saveCfg);
        await window.api.settingsRelaunch();
        return;
      }
      const saveCfg = { ...draft };
      delete saveCfg._rerunWizard;
      await window.api.settingsSave(saveCfg);
      setSaved(true);
      if (restartFieldsChanged(draft, original)) setNeedsRestart(true);
      setOriginal(saveCfg);
      setTimeout(() => setSaved(false), 2500);
    } catch { /* ignore */ }
    setSaving(false);
  }, [draft, original]);

  const handleRelaunch = useCallback(async () => {
    try {
      await window.api.settingsRelaunch();
    } catch { /* ignore */ }
  }, []);

  if (!draft) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Settings</h2>
          <button type="button" className="settings-close" onClick={onClose}>✕</button>
        </div>

        <nav className="settings-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`settings-tab-btn ${tab === t.id ? "active" : ""}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="settings-body">
          {tab === "kobold" && <BackendTab draft={draft} setField={setField} />}
          {tab === "stt" && <SttTab draft={draft} setField={setField} />}
          {tab === "narrative" && (
            <GenParamsTab
              draft={draft}
              setField={setField}
              prefix="narrative"
              promptLabel="Narrative system prompt"
              onResetPrompt={() => handleResetPrompt("narrative")}
              lengthControl
            />
          )}
          {tab === "extractor" && (
            <GenParamsTab
              draft={draft}
              setField={setField}
              prefix="extractor"
              promptLabel="Extractor system prompt"
              onResetPrompt={() => handleResetPrompt("extractor")}
            />
          )}
          {tab === "loreCorrection" && (
            <GenParamsTab
              draft={draft}
              setField={setField}
              prefix="loreCorrection"
              promptLabel="Lore correction system prompt (blank = use bundled correction prompt)"
              onResetPrompt={() => handleResetPrompt("loreCorrection")}
            />
          )}
          {tab === "lorebook" && <LorebookTab draft={draft} setField={setField} />}
          {tab === "input" && <InputTab draft={draft} setField={setField} />}
          {tab === "atmosphere" && <AtmosphereTab draft={draft} setField={setField} />}
          {tab === "agent" && <AgentTab draft={draft} setField={setField} />}
          {tab === "worldData" && <WorldDataTab />}
          {tab === "debug" && <ContextDebugPanel />}
          {tab === "paths" && <PathsTab draft={draft} setField={setField} />}
        </div>

        <div className="settings-footer">
          {needsRestart && (
            <div className="settings-restart-banner">
              Some changes may require restarting tmíxʷ.
              <button type="button" className="settings-link-btn" onClick={handleRelaunch}>
                Restart now
              </button>
            </div>
          )}
          <div className="settings-footer-actions">
            <button type="button" className="settings-cancel-btn" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="settings-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saved ? "Saved ✓" : saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
