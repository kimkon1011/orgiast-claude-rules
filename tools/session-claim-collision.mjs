#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { purposeTokens, jaccard } from './lib/purpose-tokens.mjs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

// 2026-09-17: 無関係な目的同士の実測最大0.04。その5倍を安全側の閾値に採用。
export const COLLISION_THRESHOLD = 0.20;
const ACTIVE_AGE_MS = 8 * 60 * 60 * 1000;
const PURPOSE_MARKER = '**[本セッションの目的]**';

function argValue(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; }

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

async function main() {
  try {
    if (process.argv.includes('--help')) return;
    const raw = await readStdinWithTimeout();
    let input = {};
    try { if (raw) input = JSON.parse(raw); } catch { return; }
    const sessionId = String(argValue('--session-id') || process.env.CLAUDE_SESSION_ID || input.session_id || '');
    if (!sessionId) return;
    const home = process.env.ORGIAST_HOME || os.homedir();
    const projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(home, '.claude', 'projects');
    const now = Date.now();
    let slugs;
    try { slugs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return; }

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
    if (!own) return;
    const collisions = [];
    for (const candidate of sessions) {
      if (candidate.sessionId === sessionId) continue;
      const similarity = jaccard(own.tokens, candidate.tokens);
      if (similarity >= COLLISION_THRESHOLD) collisions.push({ candidate, similarity });
    }
    if (collisions.length === 0) return;
    collisions.sort((a, b) => b.similarity - a.similarity);
    const lines = ['⚠️ 着手衝突の疑い: この目的は別セッションが先に着手している可能性がある。'];
    for (const { candidate, similarity } of collisions.slice(0, 3)) {
      const purpose = candidate.purpose.replace(/\s+/g, ' ').trim().slice(0, 120);
      lines.push(`- セッション ${candidate.sessionId.slice(0, 8)} / 最終活動 ${localMinute(candidate.mtimeMs)} / 類似度 ${similarity.toFixed(2)}`);
      lines.push(`  目的: ${purpose}`);
    }
    lines.push('着手前に確認せよ: (1) 相手の worktree/branch が既にあるか `git worktree list` と `git branch -a` で見る');
    lines.push('(2) 重複なら着手せず /session-start で別の目的を選び直す');
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
