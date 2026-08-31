#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODEL_LIMIT = new Set(['claude-opus-4-7', 'claude-fable-5']);
const COOLDOWN_MS = 30 * 60 * 1000;

async function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  if (!raw) return;

  let input;
  try { input = JSON.parse(raw); } catch { return; }
  const transcript = input?.transcript_path;
  if (typeof transcript !== 'string' || !transcript) return;

  const home = process.env.ORGIAST_HOME || os.homedir();
  const sessionId = safeName(String(input.session_id || path.basename(transcript).replace(/\.[^.]+$/, '') || 'unknown'));
  const stateFile = path.join(home, '.claude', 'session-guard', `${sessionId}.json`);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};

  let size;
  try { size = fs.statSync(transcript).size; } catch { return; }
  const saved = state.aggregate && typeof state.aggregate === 'object' ? state.aggregate : {};
  let offset = nonNegativeInteger(saved.offset, 0);
  let turns = nonNegativeNumber(saved.turns, 0);
  let cacheRead = nonNegativeNumber(saved.cacheRead, 0);
  let lastModel = typeof saved.lastModel === 'string' ? saved.lastModel : '';
  if (size < offset) {
    offset = 0;
    turns = 0;
    cacheRead = 0;
    lastModel = '';
  }

  let stream;
  try { stream = fs.createReadStream(transcript, { start: offset }); } catch { return; }
  let pending = Buffer.alloc(0);
  let completeBytes = 0;
  try {
    for await (const chunk of stream) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let newline;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const lineBuffer = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        completeBytes += newline + 1;
        if (!lineBuffer.length) continue;
        const line = lineBuffer[lineBuffer.length - 1] === 0x0d
          ? lineBuffer.subarray(0, -1).toString('utf8')
          : lineBuffer.toString('utf8');
        let record;
        try { record = JSON.parse(line); } catch { continue; }
        if (record?.type !== 'assistant' && record?.message?.role !== 'assistant') continue;
        turns += 1;
        const message = record.message || record;
        if (typeof message.model === 'string') lastModel = message.model;
        const value = Number(message.usage?.cache_read_input_tokens ?? record.usage?.cache_read_input_tokens ?? 0);
        if (Number.isFinite(value) && value > 0) cacheRead += value;
      }
    }
  } catch { stream.destroy(); return; }
  offset += completeBytes;
  state.aggregate = { offset, turns, cacheRead, lastModel };

  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch { return; }

  const tokLimit = positiveNumber(process.env.ORGIAST_SESSION_TOK_LIMIT, 300_000_000);
  const turnLimit = positiveNumber(process.env.ORGIAST_SESSION_TURN_LIMIT, 400);
  const candidates = [];
  if (MODEL_LIMIT.has(lastModel)) candidates.push(['model', `このセッションは ${lastModel} で動作中。単価が opus-5 の3倍。応答の冒頭で user に \`/model opus\` への切替を1行で促し、切替まで重い作業に着手しないこと。`]);
  if (cacheRead >= tokLimit || turns >= turnLimit) candidates.push(['size', `このセッションは肥大化しています（累積キャッシュ読取 ${cacheRead} tok / assistant ${turns}ターン）。1ターンごとに全履歴を読み直すため費用はターン数の二乗近くで増えます。着手前に \`/session-close\` → 新セッションを1行提案すること。`]);
  if (!candidates.length) return;

  const now = Date.now();
  const emitted = candidates.filter(([kind]) => !Number.isFinite(Date.parse(state[kind])) || now - Date.parse(state[kind]) >= COOLDOWN_MS);
  if (!emitted.length) return;
  for (const [kind] of emitted) state[kind] = new Date(now).toISOString();
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch { return; }
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: emitted.map(([, text]) => text).join('\n') } }));
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
function nonNegativeNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}
function nonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
function safeName(value) { return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180); }

try { await main(); } catch {}
process.exitCode = 0;
