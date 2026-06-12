import fs from "node:fs";
import {
  getSessionPath,
  getRecordingsDir,
  getWorldStatePath,
  getEventsPath
} from "./app_paths.js";

const hard = process.argv.includes("--hard");

function rmIfExists(p) {
  try {
    fs.rmSync(p, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

const removedSession = rmIfExists(getSessionPath());
let removedRecordings = false;
let removedWorld = false;
let removedEvents = false;
if (hard) {
  removedRecordings = rmIfExists(getRecordingsDir());
  removedWorld = rmIfExists(getWorldStatePath());
  removedEvents = rmIfExists(getEventsPath());
}

console.log(
  `[session:reset] session.json: ${removedSession ? "removed" : "not found"}`
);
if (hard) {
  console.log(
    `[session:reset] recordings/: ${removedRecordings ? "cleared" : "not found"}`
  );
  console.log(
    `[session:reset] world_state.json: ${removedWorld ? "removed" : "not found"}`
  );
  console.log(
    `[session:reset] events.jsonl: ${removedEvents ? "removed" : "not found"}`
  );
}

