#!/usr/bin/env node
import fs from 'node:fs';
import { latestWaitDeadline, waitPrefix } from './session-wait-title.mjs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { isUnattendedRow } from './lib/unattended-session.mjs';
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
const machineText = text => /^\s*(?:Stop hook feedback\b|Base directory for this skill:|<command-message>|<skill(?:\s|>)|<system-reminder>|<task-notification>|<local-command|<command-name>)/i.test(text);
const unattendedText = text => /^\s*(?:\[headless(?::[^\]]*)?\]|autopilot(?:[- ]tick|\s*[:：])|\[?claude-ai-run\b|(?:auto-session|quota-sweep)(?:\b)|これは[^\n]*PC の Claude Code から kim-PC への依頼です)/i.test(text);
const titleName = title => compact(title.replace(/【[^】]*まで】|【閉じて可】/g, ''));
const short = (text, n) => Array.from(compact(text)).slice(0, n).join('');
const ranks = { 'kim 待ち': 0, '外部待ち': 1, '作業途中': 2 };
function sorted(sessions) {
  return [...sessions].sort((a, b) => ranks[a.reason] - ranks[b.reason]
    || (a.reason === 'kim 待ち' ? (a.deadline === 'なし' ? '99' : a.deadline).localeCompare(b.deadline === 'なし' ? '99' : b.deadline) : 0)
    || b.mtimeMs - a.mtimeMs || a.sessionId.localeCompare(b.sessionId));
}
async function latest(file, home) {
  let title = '', custom = false, request = '', assistant = '', lastRole = '', seen = false, unattended = false;
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    const text = textOf(e);
    unattended ||= isUnattendedRow({ cwd: e.cwd, requestText: roleOf(e) === 'user' ? text : '' }, home)
      || ['sdk-cli', 'sdk-ide'].includes(e.entrypoint || e.entryPoint)
      || (roleOf(e) === 'user' && unattendedText(text));
    if (e.isMeta || e.isCompactSummary) continue;
    seen = true;
    if (e.customTitle) { title = e.customTitle; custom = true; }
    else if (e.aiTitle && !custom) title = e.aiTitle;
    if (human(e) && !machineText(text)) { const text = textOf(e); if (text.trim()) { request = text; lastRole = 'user'; } }
    if (roleOf(e) === 'assistant' && textOf(e)) { assistant = textOf(e); lastRole = 'assistant'; }
  }
  return { title, request, assistant, lastRole, seen, unattended };
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
      if (now - stat.mtimeMs > 7 * DAY || !stat.size) continue;
      if (!found.has(id) || found.get(id).mtimeMs < stat.mtimeMs) found.set(id, { path: file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  walk(path.join(base, 'projects'));
  const result = [];
  let unattendedCount = 0;
  for (const [sessionId, file] of found) {
    const current = await latest(file.path, home);
    if (!current.seen) continue;
    const deadline = latestWaitDeadline(current.assistant);
    if (closed.has(sessionId) && !deadline) continue;
    const name = deadline ? `${waitPrefix(deadline)}${titleName(current.title) || short(current.request, 100)}` : current.title || short(current.request, 100);
    if (!deadline && (name.includes('【閉じて可】') || /このセッション[：:]\s*【閉じて可】/.test(current.assistant.slice(-500)))) continue;
    if (current.unattended || unattendedText(name)) { unattendedCount++; continue; }
    if (!current.request) continue;
    result.push({ sessionId, name: titleName(name) || '名称未設定', request: short(current.request, 60), reason: waitingReason(name, current.assistant, current.lastRole), deadline: name.match(/【(\d{2}\/\d{2}\/\d{2}:\d{2})まで】/)?.[1] ?? 'なし', mtimeMs: file.mtimeMs });
  }
  return Object.assign(sorted(result), { unattendedCount });
}
export function knowledgeSyncDigestLine(home = os.homedir(), now = Date.now()) {
  let upstreamState = {};
  try { upstreamState = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'knowledge-upstream-state.json'), 'utf8')); } catch {}
  let mergeState = {};
  try { mergeState = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'knowledge-merge-state.json'), 'utf8')); } catch {}

  let upstreamSentCount = 0;
  if (upstreamState.sentHashes) {
    for (const val of Object.values(upstreamState.sentHashes)) {
      if (val.sentAt && new Date(val.sentAt).getTime() > now - 86400000) {
        upstreamSentCount++;
      }
    }
  }

  let mergedCount = 0;
  let promoteCount = 0;
  if (mergeState.mergedFiles) {
    for (const val of Object.values(mergeState.mergedFiles)) {
      if (val.at && new Date(val.at).getTime() > now - 86400000) {
        if (val.status === 'merged' || val.status === 'updated') mergedCount++;
      }
    }
  }
  if (Array.isArray(mergeState.promoteQueue)) {
    for (const val of mergeState.promoteQueue) {
      if (val.at && new Date(val.at).getTime() > now - 86400000) promoteCount++;
    }
  }

  return `ナレッジ同期: 昨日の吸い上げ ${upstreamSentCount}件・統合 ${mergedCount}件・ゲート化候補 ${promoteCount}件・未同期PC 0台`;
}

export function formatDigest(sessions, label, options = {}) {
  const home = options.home || os.homedir();
  const now = options.now || Date.now();
  const count = reason => sessions.filter(s => s.reason === reason).length;
  const kLine = knowledgeSyncDigestLine(home, now);
  const lines = [`早朝セッション巡回（${short(label, 100)}）: kim 待ち ${count('kim 待ち')}件／作業途中 ${count('作業途中')}件／外部待ち ${count('外部待ち')}件（計 ${sessions.length}件）`];
  const footer = `${kLine}\n自動実行の未クローズ ${sessions.unattendedCount ?? 0}件（kim の対応不要）`;
  const rows = sorted(sessions);
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    const row = `・${short(titleName(s.name), 120)}｜${s.reason}｜期限: ${s.deadline}｜${short(s.request, 60)}`;
    // kim-inbox caps text at 4000 UTF-16 units. Reserve the omission count and footer.
    const remaining = rows.length - i - 1;
    const tail = remaining ? `ほか ${remaining}件\n${footer}` : footer;
    if ([...lines, row, tail].join('\n').length > 4000) {
      lines.push(`ほか ${rows.length - i}件`);
      break;
    }
    lines.push(row);
  }
  return [...lines, footer].join('\n');
}
export async function runSweep({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), post = addItem, label = resolveFleetLabel(home), dryRun = false } = {}) {
  const sessions = await collectSessions({ home, now });
  const text = formatDigest(sessions, label);
  if (!dryRun) {
    const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
    const item = await post(home, { kind: 'info', source: 'morning-session-sweep', from: label, text,
      dedupeKey: `morning-session-sweep:${label}:${day}`, refresh: true });
    if (item.forwardError) throw new Error('kim-inbox のfleet転送が未完了です（既存キューに保持）');
  }
  return { sessions, text };
}
if (isEntry(import.meta.url)) {
  try { const r = await runSweep({ dryRun: process.argv.includes('--dry-run') }); console.log(r.text); }
  catch (error) { console.error(`morning-session-sweep: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
