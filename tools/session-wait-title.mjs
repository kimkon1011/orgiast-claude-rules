#!/usr/bin/env node
// Stop hook: 応答末尾の「このセッション: まだ閉じない（…YYYY-MM-DD HH:MM まで待つ）」の期限を、
// セッション一覧のタイトルの頭に【11/02/20:11まで】の形（年なし）で付ける（2026-10-27 nishi 指示・全PC全アカウント）。
// 一覧を見ただけで、どのタブをいつまで開けておくかが分かるようにする。
// 閉じてよい定型文になったら頭の期限を外す。フッターが無い応答では何もしない。fail-open・出力なし。
// --all: 既存の全セッション（直近 RECENT_DAYS 日）にも同じ規則を当てる。SessionStart から1時間に1回だけ走る。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { footerValues, openDeadline } from './next-action-gate.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const RECENT_DAYS = 30;
const SWEEP_COOLDOWN_MS = 60 * 60 * 1000;
// 旧形式【26/11/02/20:11まで】（年あり）も外して新形式へ付け替える。
const PREFIX = /^【(?:\d{2}\/)?\d{2}\/\d{2}\/\d{2}:\d{2}まで】\s*/;

export function waitPrefix(date) {
  const p = n => String(n).padStart(2, '0');
  return `【${p(date.getMonth() + 1)}/${p(date.getDate())}/${p(date.getHours())}:${p(date.getMinutes())}まで】`;
}

// transcript から現在のタイトル（custom-title が最優先、無ければ ai-title）を最後の行の値で拾う。
export function currentTitles(raw) {
  let custom = '', ai = '', firstPrompt = '';
  for (const line of String(raw || '').split('\n')) {
    if (line.includes('"custom-title"')) { try { const e = JSON.parse(line); if (e.type === 'custom-title' && typeof e.customTitle === 'string') custom = e.customTitle; } catch {} }
    else if (line.includes('"ai-title"')) { try { const e = JSON.parse(line); if (e.type === 'ai-title' && typeof e.aiTitle === 'string') ai = e.aiTitle; } catch {} }
    else if (!firstPrompt && line.includes('"type":"user"')) {
      try {
        const c = JSON.parse(line).message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find(b => b?.type === 'text')?.text : '';
        if (text && !text.startsWith('<')) firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 40);
      } catch {}
    }
  }
  return { custom, ai, firstPrompt };
}

export function lastAssistantText(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"type":"assistant"')) continue;
    try {
      const c = JSON.parse(lines[i]).message?.content;
      const text = Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
      if (text.trim()) return text;
    } catch {}
  }
  return '';
}

// 書くべき custom-title を返す。変更不要なら null。
export function desiredTitle(text, raw) {
  const footer = footerValues(text);
  if (!footer) return null;
  const { custom, ai, firstPrompt } = currentTitles(raw);
  const base = (custom.replace(PREFIX, '') || ai || firstPrompt || 'セッション').trim();
  const deadline = openDeadline(footer.session);
  if (deadline) {
    const next = `${waitPrefix(deadline)}${base}`;
    return next === custom ? null : next;
  }
  // 期限なしの定型文（閉じてよい等）になったら、付けていた期限だけを外す。
  return PREFIX.test(custom) ? base : null;
}

export function apply(input, { readFile = fs.readFileSync, appendFile = fs.appendFileSync, statSize = p => fs.statSync(p).size } = {}) {
  const file = input?.transcript_path || input?.transcriptPath || '';
  const sessionId = input?.session_id || input?.sessionId || '';
  if (!file || !sessionId || /subagents/i.test(file)) return null;
  if (statSize(file) > MAX_BYTES) return null;
  const raw = readFile(file, 'utf8');
  const text = typeof input?.last_assistant_message === 'string' && input.last_assistant_message.trim() ? input.last_assistant_message : lastAssistantText(raw);
  const title = desiredTitle(text, raw);
  if (!title) return null;
  appendFile(file, `${raw.endsWith('\n') ? '' : '\n'}${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId })}\n`);
  return title;
}

// 全プロジェクトの transcript に apply を当てる。subagent・古いもの・巨大なものは飛ばす。
export function sweepAll({ base = path.join(os.homedir(), '.claude'), now = Date.now(), force = false } = {}) {
  const stateFile = path.join(base, 'session-wait-title-state.json');
  try { if (!force && now - JSON.parse(fs.readFileSync(stateFile, 'utf8')).at < SWEEP_COOLDOWN_MS) return { skipped: 'cooldown' }; } catch {}
  try { fs.writeFileSync(stateFile, JSON.stringify({ at: now })); } catch {}
  const result = { scanned: 0, titled: [] };
  const projects = path.join(base, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return result; }
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(path.join(projects, dir.name)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(projects, dir.name, name);
      try {
        if (now - fs.statSync(file).mtimeMs > RECENT_DAYS * 86400_000) continue;
        result.scanned += 1;
        const title = apply({ transcript_path: file, session_id: name.slice(0, -'.jsonl'.length) });
        if (title) result.titled.push({ session: name.slice(0, 8), title });
      } catch { /* 1件の失敗で止めない */ }
    }
  }
  return result;
}

async function main() {
  try {
    if (process.argv.includes('--all')) {
      const result = sweepAll({ force: process.argv.includes('--force') });
      if (process.argv.includes('--verbose')) console.log(JSON.stringify(result, null, 2));
      return;
    }
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    apply(JSON.parse(raw));
  } catch { /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }
