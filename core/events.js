import fs from "node:fs";
import { getEventsPath } from "./app_paths.js";

/**
 * @param {Record<string, unknown>} record
 */
export function appendEvent(record) {
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(getEventsPath(), line, "utf8");
}
