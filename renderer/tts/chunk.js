// Sentence chunking for TTS (design doc 05 §5). Splitting narration into
// sentence-ish pieces lets playback start fast and stop cleanly mid-paragraph
// (snappier barge-in). Pure + dependency-free so it's unit-testable on its own.

/**
 * Split prose into sentence-ish chunks. Keeps terminal punctuation (and any
 * trailing quotes/brackets), collapses whitespace, never returns empty pieces.
 * Text with no sentence terminator returns a single chunk.
 * @param {string} text
 * @returns {string[]}
 */
export function chunkSentences(text) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const matches = flat.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g);
  return (matches ?? [flat]).map((s) => s.trim()).filter(Boolean);
}
