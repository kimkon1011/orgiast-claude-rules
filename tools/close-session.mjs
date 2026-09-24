import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython } from "./session-list-tidy.mjs";
import { launchNextSession } from "./next-session-launch.mjs";

import { rotate } from "./next-session-rotate.mjs";
import { recordClosed } from "./closed-sessions-ledger.mjs";

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

const recorded = recordClosed(sessionId, closedPath, {
  onError: (e) => console.error(`closed-sessions.json に書けませんでした: ${e.message}`),
});

const python = resolvePython();
let purgeFailed = null;
if (!python) {
  purgeFailed = "python が見つかりません";
} else {
  // stdio を捨てると purge の失敗に誰も気付けない（2026-09-22 実害）。必ず結果を見る。
  const purge = spawnSync(python, [purgePath], { encoding: "utf8", windowsHide: true });
  if (purge.error) purgeFailed = purge.error.message;
  else if (purge.status !== 0) {
    const tail = purge.stderr ? `: ${purge.stderr.trim().split("\n").slice(-3).join(" / ")}` : "";
    purgeFailed = `exit ${purge.status}${tail}`;
  }
}

if (!recorded) {
  console.error(`未完了: ${sessionId} を closed-sessions.json に記録できませんでした（一覧から消えません）`);
  if (purgeFailed) console.error(`  purge も失敗しています: ${purgeFailed}`);
  process.exit(1);
}
if (purgeFailed) {
  console.error(`警告: 台帳には記録しましたが purge が失敗しました: ${purgeFailed}`);
  console.error("  常駐ウォッチャーが拾えば退避されますが、消えない場合は手で確認してください");
} else {
  // 退避条件は「jsonl が 45 秒間更新されていないこと」。閉じた本人のセッションで
  // 会話を続けている間は書き込みが続くので、その間は一覧に残る（仕様）。
  console.log(`closed: ${sessionId} -> このセッションの書き込みが 45 秒止まった時点で一覧から消えます（/clear 不要）`);
  console.log("  ※ 続けて会話するとその都度カウントし直しになります");
}

if (!process.argv.includes("--no-launch")) {
  try {
    const launchArgs = ["--session", sessionId];
    if (process.argv.includes("--force-launch")) launchArgs.push("--force");
    await launchNextSession(launchArgs);
  } catch {
    // 次セッションの起動失敗で、完了済みの close-session を失敗扱いにしない。
  }
}
