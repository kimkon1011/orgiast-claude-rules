#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyKim } from './notify-kim.mjs';
import { isEntry } from './is-entry.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const UUID = /^[0-9a-f-]{36}\.jsonl$/i;
const CLOSED = /(?:\/session-close[^\n]{0,80}(?:実行|完了)|session-close skill[^\n]{0,80}(?:実行|完了)|セッションをクローズ(?:しました|済み)|\[SESSION-CLOSE(?:D)?\])/i;
const AUTO = /^\s*(?:\[(?:headless:)?auto-session(?:[^\]]*)\]|\[headless:(?:cheap-code|next-session-launch)\])/i;
const NONE = /\[TODO-NONE\]/i;
const STOP_OK = /\[STOP-OK\]/i;
const WAIT_END = /(?:を待っています|を待って(?:い)?ます|完了後に[^。\n]*(?:します|進めます|確認します))[。.!！]?\s*$/i;
const REMAINDER = /(?:残(?:り|作業|TODO)|未(?:完了|実施|対応)|再開|続きは|引き継ぎ|次セッション|次に(?:行う|やる|進める|対応する)|待ち|保留|pending|TODO)/i;

export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function clean(text) {
  return String(text || '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<ide_(?:opened_file|selection)>[\s\S]*?<\/ide_(?:opened_file|selection)>/gi, ' ')
    .replace(/<(?:command-name|command-message|local-command-stdout)>[\s\S]*?<\/(?:command-name|command-message|local-command-stdout)>/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function clip(text, length) {
  const chars = [...clean(text)];
  return chars.length <= length ? chars.join('') : `${chars.slice(0, length - 1).join('')}…`;
}

function actualUser(event) {
  if (event?.type !== 'user') return false;
  const content = event?.message?.content;
  if (Array.isArray(content) && content.length && content.every((part) => part?.type === 'tool_result')) return false;
  return Boolean(clean(textOf(content)));
}

export function analyzeTranscript({ raw, sessionId, projectDir, mtimeMs, nowMs = Date.now(), nextSession = '' }) {
  const events = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  let purpose = '', lastAssistant = '', lastAssistantIndex = -1, lastUserIndex = -1, cwd = '';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    cwd ||= event?.cwd || '';
    if (actualUser(event)) {
      const value = clean(textOf(event.message.content));
      if (!purpose) purpose = value;
      lastUserIndex = index;
    }
    if (event?.type === 'assistant') {
      const value = clean(textOf(event?.message?.content));
      if (value) { lastAssistant = value; lastAssistantIndex = index; }
    }
  }
  const assistantText = events.filter((event) => event?.type === 'assistant').map((event) => textOf(event?.message?.content)).join('\n');
  if (!purpose || !lastAssistant || CLOSED.test(assistantText) || AUTO.test(purpose) || NONE.test(lastAssistant) || STOP_OK.test(lastAssistant)) return null;
  const assistantIsLastConversation = lastAssistantIndex > lastUserIndex;
  const ageMs = Math.max(0, nowMs - mtimeMs);
  const reasons = [];
  let score = 0;
  if (assistantIsLastConversation && WAIT_END.test(lastAssistant) && ageMs >= 6 * HOUR) {
    reasons.push('待機宣言のまま6時間超'); score = Math.max(score, 90);
  }
  if (assistantIsLastConversation && REMAINDER.test(lastAssistant.slice(-700))) {
    reasons.push('assistant末尾に残作業宣言'); score = Math.max(score, 100);
  }
  if (ageMs >= 3 * DAY && new RegExp(sessionId, 'i').test(nextSession)) {
    reasons.push('next-session TODO参照・3日未着手'); score = Math.max(score, 80);
  }
  if (ageMs >= 3 * DAY) {
    reasons.push('3日以上更新なし・session-closeなし'); score = Math.max(score, 60);
  }
  if (!reasons.length) return null;
  return { sessionId, projectDir, cwd, purpose: clip(purpose, 60), updatedAt: new Date(mtimeMs).toISOString(), ageMs, reason: reasons[0], reasons, remainder: clip(lastAssistant, 120), score };
}

export function rankSessions(items) {
  return [...items].sort((a, b) => b.score - a.score || a.ageMs - b.ageMs || a.sessionId.localeCompare(b.sessionId));
}

function escapeCell(value) { return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '); }
function resume(item) { return `claude --resume ${item.sessionId}`; }
function jst(value) { return new Date(value).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false }); }

export function renderReport(items, now = new Date()) {
  const rows = items.slice(0, 15).map((item) => `| ${escapeCell(item.purpose)} | ${jst(item.updatedAt)} | ${escapeCell(item.reason)} | ${escapeCell(item.remainder)} | \`${resume(item)}\`<br>${escapeCell(item.projectDir)} |`);
  return `# 止まっているセッション\n\n生成: ${jst(now)} / 検出: ${items.length}件（上位15件）\n\n| 目的 | 最終更新 | 止まり方 | 残作業の抜粋 | 再開 |\n|---|---|---|---|---|\n${rows.join('\n') || '| なし | - | - | - | - |'}\n`;
}

const TOP_BEGIN = '<!-- STALLED-SESSIONS:BEGIN -->';
const TOP_END = '<!-- STALLED-SESSIONS:END -->';
export function injectNextActions(existing, items) {
  const body = `${TOP_BEGIN}\n## 止まっているセッション TOP3\n\n${items.slice(0, 3).map((item, i) => `${i + 1}. ${item.purpose}（${jst(item.updatedAt)}） — \`${resume(item)}\``).join('\n') || '- なし'}\n${TOP_END}`;
  const start = existing.indexOf(TOP_BEGIN), end = existing.indexOf(TOP_END, start + TOP_BEGIN.length);
  if (start >= 0 && end >= 0) return `${existing.slice(0, start)}${body}${existing.slice(end + TOP_END.length)}`;
  return `${body}\n\n${existing.replace(/^\uFEFF/, '')}`;
}

export function prependNextSession(existing, item) {
  if (!item || existing.includes(item.sessionId)) return existing;
  const line = `1. 再開: ${item.purpose} — claude --resume ${item.sessionId}`;
  const heading = /^#{1,6}\s+.*(?:残TODO|TODO).*$/im;
  const match = heading.exec(existing);
  if (!match) return `## 残TODO（次の1件を先頭に）\n${line}\n\n${existing}`;
  const at = match.index + match[0].length;
  return `${existing.slice(0, at)}\n${line}${existing.slice(at)}`;
}

