// Model-free tests for the optional image generation adapter (v0.7.0 M4,
// plan D6). The A1111 endpoint is stubbed — live verification of an actual
// server is pending one existing on the dev machine.
//
// Usage: npm run imagegen:test
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LOCAL_AI_WRITABLE_CORE = fs.mkdtempSync(
  path.join(os.tmpdir(), "tmixw-imagegen-")
);

const {
  buildImagegenRuntimeConfig,
  imagegenEnabled,
  buildLocationPrompt,
  buildTxt2ImgPayload,
  txt2img,
  imageSlug,
  saveGeneratedImage
} = await import("../core/imagegen.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(`  ${e.message}`);
  }
}

await check("config: absent block = disabled; endpoint trims trailing slashes", () => {
  assert.equal(imagegenEnabled(buildImagegenRuntimeConfig({})), false);
  const cfg = buildImagegenRuntimeConfig({ imagegen: { endpoint: "http://127.0.0.1:7860//" } });
  assert.equal(cfg.endpoint, "http://127.0.0.1:7860");
  assert.equal(imagegenEnabled(cfg), true);
  assert.equal(cfg.steps, 28);
});

await check("prompt: location facts + style family; empty description omitted", () => {
  const p = buildLocationPrompt("Sunken Chapel", "a flooded chapel beneath Harborton");
  assert.ok(p.startsWith("Environment concept art of Sunken Chapel"));
  assert.ok(p.includes("a flooded chapel beneath Harborton"));
  assert.ok(p.includes("fantasy illustration"));
  const bare = buildLocationPrompt("Docks", "");
  assert.ok(!bare.includes(", ,"), "no empty segment");
});

await check("payload: A1111 txt2img shape", () => {
  const cfg = buildImagegenRuntimeConfig({ imagegen: { endpoint: "http://x", width: 1024, height: 576 } });
  const body = buildTxt2ImgPayload("a prompt", cfg);
  assert.equal(body.prompt, "a prompt");
  assert.equal(body.width, 1024);
  assert.equal(body.height, 576);
  assert.ok(body.negative_prompt.length > 0);
  assert.equal(body.steps, 28);
});

await check("txt2img: happy path decodes first image", async () => {
  const cfg = buildImagegenRuntimeConfig({ imagegen: { endpoint: "http://stub" } });
  const pngBytes = Buffer.from("fake-png-bytes");
  const fetchStub = async (url, init) => {
    assert.equal(url, "http://stub/sdapi/v1/txt2img");
    assert.equal(JSON.parse(init.body).prompt, "p");
    return { ok: true, json: async () => ({ images: [pngBytes.toString("base64")] }) };
  };
  const out = await txt2img("p", cfg, fetchStub);
  assert.deepEqual(out, pngBytes);
});

await check("txt2img: no endpoint / HTTP error / empty images all throw", async () => {
  await assert.rejects(() => txt2img("p", buildImagegenRuntimeConfig({})), /endpoint/i);
  const cfg = buildImagegenRuntimeConfig({ imagegen: { endpoint: "http://stub" } });
  await assert.rejects(
    () => txt2img("p", cfg, async () => ({ ok: false, status: 500, text: async () => "boom" })),
    /HTTP 500/
  );
  await assert.rejects(
    () => txt2img("p", cfg, async () => ({ ok: true, json: async () => ({ images: [] }) })),
    /no images/i
  );
});

await check("saveGeneratedImage: writes under <writableCore>/generated with slug name", () => {
  const file = saveGeneratedImage(Buffer.from("png"), "The Gilded Flagon!");
  assert.ok(file.includes(path.join("generated", "the-gilded-flagon-")));
  assert.ok(fs.existsSync(file));
  assert.equal(imageSlug("  Weird/Name?? "), "weird-name");
  assert.equal(imageSlug(""), "image");
});

console.log(failures ? `\n${failures} failure(s)` : "\nAll imagegen tests passed");
process.exit(failures ? 1 : 0);
