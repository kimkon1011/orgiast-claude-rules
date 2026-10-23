#!/usr/bin/env node
// Remote Control の会話名はサーバー側（スマホ/claude.ai の一覧）にしか無く、PC の VSCode 一覧は最初の発言を名前にする。
// 名前が食い違うとスマホで見えている会話を PC で探せないので、サーバーの名前を custom-title 行として transcript に足す。
// mtime は元に戻す（一覧の並び順を変えない）。稼働中の transcript には書かない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const MINUTE = 60_000;
const COOLDOWN = 15 * MINUTE;
const IDLE = 10 * MINUTE;
const RECENT = 7 * 24 * 60 * MINUTE;
const MAX_FETCH = 30;
const MAX_BYTES = 64 * 1024 * 1024;
const BASE_URL = 'https://api.anthropic.com';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function headers(base) {
  const token = json(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
  const org = json(path.join(path.dirname(base), '.claude.json')).oauthAccount?.organizationUuid;
  if (!token || !org) return null;
  return { Authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org };
}

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64);
    return buf.subarray(0, fs.readSync(fd, buf, 0, 64, 0)).toString('utf8');
  } finally { fs.closeSync(fd); }
}

// 先頭行が bridge-session で、まだ名前の行（custom-title / ai-title）が無い transcript だけが対象。
export function untitledBridge(text) {
  const first = text.slice(0, text.indexOf('\n') >>> 0);
  let head;
  try { head = JSON.parse(first); } catch { return null; }
  if (head.type !== 'bridge-session' || !head.bridgeSessionId || !head.sessionId) return null;
  if (text.includes('"type":"custom-title"') || text.includes('"type":"ai-title"')) return null;
  return { sessionId: head.sessionId, bridgeSessionId: head.bridgeSessionId };
}

export async function syncRemoteTitles({ base = path.join(os.homedir(), '.claude'), now = Date.now(), fetchImpl = fetch, dryRun = false } = {}) {
  const stateFile = path.join(base, 'sync-remote-titles-state.json');
  if (!dryRun && now - (json(stateFile).at ?? 0) < COOLDOWN) return { skipped: 'cooldown' };
  const h = headers(base);
  if (!h) return { skipped: 'no-credentials' };
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify({ at: now }));
  const result = { candidates: 0, titled: 0, failed: 0, sessions: [] };
  const projects = path.join(base, 'projects');
  let dirs = [];
  try { dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('_')); } catch { return result; }
  for (const dir of dirs) {
    for (const name of fs.readdirSync(path.join(projects, dir.name))) {
      if (!name.endsWith('.jsonl') || result.candidates >= MAX_FETCH) continue;
      const file = path.join(projects, dir.name, name);
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs < IDLE || now - stat.mtimeMs > RECENT || stat.size > MAX_BYTES) continue;
      if (!readHead(file).startsWith('{"type":"bridge-session"')) continue;
      const target = untitledBridge(fs.readFileSync(file, 'utf8'));
      if (!target) continue;
      result.candidates++;
      try {
        const r = await fetchImpl(`${BASE_URL}/v1/code/sessions/${encodeURIComponent(target.bridgeSessionId)}`, { headers: h, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) { result.failed++; continue; }
        const body = await r.json();
        const title = String((body.response_shape ?? body).title ?? '').split('\n')[0].trim();
        // 名前が付く前の仮名（remote-control-mossy-island 等）は最初の発言より分かりにくいので写さない。
        if (!title || /^remote-control-[a-z]+-[a-z]+$/.test(title)) continue;
        result.sessions.push({ sessionId: target.sessionId, title });
        if (dryRun) continue;
        const fresh = fs.statSync(file);
        if (fresh.size !== stat.size || fresh.mtimeMs !== stat.mtimeMs) continue;
        const prefix = fs.readFileSync(file).at(-1) === 0x0a ? '' : '\n';
        fs.appendFileSync(file, `${prefix}${JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: target.sessionId })}\n`);
        fs.utimesSync(file, stat.atime, stat.mtime);
        result.titled++;
      } catch { result.failed++; }
    }
  }
  return result;
}

if (isEntry(import.meta.url)) {
  syncRemoteTitles({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
