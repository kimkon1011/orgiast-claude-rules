#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readAssistantText, readLastHumanText } from './lib/assistant-text.mjs';

export const REPORT_LINE_LIMIT = 12;
export const COMPLETION_REPORT_PATTERN = /(完了|反映済|反映しました|push\s*済|deploy\s*完了|✅|できました|直しました|修正しました|実装しました)/;
export const EXPLANATION_REQUEST_PATTERN = /(調べ|教えて|まとめて|検証して|なぜ|どう|説明|比較|どれ|どちら|分析|レビュー|確認して|\?|？)/;
const DAY_MS = 24 * 60 * 60 * 1000;
const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();

function dimensions(text) {
  const source = String(text || '');
  return { lines: source ? source.split(/\r?\n/).length : 0, chars: source.length };
}

export function judgeReportLength(assistantText, lastHumanText) {
  const source = String(assistantText || '');
  const human = String(lastHumanText || '');
  const { lines, chars } = dimensions(source);
  if (!source.trim()) return { decision: 'pass', reason: 'empty-assistant-text', lines, chars };
  if (source.includes('[REPORT-OK]')) return { decision: 'pass', reason: 'report-ok', lines, chars };
  if (!COMPLETION_REPORT_PATTERN.test(source)) return { decision: 'pass', reason: 'not-completion-report', lines, chars };
  if (!human.trim()) return { decision: 'pass', reason: 'no-human-text', lines, chars };
  if (EXPLANATION_REQUEST_PATTERN.test(human)) return { decision: 'pass', reason: 'explanation-requested', lines, chars };
  if (lines <= REPORT_LINE_LIMIT) return { decision: 'pass', reason: 'within-line-limit', lines, chars };
  return {
    decision: 'block',
    reason: `頼まれていない完了報告が ${lines} 行（${chars} 文字）ある。CLAUDE.md の既定は 1〜3 行。\nチャットには結論を 3 行以内で書け。詳細が必要ならファイルに書いてクリック可能な相対リンクを1本貼れ（本文に貼り付けるな）。\n実測: user の読字量531,000字のうち34%がこの型の報告から出ている（132/1831 turn）。\nuser が実際に詳細を求めている場合や、どうしても本文に必要な場合は応答に \`[REPORT-OK]\` と理由を書けば通る。`,
    lines,
    chars,
  };
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
  const blocked = Boolean(requestedBlock) && consecutive < 2;
  next[sessionId] = {
    consecutive: requestedBlock ? consecutive + 1 : 0,
    updatedAt: new Date(now).toISOString(),
  };
  return { state: next, blocked };
}

function enabled() {
  if (process.env.ORGIAST_REPORT_LEN_GATE === '1') return true;
  try { return fs.existsSync(path.join(home(), '.claude', 'report-length-gate-enabled')); } catch { return false; }
}

function appendLedger(record) {
  const ledger = path.join(home(), '.claude', 'report-length-ledger.jsonl');
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (error) {
    console.error(`[report-length-gate] ledger書き込み失敗: ${error instanceof Error ? error.message : String(error)} path=${ledger}`);
  }
}

function skipped(input, reasonCode, reason, excerpt = '') {
  appendLedger({
    sessionId: input?.session_id || input?.sessionId || path.basename(input?.transcript_path || '', '.jsonl'),
    verdict: 'skipped', lines: 0, chars: 0, reasonCode, reason, excerpt: String(excerpt).slice(0, 200),
  });
}

async function main() {
  if (!enabled()) return;
  let raw = '';
  try {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) raw += chunk;
    let input;
    try { input = JSON.parse(raw); } catch (error) {
      const reason = `入力をJSONとして解釈できません: ${error instanceof Error ? error.message : String(error)}`;
      console.error(`[report-length-gate] ${reason}`);
      skipped({}, 'invalid-json', reason, raw);
      return;
    }
    if (input?.stop_hook_active) return;
    const assistant = input?.assistant_text
      ? { text: input.assistant_text, reason: 'ok' }
      : readAssistantText(input?.transcript_path);
    if (!assistant.text) {
      skipped(input, assistant.reason, 'assistant 本文を抽出できませんでした');
      return;
    }
    const human = readLastHumanText(input?.transcript_path);
    const result = judgeReportLength(assistant.text, human.text);
    const sessionId = input?.session_id || input?.sessionId || path.basename(input?.transcript_path || '', '.jsonl');
    const statePath = path.join(home(), '.claude', 'report-length-gate-state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    const stateResult = bumpState(state, sessionId, result.decision === 'block');
    if (sessionId) {
      try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(stateResult.state, null, 2) + '\n');
      } catch (error) {
        console.error(`[report-length-gate] 状態保存失敗: ${error instanceof Error ? error.message : String(error)} path=${statePath}`);
      }
    }
    const effectiveBlock = result.decision === 'block' && stateResult.blocked;
    const reasonCode = result.decision === 'block'
      ? stateResult.blocked ? 'over-line-limit' : 'block-limit-reached'
      : result.reason;
    appendLedger({ sessionId, verdict: effectiveBlock ? 'blocked' : 'passed', lines: result.lines, chars: result.chars, reasonCode, reason: result.reason, excerpt: assistant.text.slice(0, 200) });
    if (effectiveBlock) process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }) + '\n');
  } catch (error) {
    console.error(`[report-length-gate] 例外を握って通過します: ${error instanceof Error ? error.message : String(error)}`);
    skipped({}, 'unexpected-error', error instanceof Error ? error.message : String(error), raw);
  }
}

if (isEntry(import.meta.url)) await main();
