import React, { useEffect, useRef, useState } from "react";

/**
 * Optional looping background-music layer (design doc 04). A single hidden
 * <audio> element driven by the shared `ui` config — no Web Audio, no pipeline
 * or world-state involvement. Off by default (the zero-interruption pillar):
 * it only plays when `ui.music.enabled` and a track resolves.
 *
 * Track resolution mirrors the background-image layer: a bundled relative path
 * streams via app:///file://; a user-picked absolute file falls back to a data
 * URL (see main.js `ui:getAudioUrl`). Volume/loop apply live; a changed track
 * reloads `src`. Chromium blocks autoplay without a gesture — toggling on in
 * Settings is itself a gesture, and on launch-with-enabled we retry on the
 * first click/key. Failures are always silent (never block play).
 */
const clamp01 = (n) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));

export default function BackgroundMusic({ ui }) {
  const audioRef = useRef(null);
  const [src, setSrc] = useState("");

  const music = ui?.music ?? {};
  const enabled = music.enabled === true;
  const loop = music.loop !== false; // default on
  const volume = clamp01(music.volume ?? 0.4);
  const track = ui?.backgroundMusic ?? "";

  // Resolve the configured track to a loadable URL whenever it changes.
  useEffect(() => {
    let cancelled = false;
    if (!track) {
      setSrc("");
      return undefined;
    }
    (async () => {
      try {
        const r = await window.api.getAudioUrl(track);
        if (!cancelled) setSrc(r?.missing ? "" : (r?.url ?? ""));
      } catch {
        if (!cancelled) setSrc("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [track]);

  // Volume applies live (a property, not an attribute).
  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume, src]);

  // Play / pause on enabled + a resolved src; retry once on a user gesture if
  // Chromium's autoplay policy rejects the initial play().
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return undefined;
    if (!enabled || !src) {
      a.pause();
      return undefined;
    }
    let cancelled = false;
    const onGesture = () => {
      a.play().catch(() => {});
    };
    a.play().catch(() => {
      if (cancelled) return;
      window.addEventListener("pointerdown", onGesture, { once: true });
      window.addEventListener("keydown", onGesture, { once: true });
    });
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [enabled, src]);

  return <audio ref={audioRef} src={src || undefined} loop={loop} preload="auto" hidden />;
}
