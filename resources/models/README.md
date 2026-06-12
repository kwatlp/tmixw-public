# Bundled embeddings model

`Xenova/all-MiniLM-L6-v2` — the MiniLM model `core/embeddings.js` uses for
memory/lorebook vector retrieval. Shipping it here (instead of relying on the
`@xenova/transformers` cache inside `node_modules`) keeps embeddings fully
offline and reinstall-proof: when these files exist, `core/embeddings.js`
points transformers at this directory and disables remote fetches entirely.

Four files, layout exactly as transformers expects:

```
Xenova/all-MiniLM-L6-v2/
  config.json             (tracked in git)
  tokenizer.json          (tracked in git)
  tokenizer_config.json   (tracked in git)
  onnx/model_quantized.onnx   (NOT tracked — ~22 MB, see below)
```

## Getting `model_quantized.onnx` (one-time, fresh clones)

Either copy it from a machine that has booted the app once:

```
node_modules/@xenova/transformers/.cache/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx
```

…or download it from HuggingFace:
<https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/onnx/model_quantized.onnx>

`npm run electron:build` fails with instructions when the file is missing
(`scripts/check-phase4-resources.js`). Dev runs without it fall back to the
old cache-or-fetch behavior — nothing breaks, it just isn't offline-safe.

The packaged app picks these up via electron-builder `extraResources`
(`resources/models/` → `<resources>/models/`).
