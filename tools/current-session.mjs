#!/usr/bin/env node
// UserPromptSubmit hook（2026-08-26）
// 「今どのセッションが生きているか」を記録する最小 hook。
//  - /session-close skill から close-session.mjs が session_id を知るために使う
//    （モデル側は session_id を直接持てないので、hook が渡す唯一の経路）
//  - purge-hidden-sessions.py が「稼働中セッションを誤退避しない」ガードに使う
// /session-close 系のプロンプト時だけ session_id を stdout へ渡す。失敗しても常に exit 0。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

try {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch { /* stdin 無しでも動く */ }
  const o = JSON.parse(raw || "{}");
  const sessionId = o.session_id || "";
  if (sessionId) {
    const record = {
      sessionId,
      cwd: o.cwd || "",
      at: new Date().toISOString(),
    };
    const dest = path.join(os.homedir(), ".claude", "current-session.json");
    const tmp = dest + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, dest);

    const sessionsDir = path.join(os.homedir(), ".claude", "current-sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sessionDest = path.join(sessionsDir, `${sessionId}.json`);
    const sessionTmp = `${sessionDest}.tmp-${process.pid}`;
    fs.writeFileSync(sessionTmp, JSON.stringify(record, null, 2));
    fs.renameSync(sessionTmp, sessionDest);

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    try {
      for (const name of fs.readdirSync(sessionsDir)) {
        try {
          const entry = path.join(sessionsDir, name);
          if (fs.statSync(entry).mtimeMs < cutoff) fs.unlinkSync(entry);
        } catch { /* 個別エントリの掃除失敗は無視 */ }
      }
    } catch { /* 掃除失敗は無視 */ }

    const prompt = typeof o.prompt === "string" ? o.prompt : "";
    if (prompt.includes("/session-close") || prompt.includes("session-close")) {
      console.log(`[session] このセッションのIDは ${sessionId}。close-session.mjs を呼ぶときは必ず --session ${sessionId} を付けよ（並行セッションがあると引数なしでは別セッションを閉じる）。`);
    }
  }
} catch { /* 記録失敗は握りつぶす */ }
process.exit(0);
