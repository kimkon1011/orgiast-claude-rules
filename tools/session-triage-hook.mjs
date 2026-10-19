#!/usr/bin/env node
// SessionStart フック: 放置された未完了セッションを1日1回、応答の冒頭に提示させる。
// 旧 session-triage-hook.ps1 の移植。重いトリアージ生成は裏で起動し、セッション起動をブロックしない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const H = process.env.ORGIAST_HOME || os.homedir();
const claudeDir = path.join(H, '.claude');
const guard = path.join(claudeDir, '.session-triage-shown');
const md = path.join(claudeDir, 'session-triage.md');

function ageHours(file) {
  try { return (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000; }
  catch { return Infinity; }
}

// 1日1回だけ提示。並行 SessionStart でも、最初に書いたセッション以外は即終了する。
if (ageHours(guard) < 20) process.exit(0);

// リポの場所は PC で異なるため、この hook と同じ tools/ を最優先し、次に従来の2候補を探す。
const triage = [
  fileURLToPath(new URL('./session-triage.mjs', import.meta.url)),
  path.join(H, 'orgiast-claude-rules', 'tools', 'session-triage.mjs'),
  path.join(H, 'Downloads', 'orgiast-claude-rules', 'tools', 'session-triage.mjs'),
].find((candidate) => fs.existsSync(candidate));

const hasPrevious = fs.existsSync(md);
const stale = !hasPrevious || ageHours(md) >= 24;

// 作り置きが無い/古い場合は裏で更新。古い内容はこの回の提示には使う。
if (stale && triage) {
  try {
    const child = spawn(process.execPath, [triage, '--llm', '--top', '20', '--md', md], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.unref();
  } catch { /* 生成は次回に回す */ }
}
if (!hasPrevious) process.exit(0);

// 並行 SessionStart の二重提示を防ぐため、内容を出力する前にガードを書く。
fs.mkdirSync(claudeDir, { recursive: true });
fs.writeFileSync(guard, new Date().toISOString(), 'utf8');

const text = fs.readFileSync(md, 'utf8');
const lines = text.split(/\r?\n/);
// 列は固定位置で読まない。session-triage.mjs 側に列が増えた時に黙ってズレるため、
// ヘッダー行の見出し名から列番号を引く。
const colIndex = new Map();
const items = [];
for (const line of lines) {
  if (colIndex.size === 0 && /^\s*\|\s*分類\s*\|/.test(line)) {
    const headers = line.split(/(?<!\\)\|/).map((cell) => cell.trim());
    headers.forEach((header, i) => { if (header) colIndex.set(header, i); });
    continue;
  }
  if (items.length >= 5) break;
  if (!/^\s*\|\s*🔴\s+要対応\s*\|/.test(line)) continue;
  if (colIndex.size === 0) continue;
  const cols = line.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const get = (name) => {
    const i = colIndex.get(name);
    return i !== undefined && i < cols.length ? cols[i] : '';
  };
  let title = get('表示名');
  if (title.length > 40) title = `${title.slice(0, 39)}…`;
  const updated = get('更新');
  const sessionCwd = get('cwd');
  const next = get('次アクション');
  const resume = get('再開').replace(/^`+|`+$/g, '');
  // 検索対象はサイドバーの表示名(custom-title > ai-title > summary > 最初のプロンプト)。
  const searchKey = get('検索語');
  items.push(`🔴 [${updated}] ${title} — ${next} / 検索語「${searchKey}」 / ${resume} / cwd: ${sessionCwd}`);
}

const generatedMatch = text.match(/生成時刻\s+(\S+)/);
const generated = generatedMatch ? generatedMatch[1] : fs.statSync(md).mtime.toISOString();
const previousNote = stale ? '※前回生成分' : '';
const body = items.length ? items.join('\n') : '積み残しなし';
const ctx = `【積み残しセッション｜必ずこの応答の冒頭でユーザーに提示すること】
下記は放置されている未完了セッション。ユーザーはこれを見るために何も操作していないので、
今回のユーザー依頼に答える前に、まず1行/件の簡潔な箇条書きで提示し、
「どれか再開しますか？」と一言添える。長い引用や解説は不要。

【提示の絶対ルール】
・タイトルは原文のまま出す。要約・言い換え・略称にしない(例:「内藤さんの会議の続き」を「内藤さんMTG」と書き換えない)。
  VSCodeサイドバーの検索はセッション名の原文にしか当たらず、言い換えると「検索しても出てこない」になる。
・各件に『検索語』をコードブロックかバッククォートでそのまま貼れる形で必ず添える。
・cwd が現在のワークスペースと違う件は「別ワークスペース(<cwd>)なのでこの一覧には出ない」と明記する。

${body}

※詳細は /session-triage。${previousNote} 生成: ${generated}`;

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } }));
