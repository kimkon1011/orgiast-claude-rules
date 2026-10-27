#!/usr/bin/env node
// Stop hook: 応答末尾の「このセッション: まだ閉じない（…YYYY-MM-DD HH:MM まで待つ）」の期限を、
// セッション一覧のタイトルの頭に【26/11/02/20:11まで】の形で付ける（2026-10-27 nishi 指示・全PC全アカウント）。
// 一覧を見ただけで、どのタブをいつまで開けておくかが分かるようにする。
// 閉じてよい定型文になったら頭の期限を外す。フッターが無い応答では何もしない。fail-open・出力なし。
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { footerValues, openDeadline } from './next-action-gate.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const PREFIX = /^【\d{2}\/\d{2}\/\d{2}\/\d{2}:\d{2}まで】\s*/;

export function waitPrefix(date) {
  const p = n => String(n).padStart(2, '0');
  return `【${p(date.getFullYear() % 100)}/${p(date.getMonth() + 1)}/${p(date.getDate())}/${p(date.getHours())}:${p(date.getMinutes())}まで】`;
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

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    apply(JSON.parse(raw));
  } catch { /* fail-open */ }
}

if (isEntry(import.meta.url)) { await main(); process.exitCode = 0; }
