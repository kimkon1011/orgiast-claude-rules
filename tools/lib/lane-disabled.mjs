// PC ごとにレーンを恒久的に無効化する（~/.claude/lanes-disabled.json）。
// 例: {"gemini": {"reason": "2026-11-15 kim 指示: 008 は Gemini をやめる", "since": "2026-11-15"}}
// gemini を無効にすると gemini-cli（同じ GEMINI_API_KEY を使う）も無効になる。
// 無効レーンは lane-doctor が probe せず alive=false/reason=disabled とし、codex-do と llm-fallback の候補から外す。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export function disabledLanesFile(home = process.env.ORGIAST_HOME || os.homedir()) { return path.join(home, '.claude', 'lanes-disabled.json'); }
export function disabledLanes(home = process.env.ORGIAST_HOME || os.homedir()) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(disabledLanesFile(home), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { return new Set(); }
  const names = Array.isArray(data) ? data : Object.keys(data);
  const set = new Set(names.map(n => String(n).trim().toLowerCase()).filter(Boolean));
  if (set.has('gemini')) set.add('gemini-cli');
  return set;
}
