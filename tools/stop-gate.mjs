#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const completionPattern = /(完了|反映済|push\s*済|deploy\s*完了|PASS|✅)/i;
const todoHeadingPattern = /(残TODO|残タスク|次タスク|次の一手|残り|未着手|TODO:)/i;
const questionPattern = /(\?|？|どちら|いいですか|しますか|進めて良い|よろしい)/;
const escapePattern = /(\[TODO-NONE\]|\[STOP-OK\]|残TODO\s*:?\s*なし|残タスク\s*:?\s*なし)/i;
const bulletPattern = /^\s*(?:[-*]|\d+\.)\s+\S/;
const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();

export function remainingItems(text) {
  const source = String(text || '');
  const heading = source.match(todoHeadingPattern);
  if (!heading || heading.index === undefined) return [];
  return source.slice(heading.index + heading[0].length).split(/\r?\n/).filter(line => bulletPattern.test(line)).slice(0, 5);
}

export function shouldBlock(text) {
  const source = String(text || '');
  if (!source || escapePattern.test(source)) return false;
  if (!completionPattern.test(source) || !todoHeadingPattern.test(source)) return false;
  if (questionPattern.test(source.slice(-200))) return false;
  return remainingItems(source).length > 0;
}

export function pruneState(state, now = new Date()) {
  const result = {};
  const cutoff = new Date(now).getTime() - DAY_MS;
  if (!state || typeof state !== 'object' || Array.isArray(state)) return result;
  for (const [key, value] of Object.entries(state)) {
    const updated = Date.parse(value?.updatedAt || '');
    if (Number.isFinite(updated) && updated > cutoff) result[key] = value;
  }
  return result;
}

export function bumpState(state, sessionId, requestedBlock, now = new Date()) {
  const next = pruneState(state, now);
  if (!sessionId) return { state: next, blocked: Boolean(requestedBlock) };
  const consecutive = Number.isInteger(next[sessionId]?.consecutive) ? Math.max(0, next[sessionId].consecutive) : 0;
  const blocked = Boolean(requestedBlock) && consecutive < 3;
  next[sessionId] = { consecutive: blocked ? consecutive + 1 : 0, updatedAt: new Date(now).toISOString() };
  return { state: next, blocked };
}

export function latestAssistantText(transcript) {
  let lines;
  try { lines = fs.readFileSync(transcript, 'utf8').trimEnd().split(/\r?\n/).slice(-60); } catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type !== 'assistant') continue;
      const content = entry.message?.content;
      return Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : typeof content === 'string' ? content : '';
    } catch {}
  }
  return '';
}

function enabled() {
  if (process.env.ORGIAST_STOP_GATE === '1') return true;
  try { return fs.existsSync(path.join(home(), '.claude', 'stop-gate-enabled')); } catch { return false; }
}

function reasonFor(items) {
  return `[STOP-GATE] 完了報告と同時に、次の残作業が宣言されています:\n${items.join('\n')}\n\n止まらず次の項目に着手せよ。全部終わったら止まってよい。\n本当に残っていないなら応答に \`[TODO-NONE]\` を、意図して止まるなら理由付きで \`[STOP-OK]\` を含めれば通る。\n完了報告での停止は実測で最多(14日で573回)。§1.15の自律進行を機械で強制している`;
}

async function main() {
  if (!enabled()) return;
  try {
    let raw = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active) return;
    const text = input?.assistant_text || latestAssistantText(input?.transcript_path);
    if (!text) return;
    const sessionId = input?.session_id || input?.sessionId || input?.transcript_path || '';
    const statePath = path.join(home(), '.claude', 'stop-gate-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    const result = bumpState(state, sessionId, shouldBlock(text));
    if (sessionId) {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(result.state, null, 2) + '\n');
      } catch {}
    }
    if (result.blocked) console.log(JSON.stringify({ decision: 'block', reason: reasonFor(remainingItems(text)) }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
