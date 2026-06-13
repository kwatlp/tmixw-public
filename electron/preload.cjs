const { contextBridge, ipcRenderer } = require("electron");

// IPC listeners must never throw or leave a rejected promise floating — Electron
// surfaces that as an uncaught IpcRenderer "Unhandled error" (common when async
// `load` handlers are passed to `onWorldUpdated` without `.catch()`).
/** @param {string} label @param {Function} fn */
function safeListener(label, fn) {
  return (...args) => {
    try {
      const ret = fn(...args);
      if (ret != null && typeof ret.then === "function") {
        ret.catch((err) => {
          console.error(`[preload:${label}]`, err);
        });
      }
    } catch (err) {
      console.error(`[preload:${label}]`, err);
    }
  };
}

contextBridge.exposeInMainWorld("api", {
  getBootstrap: () => ipcRenderer.invoke("app:getBootstrap"),
  wizardListMics: () => ipcRenderer.invoke("wizard:listMics"),
  wizardTestMic: (deviceName) =>
    ipcRenderer.invoke("wizard:testMic", deviceName),
  wizardPickModel: () => ipcRenderer.invoke("wizard:pickModel"),
  wizardDownloadWhisper: (modelId) =>
    ipcRenderer.invoke("wizard:downloadWhisper", modelId),
  wizardCancelDownload: () =>
    ipcRenderer.invoke("wizard:cancelDownload"),
  onWizardDownloadProgress: (cb) => {
    const fn = safeListener("wizard:downloadProgress", (_e, p) => cb(p));
    ipcRenderer.on("wizard:downloadProgress", fn);
    return () => ipcRenderer.removeListener("wizard:downloadProgress", fn);
  },
  wizardCheckFfmpeg: () => ipcRenderer.invoke("wizard:checkFfmpeg"),
  wizardDownloadFfmpeg: () => ipcRenderer.invoke("wizard:downloadFfmpeg"),
  wizardCheckWhisperCli: () => ipcRenderer.invoke("wizard:checkWhisperCli"),
  wizardBrowseWhisperCli: () => ipcRenderer.invoke("wizard:browseWhisperCli"),
  wizardCheckKobold: () => ipcRenderer.invoke("wizard:checkKobold"),
  wizardBrowseKobold: () => ipcRenderer.invoke("wizard:browseKobold"),
  wizardComplete: (payload) => ipcRenderer.invoke("wizard:complete", payload),
  wizardRestart: () => ipcRenderer.invoke("wizard:restart"),
  onWizardDone: (cb) => {
    const fn = safeListener("wizard:done", () => cb());
    ipcRenderer.on("wizard:done", fn);
    return () => ipcRenderer.removeListener("wizard:done", fn);
  },
  settingsGet: () => ipcRenderer.invoke("settings:get"),
  settingsSave: (cfg) => ipcRenderer.invoke("settings:save", cfg),
  settingsGetMicList: () => ipcRenderer.invoke("settings:getMicList"),
  settingsTestMic: (deviceName) =>
    ipcRenderer.invoke("settings:testMic", deviceName),
  settingsResetPrompt: (type) =>
    ipcRenderer.invoke("settings:resetPrompt", type),
  settingsBrowseFile: (opts) => ipcRenderer.invoke("settings:browseFile", opts),
  settingsRelaunch: () => ipcRenderer.invoke("settings:relaunch"),
  validateInference: (draftInference) =>
    ipcRenderer.invoke("settings:validateInference", draftInference),
  setLengthPreset: (preset) =>
    ipcRenderer.invoke("narrative:setLengthPreset", preset),
  setNarrativeStyle: (patch) =>
    ipcRenderer.invoke("narrative:setStyle", patch),

  koboldStatus: () => ipcRenderer.invoke("kobold:status"),
  onKoboldReady: (cb) => {
    const fn = safeListener("kobold:ready", (_e, p) => cb(p));
    ipcRenderer.on("kobold:ready", fn);
    return () => ipcRenderer.removeListener("kobold:ready", fn);
  },
  onKoboldError: (cb) => {
    const fn = safeListener("kobold:error", (_e, p) => cb(p));
    ipcRenderer.on("kobold:error", fn);
    return () => ipcRenderer.removeListener("kobold:error", fn);
  },

  // Worlds picker (v0.9.0 M2)
  worldsList: () => ipcRenderer.invoke("worlds:list"),
  worldsTemplates: () => ipcRenderer.invoke("worlds:templates"),
  worldsCreate: (payload) => ipcRenderer.invoke("worlds:create", payload),
  worldsSwitch: (id) => ipcRenderer.invoke("worlds:switch", id),
  worldsRename: (id, name) => ipcRenderer.invoke("worlds:rename", id, name),
  worldsDelete: (id) => ipcRenderer.invoke("worlds:delete", id),
  onWorldsChanged: (cb) => {
    const fn = safeListener("worlds:changed", (_e, p) => cb(p));
    ipcRenderer.on("worlds:changed", fn);
    return () => ipcRenderer.removeListener("worlds:changed", fn);
  },

  start: () => ipcRenderer.invoke("pipeline:start"),
  stop: () => ipcRenderer.invoke("pipeline:stop"),
  submitText: (text) => ipcRenderer.invoke("pipeline:submitText", text),
  getWorld: () => ipcRenderer.invoke("world:get"),
  setCharField: (k, v) => ipcRenderer.invoke("world:setCharField", k, v),
  worldResetSections: (sections) =>
    ipcRenderer.invoke("world:resetSections", sections),
  validateSttBinary: (binPath) => ipcRenderer.invoke("settings:validateSttBinary", binPath),
  listLore: () => ipcRenderer.invoke("lore:list"),
  testLore: (text) => ipcRenderer.invoke("lore:test", text),
  loreApplyCorrection: (text) => ipcRenderer.invoke("lore:applyCorrection", text),
  loreUndoLast: () => ipcRenderer.invoke("lore:undoLast"),
  loreGetHistory: () => ipcRenderer.invoke("lore:getHistory"),
  memoryEndScene: (title) => ipcRenderer.invoke("memory:endScene", title),
  memoryStartChapter: (title) => ipcRenderer.invoke("memory:startChapter", title),
  memoryEdit: (kind, id, payload) => ipcRenderer.invoke("memory:edit", kind, id, payload),
  memoryDelete: (kind, id) => ipcRenderer.invoke("memory:delete", kind, id),
  memoryPin: (kind, id, pinned) => ipcRenderer.invoke("memory:pin", kind, id, pinned),
  memoryRegenerate: (target) => ipcRenderer.invoke("memory:regenerate", target),
  contextLastReport: () => ipcRenderer.invoke("context:lastReport"),

  // Codex record-card writes (v0.8.4)
  codexEditField: (entryId, fieldKey, value) =>
    ipcRenderer.invoke("codex:editField", entryId, fieldKey, value),
  codexAddField: (entryId, label) =>
    ipcRenderer.invoke("codex:addField", entryId, label),
  codexKeepEntry: (entryId) => ipcRenderer.invoke("codex:keepEntry", entryId),
  codexMoveEntry: (entryId, toGroupId, index) =>
    ipcRenderer.invoke("codex:moveEntry", entryId, toGroupId, index),
  codexGroupCreate: (tab, name) =>
    ipcRenderer.invoke("codex:groupCreate", tab, name),
  codexGroupRename: (groupId, name) =>
    ipcRenderer.invoke("codex:groupRename", groupId, name),
  codexGroupDelete: (groupId) =>
    ipcRenderer.invoke("codex:groupDelete", groupId),
  onMemoryScene: (cb) => {
    const fn = safeListener("memory:scene", (_e, p) => cb(p));
    ipcRenderer.on("memory:scene", fn);
    return () => ipcRenderer.removeListener("memory:scene", fn);
  },
  getAssetPath: (relPath) => ipcRenderer.invoke("ui:getAssetPath", relPath),
  getUiConfig: () => ipcRenderer.invoke("ui:getConfig"),
  getBackgroundUrl: (p) => ipcRenderer.invoke("ui:getBackgroundUrl", p),
  imagegenStatus: () => ipcRenderer.invoke("imagegen:status"),
  imagegenGenerateLocation: (name) =>
    ipcRenderer.invoke("imagegen:generateLocation", name),
  rendererReady: () => ipcRenderer.invoke("renderer:ready"),
  // Voice HUD (v0.8.4)
  voiceGetConfig: () => ipcRenderer.invoke("voice:getConfig"),
  voiceSetConfig: (patch) => ipcRenderer.invoke("voice:setConfig", patch),
  pttSetKey: (code) => ipcRenderer.invoke("ptt:setKey", code),
  pttStart: () => {
    console.log("[preload] pttStart → invoke(\"ptt:start\")");
    return ipcRenderer.invoke("ptt:start");
  },
  pttEnd: () => {
    console.log("[preload] pttEnd → invoke(\"ptt:end\")");
    return ipcRenderer.invoke("ptt:end");
  },

  onTranscript: (cb) => {
    const fn = safeListener("transcript", (_e, p) => {
      if (!p?.beforeKobold) cb(p);
    });
    ipcRenderer.on("transcript", fn);
    return () => ipcRenderer.removeListener("transcript", fn);
  },
  onTranscriptDraft: (cb) => {
    const fn = safeListener("transcript:draft", (_e, p) => cb(p));
    ipcRenderer.on("transcript:draft", fn);
    return () => ipcRenderer.removeListener("transcript:draft", fn);
  },
  onBeforeKobold: (cb) => {
    const fn = safeListener("transcript:beforeKobold", (_e, p) => {
      if (p?.beforeKobold) cb(p);
    });
    ipcRenderer.on("transcript", fn);
    return () => ipcRenderer.removeListener("transcript", fn);
  },
  onNarrative: (cb) => {
    const fn = safeListener("narrative", (_e, p) => cb(p));
    ipcRenderer.on("narrative", fn);
    return () => ipcRenderer.removeListener("narrative", fn);
  },

  // Per-response controls (v0.6.0 M2)
  narrativeAccept: () => ipcRenderer.invoke("narrative:accept"),
  narrativeRegenerate: () => ipcRenderer.invoke("narrative:regenerate"),
  narrativeContinue: () => ipcRenderer.invoke("narrative:continue"),
  narrativeRewrite: (instruction) =>
    ipcRenderer.invoke("narrative:rewrite", instruction),
  narrativeGetPending: () => ipcRenderer.invoke("narrative:getPending"),
  narrativeStopGeneration: () => ipcRenderer.invoke("narrative:stopGeneration"),
  onNarrativeToken: (cb) => {
    const fn = safeListener("narrative:token", (_e, p) => cb(p));
    ipcRenderer.on("narrative:token", fn);
    return () => ipcRenderer.removeListener("narrative:token", fn);
  },
  onNarrativePending: (cb) => {
    const fn = safeListener("narrative:pending", (_e, p) => cb(p));
    ipcRenderer.on("narrative:pending", fn);
    return () => ipcRenderer.removeListener("narrative:pending", fn);
  },
  onNarrativeAccepted: (cb) => {
    const fn = safeListener("narrative:accepted", (_e, p) => cb(p));
    ipcRenderer.on("narrative:accepted", fn);
    return () => ipcRenderer.removeListener("narrative:accepted", fn);
  },
  onNarrativeUpdated: (cb) => {
    const fn = safeListener("narrative:updated", (_e, p) => cb(p));
    ipcRenderer.on("narrative:updated", fn);
    return () => ipcRenderer.removeListener("narrative:updated", fn);
  },
  onExtractorOk: (cb) => {
    const fn = safeListener("extractor:ok", (_e, p) => cb(p));
    ipcRenderer.on("extractor:ok", fn);
    return () => ipcRenderer.removeListener("extractor:ok", fn);
  },
  onExtractorSkip: (cb) => {
    const fn = safeListener("extractor:skip", (_e, p) => cb(p));
    ipcRenderer.on("extractor:skip", fn);
    return () => ipcRenderer.removeListener("extractor:skip", fn);
  },
  onWorldUpdated: (cb) => {
    const fn = safeListener("world:updated", (_e, p) => cb(p));
    ipcRenderer.on("world:updated", fn);
    return () => ipcRenderer.removeListener("world:updated", fn);
  },
  onRecording: (cb) => {
    const start = safeListener("recording:start", (_e, p) =>
      cb({ phase: "start", ...p })
    );
    const stop = safeListener("recording:stop", (_e, p) =>
      cb({ phase: "stop", ...p })
    );
    ipcRenderer.on("recording:start", start);
    ipcRenderer.on("recording:stop", stop);
    return () => {
      ipcRenderer.removeListener("recording:start", start);
      ipcRenderer.removeListener("recording:stop", stop);
    };
  },
  onError: (cb) => {
    const fn = safeListener("error", (_e, p) => cb(p));
    ipcRenderer.on("error", fn);
    return () => ipcRenderer.removeListener("error", fn);
  },
  onReady: (cb) => {
    const fn = safeListener("ready", (_e, p) => cb(p));
    ipcRenderer.on("ready", fn);
    return () => ipcRenderer.removeListener("ready", fn);
  },
  onStop: (cb) => {
    const fn = safeListener("stop", (_e, p) => cb(p));
    ipcRenderer.on("stop", fn);
    return () => ipcRenderer.removeListener("stop", fn);
  }
});
