import { readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { launchPurge } from "./purge-sessions.mjs";
import { launchNextSession } from "./next-session-launch.mjs";

import { rotate } from "./next-session-rotate.mjs";

const claudeDir = join(homedir(), ".claude");
const currentPath = join(claudeDir, "current-session.json");
const currentSessionsDir = join(claudeDir, "current-sessions");
const closedPath = join(claudeDir, "closed-sessions.json");
function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const sessionIndex = process.argv.indexOf("--session");
let sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : undefined;
if (sessionIndex < 0) {
  let entries;
  try {
    entries = readdirSync(currentSessionsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJson(join(currentSessionsDir, name), null))
      .filter((entry) => entry?.sessionId && !Number.isNaN(Date.parse(entry.at)))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  } catch {
    entries = null;
  }
  if (entries) {
    const recent = entries.filter((entry) => Date.now() - Date.parse(entry.at) <= 60_000);
    if (recent.length >= 2) {
      const candidates = recent.map((entry) => `${entry.sessionId} (${entry.at})`).join(", ");
      console.error(`複数のセッションが同時に動いています。--session <id> を明示してください。候補: ${candidates}`);
      process.exit(1);
    }
    sessionId = entries[0]?.sessionId;
  } else {
    sessionId = readJson(currentPath, {}).sessionId;
  }
}
if (!sessionId) {
  console.error("session ID がありません（--session または current-sessions/current-session.json が必要です）");
  process.exit(1);
}

rotate(join(claudeDir, "next-session.md"));

const stored = readJson(closedPath, { ids: [] });
const ids = Array.isArray(stored.ids) ? stored.ids : [];
if (!ids.includes(sessionId)) {
  ids.push(sessionId);
  const tmpPath = `${closedPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, `${JSON.stringify({ ids: ids.slice(-500) }, null, 2)}\n`, "utf8");
  renameSync(tmpPath, closedPath);
}

launchPurge();

console.log(`closed: ${sessionId} -> このタブを ✕ で閉じてください。次回の SessionStart/Stop で退避されます（稼働中セッションは保護されます）`);

if (!process.argv.includes("--no-launch")) {
  try {
    const launchArgs = ["--session", sessionId];
    if (process.argv.includes("--force-launch")) launchArgs.push("--force");
    await launchNextSession(launchArgs);
  } catch {
    // 次セッションの起動失敗で、完了済みの close-session を失敗扱いにしない。
  }
}