async function scan({ projectsRoot, nowMs, nextSession }) {
  const found = [];
  let projects = [];
  try { projects = fs.readdirSync(projectsRoot, { withFileTypes: true }); } catch { return found; }
  for (const project of projects) {
    if (!project.isDirectory() || ['subagents', 'workflows', '_deleted-backup', '_headless'].includes(project.name)) continue;
    let files = [];
    try { files = fs.readdirSync(path.join(projectsRoot, project.name), { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !UUID.test(file.name)) continue;
      const full = path.join(projectsRoot, project.name, file.name);
      try {
        const stat = fs.statSync(full);
        if (nowMs - stat.mtimeMs > 14 * DAY) continue;
        const item = analyzeTranscript({ raw: fs.readFileSync(full, 'utf8'), sessionId: path.basename(file.name, '.jsonl'), projectDir: project.name, mtimeMs: stat.mtimeMs, nowMs, nextSession });
        if (item) found.push(item);
      } catch {}
    }
  }
  return rankSessions(found);
}

export async function run(options = {}) {
  const args = options.args || [];
  const dryRun = args.includes('--dry-run');
  const wslUserHome = process.cwd().match(/^\/mnt\/[a-z]\/Users\/[^/]+/i)?.[0];
  const home = options.home || process.env.ORGIAST_HOME || process.env.USERPROFILE || wslUserHome || os.homedir();
  const base = path.join(home, '.claude');
  const read = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const nextSessionFile = path.join(base, 'next-session.md');
  const nextActionsFile = path.join(base, 'next-actions.md');
  const nextSession = read(nextSessionFile);
  const now = options.now instanceof Date ? options.now : new Date();
  const items = await scan({ projectsRoot: options.projectsRoot || process.env.CLAUDE_PROJECTS_DIR || path.join(base, 'projects'), nowMs: now.getTime(), nextSession });
  const report = renderReport(items, now);
  const log = options.log || console.log;
  if (dryRun) log(report);
  else {
    fs.mkdirSync(base, { recursive: true });
    fs.writeFileSync(path.join(base, 'stalled-sessions.md'), report, 'utf8');
    fs.writeFileSync(nextActionsFile, injectNextActions(read(nextActionsFile), items), 'utf8');
    if (items[0]) fs.writeFileSync(nextSessionFile, prependNextSession(nextSession, items[0]), 'utf8');
    if (items.length) {
      const message = `止まっているセッション: ${items.length}件\n${items.slice(0, 3).map((item, i) => `${i + 1}. ${item.purpose}\n最終更新: ${jst(item.updatedAt)}\n${resume(item)}`).join('\n')}`;
      await (options.notify || notifyKim)(message);
    }
    log(`ok:止まっているセッション${items.length}件`);
  }
  return { items, report };
}

if (isEntry(import.meta.url)) run({ args: process.argv.slice(2) }).catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
