#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { inspect } from './session-triage.mjs';
import { textOf, human, roleOf } from './lib/approval-evidence.mjs';
import { addItem } from './kim-inbox.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { redactSecrets } from './redact-secrets.mjs';
import { isEntry } from './is-entry.mjs';
const DAY = 86400000;
const compact = s => redactSecrets(String(s)).replace(/\s+/g, ' ').trim();
export function waitingReason(title, conclusion, lastRole) {
  if (lastRole === 'user') return '作業途中';
  const s = `${title}\n${conclusion.slice(-800)}`;
  if (/kim\s*待ち|金(?:さん)?待ち|(?:承認|許可|判断|返答)待ち|次に kim がすること[：:]\s*(?!ありません|なし|不要)\S+/i.test(s)) return 'kim 待ち';
  if (/外部待ち|先方.*待ち|返信待ち|審査待ち|(?:CI|API|デプロイ|同期|取り込み).*待ち/i.test(s)) return '外部待ち';
  return '作業途中';
}
async function latest(file) {
  let title = '', custom = false, request = '', assistant = '', lastRole = '', seen = false;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || e.isMeta || e.isCompactSummary) continue;
    seen = true;
    if (e.customTitle) { title = e.customTitle; custom = true; }
    else if (e.aiTitle && !custom) title = e.aiTitle;
    if (human(e)) { const text = textOf(e); if (text.trim()) { request = text; lastRole = 'user'; } }
    if (roleOf(e) === 'assistant' && textOf(e)) { assistant = textOf(e); lastRole = 'assistant'; }
  }
  return { title, request, assistant, lastRole, seen };
}
export async function collectSessions({ home = os.homedir(), now = Date.now() } = {}) {
  const base = path.join(home, '.claude');
  let closed = new Set();
  try { closed = new Set(JSON.parse(fs.readFileSync(path.join(base, 'closed-sessions.json'), 'utf8')).ids ?? []); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const found = new Map();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const e of entries) {
      const file = path.join(dir, e.name);
      if (e.isDirectory() && !['subagents', 'archive', '.archive'].includes(e.name)) walk(file);
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('agent-')) continue;
      const id = path.basename(e.name, '.jsonl');
      const stat = fs.statSync(file);
      if (closed.has(id) || now - stat.mtimeMs > 7 * DAY || !stat.size) continue;
      if (!found.has(id) || found.get(id).mtimeMs < stat.mtimeMs) found.set(id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  walk(path.join(base, 'projects'));
  const result = [];
  for (const [sessionId, file] of found) {
    const current = await latest(file.path);
    if (!current.seen || !current.request) continue;
    const triage = await inspect(file); // Existing title extraction and transcript fallback.
    const name = current.title || triage?.displayTitle || current.request.slice(0, 100);
    if (name.includes('【閉じて可】') || /このセッション[：:]\s*【閉じて可】/.test(current.assistant.slice(-500))) continue;
    result.push({ sessionId, name: compact(name), request: compact(current.request).slice(0, 240), reason: waitingReason(name, current.assistant, current.lastRole), deadline: name.match(/【(\d{2}\/\d{2}\/\d{2}:\d{2})まで】/)?.[1] ?? 'なし', mtimeMs: file.mtimeMs });
  }
  return result.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
export function formatDigest(sessions, label) {
  return [`早朝セッション巡回（${compact(label)}）: 未クローズ ${sessions.length}件`, ...sessions.map(s => `・${s.name} (${s.sessionId})｜最後の依頼: ${s.request}｜${s.reason}｜期限: ${s.deadline}`)].join('\n');
}
export async function runSweep({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), post = addItem, label = resolveFleetLabel(home), dryRun = false } = {}) {
  const sessions = await collectSessions({ home, now });
  const text = formatDigest(sessions, label);
  if (!dryRun) {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
    // Inbox forwards non-kim seats through fleet-mail and retains failed forwards.
    for (let offset = 0; offset < Math.max(1, sessions.length); offset += 20) {
      const part = sessions.slice(offset, offset + 20);
      const item = await post(home, { kind: 'info', source: 'morning-session-sweep', from: label, text: formatDigest(part, label), dedupeKey: `morning-session-sweep:${label}:${day}:${offset / 20}` });
      if (item.forwardError) throw new Error('kim-inbox のfleet転送が未完了です（既存キューに保持）');
    }
  }
  return { sessions, text };
}
if (isEntry(import.meta.url)) {
  try { const r = await runSweep({ dryRun: process.argv.includes('--dry-run') }); console.log(r.text); }
  catch (error) { console.error(`morning-session-sweep: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
