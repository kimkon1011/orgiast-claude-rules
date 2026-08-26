import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./session-list-tidy.mjs";

const claudeDir = join(homedir(), ".claude");
const currentPath = join(claudeDir, "current-session.json");
const closedPath = join(claudeDir, "closed-sessions.json");
const repoPurgePath = join(dirname(fileURLToPath(import.meta.url)), "purge-hidden-sessions.py");
let purgePath = repoPurgePath;
try { readFileSync(repoPurgePath); } catch { purgePath = join(claudeDir, "purge-hidden-sessions.py"); }

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const sessionIndex = process.argv.indexOf("--session");
let sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (!sessionId) {
  sessionId = readJson(currentPath, {}).sessionId;
}
if (!sessionId) {
  console.error("session ID がありません（--session または current-session.json が必要です）");
  process.exit(1);
}

const stored = readJson(closedPath, { ids: [] });
const ids = Array.isArray(stored.ids) ? stored.ids : [];
if (!ids.includes(sessionId)) {
  ids.push(sessionId);
  const tmpPath = `${closedPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify({ ids: ids.slice(-500) }, null, 2)}\n`, "utf8");
  renameSync(tmpPath, closedPath);
}

const python = resolvePython();
if (python) spawnSync(python, [purgePath], { stdio: "ignore", windowsHide: true });

console.log(`closed: ${sessionId} -> will disappear from the session list within ~45s (no /clear needed)`);
