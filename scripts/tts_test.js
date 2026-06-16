// Model-free tests for the TTS sentence chunker (design doc 05). The speaker
// (Web Speech) and the useTts controller need a DOM/speechSynthesis, so they're
// build-checked + manually verified; chunkSentences is pure and covered here.
//
// Usage: npm run tts:test
import assert from "node:assert/strict";
import { chunkSentences } from "../renderer/tts/chunk.js";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

check("chunk: splits on sentence terminators, keeps punctuation", () => {
  assert.deepEqual(chunkSentences("The door opens. A draft chills you. Run!"), [
    "The door opens.",
    "A draft chills you.",
    "Run!"
  ]);
});

check("chunk: keeps trailing quotes/brackets with the sentence", () => {
  assert.deepEqual(chunkSentences('"Stop there!" she said. He froze.'), [
    '"Stop there!"',
    "she said.",
    "He froze."
  ]);
});

check("chunk: a terminator-less line is one chunk", () => {
  assert.deepEqual(chunkSentences("no terminator here"), ["no terminator here"]);
});

check("chunk: collapses whitespace / newlines", () => {
  assert.deepEqual(chunkSentences("One.\n\n  Two.\tThree."), ["One.", "Two.", "Three."]);
});

check("chunk: trailing fragment after a sentence is kept", () => {
  assert.deepEqual(chunkSentences("Done. and more"), ["Done.", "and more"]);
});

check("chunk: blank / whitespace / nullish → empty list", () => {
  assert.deepEqual(chunkSentences("   "), []);
  assert.deepEqual(chunkSentences(""), []);
  assert.deepEqual(chunkSentences(null), []);
  assert.deepEqual(chunkSentences(undefined), []);
});

check("chunk: multiple terminators collapse into one chunk", () => {
  assert.deepEqual(chunkSentences("Really?! Yes..."), ["Really?!", "Yes..."]);
});

if (failures > 0) {
  console.error(`\ntts:test ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntts:test ALL PASS");
