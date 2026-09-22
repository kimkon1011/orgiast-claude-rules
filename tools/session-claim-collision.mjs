#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

// 2026-09-17: 無関係な目的同士の実測最大0.04。その5倍を安全側の閾値に採用。
export const COLLISION_THRESHOLD = 0.20;
const ACTIVE_AGE_MS = 8 * 60 * 60 * 1000;
const PURPOSE_MARKER = '**[本セッションの目的]**';
const stopWords = new Set(['して', 'する', 'します', 'ください', 'お願い', 'それ', 'これ', 'あの', 'the', 'and', 'for', 'with', 'this', 'that']);

function argValue(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; }

// session-purpose-gate.mjs の tokens() と同じ正規化（台帳は参照しない）。
function purposeTokens(text) {
  const found = new Set();
  for (const word of text.match(/[A-Za-z_][A-Za-z0-9_.-]{2,}/g) || []) found.add(word.toLowerCase());
  for (const word of text.match(/[ァ-ヶー]{2,}/g) || []) found.add(word);
  for (const word of text.match(/[一-龥]{2,}/g) || []) {
    if (word.length >= 3) for (let i = 0; i < word.length - 1; i++) found.add(word.slice(i, i + 2));
    else found.add(word);
  }
  for (const word of [...found]) if (word.length < 2 || /^\d+$/.test(word) || stopWords.has(word)) found.delete(word);
  return found;
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function assistantText(record) {
  const content = record?.message?.content ?? record?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

// 目的は transcript の assistant 行の宣言だけから取る。user 行やフックの additionalContext は拾わない。
function purposeFromTranscript(file) {
  let purpose = '';
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return ''; }
  for (const line of raw.split(/\r?\n/)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (record?.type !== 'assistant') continue;
    for (const textLine of assistantText(record).split(/\r?\n/)) {
      // 同じ本文行に複数の宣言があっても最後を採用する。
      const markerAt = textLine.lastIndexOf(PURPOSE_MARKER);
      if (markerAt >= 0) purpose = textLine.slice(markerAt + PURPOSE_MARKER.length).trim();
    }
  }
  if (purpose.length < 4 || purpose.includes('<目的>')) return '';
  return purpose;
}

function localMinute(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

try {
  if (process.argv.includes('--help')) process.exit(0);
  const raw = await readStdinWithTimeout();
  let input = {};
  try { if (raw) input = JSON.parse(raw); } catch { process.exit(0); }
  const event = String(input.hook_event_name || argValue('--event') || 'SessionStart');
  const sessionId = String(argValue('--session-id') || process.env.CLAUDE_SESSION_ID || input.session_id || '');
  if (!sessionId) process.exit(0);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const latchPath = path.join(home, '.claude', 'session-claim-collision', `${sessionId}.checked`);
  if (event === 'PreToolUse' && fs.existsSync(latchPath)) process.exit(0);
  const projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(home, '.claude', 'projects');
  const now = Date.now();
  let slugs;
  try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { process.exit(0); }

  const sessions = [];
  for (const slug of slugs) {
    const dir = path.join(projectsDir, slug.name);
    let names;
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (!stat.isFile() || now - stat.mtimeMs > ACTIVE_AGE_MS) continue;
      const purpose = purposeFromTranscript(file);
      if (!purpose) continue;
      sessions.push({ sessionId: path.basename(name, '.jsonl'), purpose, tokens: purposeTokens(purpose), mtimeMs: stat.mtimeMs });
    }
  }

  const own = sessions.filter((entry) => entry.sessionId === sessionId).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!own) {
    if (event === 'SessionStart' || event === 'UserPromptSubmit') {
      const others = sessions
        .filter((entry) => entry.sessionId !== sessionId)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (others.length > 0) {
        const lines = ['📋 稼働中セッションの目的（着手前に引き継ぎの「次の1目的」と突き合わせること）:'];
        for (const candidate of others.slice(0, 5)) {
          const purpose = candidate.purpose.replace(/\s+/g, ' ').trim().slice(0, 120);
          lines.push(`- セッション ${candidate.sessionId.slice(0, 8)} / 最終活動 ${localMinute(candidate.mtimeMs)}`);
          lines.push(`  目的: ${purpose}`);
        }
        lines.push('同じ目的が既に在るなら、その目的は採らず別の1件を選ぶ（/session-start の手順2）。');
        console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } }));
      }
    }
    process.exit(0);
  }
  const collisions = [];
  for (const candidate of sessions) {
    if (candidate.sessionId === sessionId) continue;
    const similarity = jaccard(own.tokens, candidate.tokens);
    if (similarity >= COLLISION_THRESHOLD) collisions.push({ candidate, similarity });
  }
  if (event === 'PreToolUse') {
    try {
      fs.mkdirSync(path.dirname(latchPath), { recursive: true });
      fs.writeFileSync(latchPath, new Date().toISOString());
    } catch {}
  }
  if (collisions.length === 0) process.exit(0);
  collisions.sort((a, b) => b.similarity - a.similarity);
  const lines = ['⚠️ 着手衝突の疑い: この目的は別セッションが先に着手している可能性がある。'];
  for (const { candidate, similarity } of collisions.slice(0, 3)) {
    const purpose = candidate.purpose.replace(/\s+/g, ' ').trim().slice(0, 120);
    lines.push(`- セッション ${candidate.sessionId.slice(0, 8)} / 最終活動 ${localMinute(candidate.mtimeMs)} / 類似度 ${similarity.toFixed(2)}`);
    lines.push(`  目的: ${purpose}`);
  }
  lines.push('着手前に確認せよ: (1) 相手の worktree/branch が既にあるか `git worktree list` と `git branch -a` で見る');
  lines.push('(2) 重複なら着手せず /session-start で別の目的を選び直す');
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: lines.join('\n') } }));
} catch {}
process.exit(0);
