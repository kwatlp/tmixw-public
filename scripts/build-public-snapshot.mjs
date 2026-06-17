#!/usr/bin/env node
/**
 * build-public-snapshot.mjs
 *
 * Builds the public snapshot of tmíxʷ (kwatlp/tmixw-public) from this private
 * repo. The model is deliberately simple and auditable:
 *
 *   publish set = (git-tracked files)  -  DENYLIST   then  + public-overlay/*
 *
 * 1. Start from `git ls-files`. This auto-excludes everything gitignored
 *    (node_modules, models, release/, renderer/dist, resources/bin binaries,
 *    core/ runtime state, .cursor, .claude, scripts/.shots, …) for free.
 * 2. Remove the DENYLIST: tracked-but-internal paths that must never ship.
 *    After the docs split this is just `internal-docs/` plus a few odds and ends.
 * 3. Overlay `public-overlay/<path>` onto `<snapshot>/<path>`. These are the
 *    handful of files whose public version intentionally differs (README, etc.).
 * 4. Copy into the target, normalizing text files to LF (binaries copied raw).
 * 5. Delete any file tracked in the target that is no longer in the publish set,
 *    so the snapshot is an exact mirror (idempotent).
 *
 * The script does NOT commit or push — it only updates the working tree of the
 * target clone. Review with `git -C <target> status`, then commit & push.
 *
 * Usage:
 *   node scripts/build-public-snapshot.mjs [--target <path>] [--dry-run]
 *
 *   --target   Path to the public clone (default: <repo>/release/tmixw-public)
 *   --dry-run  Print the plan; write nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Tracked paths that must never ship. Entries ending in "/" match a whole
// subtree; others match an exact file path (repo-relative, forward slashes).
const DENYLIST = [
  "internal-docs/",        // internal docs (milestones, plans, design, testing, roadmaps)
  "qa/",                   // internal QA notes
  "public-overlay/",       // build input for THIS script, not shipped
  "build/azure-sign.cjs",  // Windows signing implementation
  "build/metadata.json",   // signing metadata
  "prompts/MILESTONE_0.2.0.md", // stray internal milestone living under prompts/
];

// Files copied verbatim as bytes (no line-ending normalization). Anything not
// matched here is sniffed for NUL bytes and treated as binary if found.
const BINARY_EXT = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp",
  "pdf", "docx", "doc", "xlsx", "pptx",
  "mp3", "wav", "ogg", "m4a", "flac",
  "zip", "gz", "tar", "7z",
  "woff", "woff2", "ttf", "otf", "eot",
  "onnx", "bin", "exe", "dll", "node",
]);

const OVERLAY_DIR = "public-overlay";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(args, cwd, { ownIndex = false } = {}) {
  // A GIT_INDEX_FILE in the environment is meant for the SOURCE repo only;
  // never let it leak into calls against the target clone.
  const env = { ...process.env };
  if (ownIndex) delete env.GIT_INDEX_FILE;
  return execFileSync("git", args, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
}

/** `git ls-files -z` -> array of repo-relative paths (forward slashes). */
function trackedFiles(cwd, opts) {
  const out = git(["ls-files", "-z"], cwd, opts).toString("utf8");
  return out.split("\0").filter(Boolean);
}

function isDenied(relPath) {
  return DENYLIST.some((rule) =>
    rule.endsWith("/") ? relPath.startsWith(rule) : relPath === rule
  );
}

function ext(p) {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i + 1).toLowerCase();
}

/** Heuristic: binary by extension, or contains a NUL byte. */
function isBinary(buf, relPath) {
  if (BINARY_EXT.has(ext(relPath))) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function copyFile(srcAbs, destAbs, relPath, dryRun) {
  if (dryRun) return;
  mkdirSync(dirname(destAbs), { recursive: true });
  const buf = readFileSync(srcAbs);
  if (isBinary(buf, relPath)) {
    writeFileSync(destAbs, buf);
  } else {
    // Normalize CRLF/CR -> LF so the snapshot has a consistent line ending.
    const text = buf.toString("utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    writeFileSync(destAbs, text, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const targetArgIdx = args.indexOf("--target");

const root = git(["rev-parse", "--show-toplevel"], process.cwd()).toString().trim();
const target =
  targetArgIdx >= 0 && args[targetArgIdx + 1]
    ? resolve(args[targetArgIdx + 1])
    : join(root, "release", "tmixw-public");

if (!existsSync(target)) {
  console.error(`Target snapshot path does not exist: ${target}`);
  console.error("Clone kwatlp/tmixw-public there first, or pass --target <path>.");
  process.exit(1);
}

// 1+2. Tracked files minus denylist.
const tracked = trackedFiles(root);
const denied = tracked.filter(isDenied);
let publish = tracked.filter((p) => !isDenied(p));

// 3. Overlay: public-overlay/<path> -> <path>. Source map: relPath -> absolute source.
const sources = new Map();
for (const rel of publish) sources.set(rel, join(root, rel));

const overlayFiles = tracked
  .filter((p) => p.startsWith(OVERLAY_DIR + "/") && p !== `${OVERLAY_DIR}/OVERLAY.md`);
const overlayApplied = [];
for (const rel of overlayFiles) {
  const mapped = rel.slice(OVERLAY_DIR.length + 1); // strip "public-overlay/"
  sources.set(mapped, join(root, rel));             // override (or add)
  if (!publish.includes(mapped)) publish.push(mapped);
  overlayApplied.push(mapped);
}
publish = [...new Set(publish)].sort();

// 4. Copy into target.
for (const rel of publish) {
  copyFile(sources.get(rel), join(target, ...rel.split("/")), rel, dryRun);
}

// 5. Remove target-tracked files no longer in the publish set (exact mirror).
const publishSet = new Set(publish);
let removed = [];
try {
  const targetTracked = trackedFiles(target, { ownIndex: true });
  removed = targetTracked.filter((p) => !publishSet.has(p));
  for (const rel of removed) {
    if (!dryRun) rmSync(join(target, ...rel.split("/")), { force: true });
  }
} catch {
  console.warn("(target is not a git repo — skipped stale-file cleanup)");
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`${dryRun ? "[dry-run] " : ""}Public snapshot build`);
console.log(`  source : ${root}`);
console.log(`  target : ${target}`);
console.log(`  published files : ${publish.length}`);
console.log(`  excluded (denylist) : ${denied.length}`);
console.log(`  overlay applied : ${overlayApplied.length} -> ${overlayApplied.join(", ") || "(none)"}`);
console.log(`  stale removed from target : ${removed.length}`);
if (removed.length) for (const r of removed.slice(0, 20)) console.log(`      - ${r}`);
if (!dryRun) {
  console.log(`\nReview, then publish:`);
  console.log(`  git -C "${target}" add -A && git -C "${target}" status`);
  console.log(`  git -C "${target}" commit -m "Sync public snapshot" && git -C "${target}" push`);
}
