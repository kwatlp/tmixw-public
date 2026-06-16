import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createWebSpeechSpeaker } from "./speakers/webSpeech.js";
import { chunkSentences } from "./chunk.js";

/**
 * TTS controller (design doc 05 §4–§5): owns *when and what* to speak; a
 * pluggable speaker backend owns *how*. v1 wires the renderer-native Web Speech
 * speaker; the piper backend (main-process, doc 05 Phase 3) slots in behind the
 * same interface later.
 *
 * Behavior: auto-speak the FINAL narrator text (not streaming tokens) when
 * enabled + autoSpeak; re-speak on regenerate/continue/rewrite; and — the
 * critical pillar — **barge-in**: stop instantly when the player starts PTT or
 * sends a message, so the narrator never talks over them. Text is sentence-
 * chunked and queued so playback starts fast and stops cleanly mid-paragraph.
 *
 * @param {{ enabled?: boolean, backend?: string, autoSpeak?: boolean,
 *           voice?: string, rate?: number, volume?: number }} tts
 */
export function useTts(tts) {
  const enabled = tts?.enabled === true;
  const autoSpeak = tts?.autoSpeak !== false;

  // Only the Web Speech backend exists in v1; piper would branch here.
  const speaker = useMemo(() => createWebSpeechSpeaker(), []);
  const [speaking, setSpeaking] = useState(false);
  const [voices, setVoices] = useState(() => speaker.listVoices());

  // Latest options without re-subscribing the event wiring every render.
  const optsRef = useRef(tts);
  optsRef.current = tts;

  // The text most recently auto-spoken — lets Continue (which appends to the
  // prior reply) speak only the new tail instead of re-reading what was said.
  const lastTextRef = useRef("");

  useEffect(() => {
    setVoices(speaker.listVoices());
    return speaker.onVoicesChanged?.(() => setVoices(speaker.listVoices()));
  }, [speaker]);

  const stop = useCallback(() => {
    speaker.stop();
    setSpeaking(false);
  }, [speaker]);

  const speak = useCallback(
    (text) => {
      if (!speaker.supported) return;
      const chunks = chunkSentences(text);
      if (chunks.length === 0) return;
      speaker.stop();
      setSpeaking(true);
      const o = optsRef.current ?? {};
      const voiceOpts = { voice: o.voice, rate: o.rate, volume: o.volume };
      chunks.forEach((c, i) =>
        speaker.speak(c, voiceOpts, i === chunks.length - 1 ? () => setSpeaking(false) : undefined)
      );
    },
    [speaker]
  );

  // Auto-speak + barge-in wiring. Re-subscribes only when the on/off-ish flags
  // change; option tweaks (voice/rate/volume) ride optsRef and apply next speak.
  useEffect(() => {
    if (!enabled) {
      stop();
      return undefined;
    }
    const offNarr = window.api.onNarrative?.((p) => {
      if (!autoSpeak || !p?.text) return;
      lastTextRef.current = p.text;
      speak(p.text);
    });
    const offUpd = window.api.onNarrativeUpdated?.((p) => {
      // Regenerate / rewrite replace the text → re-speak it. Continue APPENDS to
      // the prior reply, so speak only the new tail (the combined text starts
      // with what we already read) rather than repeating the spoken prose.
      if (!autoSpeak || !p?.text) return;
      const prev = lastTextRef.current ?? "";
      const next = p.text;
      const toSpeak = prev && next.startsWith(prev) ? next.slice(prev.length).trim() : next;
      lastTextRef.current = next;
      if (toSpeak) speak(toSpeak);
    });
    // Barge-in (doc 05 §5): the player acting stops speech immediately.
    const offRec = window.api.onRecording?.((p) => {
      if (p?.phase === "start") stop();
    });
    const offTx = window.api.onTranscript?.((p) => {
      if (!p?.beforeKobold && p?.text) stop();
    });
    return () => {
      offNarr?.();
      offUpd?.();
      offRec?.();
      offTx?.();
      stop();
    };
  }, [enabled, autoSpeak, speak, stop]);

  return { speak, stop, speaking, supported: speaker.supported, voices };
}
