// Web Speech speaker (design doc 05 §4) — the renderer-native TTS backend.
// Wraps window.speechSynthesis behind the small speaker interface useTts drives
// (supported / listVoices / onVoicesChanged / speak / stop), so the piper
// backend can slot in later without touching the controller. Zero deps.

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
};

export function createWebSpeechSpeaker() {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
  const supported = !!(synth && typeof window.SpeechSynthesisUtterance === "function");

  return {
    id: "web-speech",
    supported,

    listVoices() {
      return synth ? synth.getVoices() : [];
    },

    /** getVoices() populates async on some platforms — let callers re-read. */
    onVoicesChanged(cb) {
      if (!synth) return () => {};
      synth.addEventListener("voiceschanged", cb);
      return () => synth.removeEventListener("voiceschanged", cb);
    },

    /** Speak one chunk; `onEnd` fires on natural end or error (never throws). */
    speak(text, opts = {}, onEnd) {
      if (!supported) {
        onEnd?.();
        return;
      }
      const u = new window.SpeechSynthesisUtterance(String(text ?? ""));
      if (opts.voice) {
        const v = synth
          .getVoices()
          .find((vv) => vv.voiceURI === opts.voice || vv.name === opts.voice);
        if (v) u.voice = v;
      }
      u.rate = clamp(opts.rate, 0.5, 2, 1);
      u.volume = clamp(opts.volume, 0, 1, 0.9);
      if (onEnd) {
        u.onend = onEnd;
        u.onerror = onEnd;
      }
      synth.speak(u);
    },

    stop() {
      if (synth) synth.cancel();
    }
  };
}
