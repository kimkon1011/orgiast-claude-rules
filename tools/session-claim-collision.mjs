#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { purposeTokens, jaccard } from './lib/purpose-tokens.mjs';
import os from 'node:os';
import path from 'node:path';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { syncClaims } from './session-claims.mjs';
import { openSessionClaimCache } from './lib/session-claim-cache.mjs';

// 2026-09-17: 無関係な目的同士の実測最大0.04。その5倍を安全側の閾値に採用。
export const COLLISION_THRESHOLD = 0.20;
const ACTIVE_AGE_MS = 8 * 60 * 60 * 1000;
const UNDECLARED_TTL_MS = 60_000;

function argValue(name) { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; }

function localMinute(timestamp) {
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}


// 着手印の台帳を更新する。この hook は SessionStart / UserPromptSubmit に登録済みなので、
// 目的を宣言した次の発話で claim が自動的に載る（手で印を書く運用にしない）。
// 台帳が書けなくても衝突警告の邪魔をしないよう、失敗は完全に握り潰す。
function persistClaimsQuietly(base, now, cache) {
  try { syncClaims(base, [], now, cache); } catch { /* fail-open */ }
}

function latchFile(home, sessionId) {
  return path.join(home, '.claude', 'session-claim-latch', sessionId.replace(/[^\w-]/g, '_'));
}

function recentlyUndeclared(file, now) {
  try {
    const age = now - fs.statSync(file).mtimeMs;
    return age >= 0 && age < UNDECLARED_TTL_MS;
  } catch { return false; }
}

async function main() {
  try {
    if (process.argv.includes('--help')) return;
    const raw = await readStdinWithTimeout();
    let input = {};
    try { if (raw) input = JSON.parse(raw); } catch { return; }
    const sessionId = String(argValue('--session-id') || process.env.CLAUDE_SESSION_ID || input.session_id || '');
    const home = process.env.ORGIAST_HOME || os.homedir();
    const preToolUse = input.hook_event_name === 'PreToolUse';
    const now = Date.now();
    const latch = latchFile(home, sessionId);
    const undeclaredLatch = `${latch}.undeclared`;
    if (preToolUse && sessionId && (fs.existsSync(latch) || recentlyUndeclared(undeclaredLatch, now))) return;

    const base = path.resolve(home, '.claude');
    const cache = openSessionClaimCache(base, now, ACTIVE_AGE_MS);
    persistClaimsQuietly(base, now, cache);
    if (!sessionId) { cache.save(); return; }
    const projectsDir = path.resolve(process.env.CLAUDE_PROJECTS_DIR || path.join(base, 'projects'));
    let slugs;
    try { slugs = cache.readDirectory(projectsDir).filter((entry) => entry.isDirectory()); } catch { cache.save(); return; }

    const sessions = [];
    for (const slug of slugs) {
      const dir = path.join(projectsDir, slug.name);
      let names;
      try { names = cache.readDirectory(dir).map((entry) => entry.name).filter((name) => name.endsWith('.jsonl')); } catch { continue; }
      for (const name of names) {
        const file = path.join(dir, name);
        let stat;
        try { stat = cache.stat(file); } catch { continue; }
        if (!stat.isFile() || now - stat.mtimeMs > ACTIVE_AGE_MS) {
          cache.discard(file);
          continue;
        }
        let purpose;
        try { purpose = cache.purpose(file, stat); } catch { continue; }
        if (purpose.length < 4 || purpose.includes('<目的>')) continue;
        sessions.push({ sessionId: path.basename(name, '.jsonl'), purpose, tokens: purposeTokens(purpose), mtimeMs: stat.mtimeMs });
      }
    }

    cache.save();
    const own = sessions.filter((entry) => entry.sessionId === sessionId).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (preToolUse) {
      try {
        fs.mkdirSync(path.dirname(latch), { recursive: true });
        fs.writeFileSync(own ? latch : undeclaredLatch, own?.purpose ?? '');
      } catch { /* fail-open */ }
    }
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
