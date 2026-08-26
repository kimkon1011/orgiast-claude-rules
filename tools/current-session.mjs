#!/usr/bin/env node
// UserPromptSubmit hook（2026-08-26）
// 「今どのセッションが生きているか」を 1 ファイルに記録するだけの最小 hook。
//  - /session-close skill から close-session.mjs が session_id を知るために使う
//    （モデル側は session_id を直接持てないので、hook が渡す唯一の経路）
//  - purge-hidden-sessions.py が「稼働中セッションを誤退避しない」ガードに使う
// stdout には何も出さない（コンテキストを汚さない）。失敗しても常に exit 0。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { /* stdin 無しでも動く */ }
  const o = JSON.parse(raw || "{}");
  const sessionId = o.session_id || "";
  if (sessionId) {
    const dest = path.join(os.homedir(), ".claude", "current-session.json");
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      sessionId,
      cwd: o.cwd || "",
      at: new Date().toISOString(),
    }, null, 2));
    fs.renameSync(tmp, dest);
  }
} catch { /* 記録失敗は握りつぶす */ }
process.exit(0);
