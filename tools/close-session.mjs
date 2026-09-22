import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./session-list-tidy.mjs";
import { launchNextSession } from "./next-session-launch.mjs";

import { rotate } from "./next-session-rotate.mjs";

const claudeDir = join(homedir(), ".claude");
const currentPath = join(claudeDir, "current-session.json");
const currentSessionsDir = join(claudeDir, "current-sessions");
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

// 退避先に同名（または .dupN）の実物があるかを見る。成功文はこの実物で決める。
// purge の標準出力や終了コードを成功の根拠にしない（stdio を捨てていた頃、
// 退避されていないのに「45秒で消えます」と報告して user に指摘された・2026-09-21）。
function findArchived(sid) {
  const root = join(claudeDir, "projects", "_deleted-backup", "_closed");
  let projects;
  try { projects = readdirSync(root); } catch { return null; }
  for (const proj of projects) {
    const dir = join(root, proj);
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    const hit = names.find((name) => name === `${sid}.jsonl` || name.startsWith(`${sid}.jsonl.dup`));
    if (hit) return join(dir, hit);
  }
  return null;
}

const python = resolvePython();
let purgeWarning = null;
if (!python) {
  purgeWarning = "Python が見つからないため purge を実行できませんでした（退避されません）";
} else {
  const purge = spawnSync(python, [purgePath], { encoding: "utf8", windowsHide: true });
  if (purge.error) {
    purgeWarning = `purge を起動できませんでした: ${purge.error.message}`;
  } else if (purge.status !== 0) {
    const detail = String(purge.stderr || "").trim().slice(0, 300);
    purgeWarning = `purge が異常終了しました (status=${purge.status})${detail ? `: ${detail}` : ""}`;
  }
}
if (!existsSync(purgePath)) console.error(`warn: purge スクリプトが見つかりません: ${purgePath}`);
if (purgeWarning) console.error(`warn: ${purgeWarning}`);

const archived = findArchived(sessionId);
console.log(archived
  ? `closed: ${sessionId} -> 退避済み: ${archived}`
  : `closed: ${sessionId} -> 台帳に登録（まだ退避されていない。直近45秒以内に更新されたため）`);
// 台帳の id は退避後も残るので、この後この セッションが発言して .jsonl が作り直されても
// 30秒間隔のウォッチャーが拾い直す。ただし VSCode の一覧から消えるのはタブを閉じた後。
// 拡張はタブを開いている限りセッションを保持し、会話が続けば .jsonl を作り直す。
console.log("実体は _deleted-backup/_closed に保全（/clear 不要）。VSCode の一覧から消えるのはこのタブを閉じた後です");

if (!process.argv.includes("--no-launch")) {
  try {
    const launchArgs = ["--session", sessionId];
    if (process.argv.includes("--force-launch")) launchArgs.push("--force");
    await launchNextSession(launchArgs);
  } catch {
    // 次セッションの起動失敗で、完了済みの close-session を失敗扱いにしない。
  }
}
