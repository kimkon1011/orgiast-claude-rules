#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readAssistantText, readLastHumanText } from './lib/assistant-text.mjs';

export const REPORT_LINE_LIMIT = 12;
export const COMPLETION_REPORT_PATTERN = /(完了|反映済|反映しました|push\s*済|deploy\s*完了|✅|できました|直しました|修正しました|実装しました)/;
/** 実測で疑問文末を見逃した3件（うち1件は誤爆確定）を説明要求として扱う。 */
export const EXPLANATION_REQUEST_PATTERN = /(調べ|教えて|おしえて|まとめて|検証して|なぜ|なんで|どう|説明|比較|どれ|どちら|分析|レビュー|確認して|\?|？|(?:かな|かしら|でしょうか|だろうか|ですか|ますか)(?=[。．.!！\r\n]|\s*$))/;
/**
 * user が成果物そのもの（文章・表・調査結果・変換物）を頼んだ turn。
 * その報告は「頼まれていない完了報告」ではないので長さを咎めない。
 * 実測 2026-09-18: 台帳の block を1件ずつ読んだところ、誤爆20件のうち9件がこの型だった。
 */
export const DELIVERABLE_REQUEST_PATTERN = /(作って|つくって|書いて|探して|さがして|出して|リストアップ|一覧に|表にして|表を作|突合|調査して|読んで|変換|PDFに|資料に)/;
/**
 * 人に手作業を頼む本文。§1.5.1（非エンジニア向けフル手順）と
 * manual-request-fullsteps-gate が完全な手順を要求するため、
 * ここで短くさせるとルール同士が正面衝突する。実測: 誤爆20件のうち7件がこの型。
 */
export const HANDOFF_STEPS_PATTERN = /(クリック|タップ|押し|貼り付け|入力し|開いて|選んで|コピー|ログイン)/;
const HANDOFF_DECLARATION = /\[手渡し判定\]/;
const NO_HANDOFF_DECLARATION = /\[手渡し判定\][^\n]*手渡しなし/;

/** 番号付きの操作手順が3つ以上あるか（本文のどこかに「クリック」の語があるだけでは足りない）。 */
export function isHandoffProcedure(text) {
  const source = String(text || '');
  if (NO_HANDOFF_DECLARATION.test(source)) return false;
  const steps = source.split(/\r?\n/).filter((line) => /^\s*\d+[.)]\s+\S/.test(line) && HANDOFF_STEPS_PATTERN.test(line));
  if (steps.length < 3) return false;
  return HANDOFF_DECLARATION.test(source) ? !NO_HANDOFF_DECLARATION.test(source) : true;
}
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
  // 逃げ道の案内は「`[REPORT-OK]` と理由を書けば通る」なので、実際には `[REPORT-OK: 理由]` と書かれる。
  // 2026-09-08 の実データではその形式が素通しされず block された（案内と実装が食い違っていた）。
  if (/\[REPORT-OK\b/.test(source)) return { decision: 'pass', reason: 'report-ok', lines, chars };
  if (!COMPLETION_REPORT_PATTERN.test(source)) return { decision: 'pass', reason: 'not-completion-report', lines, chars };
  if (isHandoffProcedure(source)) return { decision: 'pass', reason: 'handoff-procedure', lines, chars };
  if (!human.trim()) return { decision: 'pass', reason: 'no-human-text', lines, chars };
  if (EXPLANATION_REQUEST_PATTERN.test(human)) return { decision: 'pass', reason: 'explanation-requested', lines, chars };
  if (DELIVERABLE_REQUEST_PATTERN.test(human)) return { decision: 'pass', reason: 'deliverable-requested', lines, chars };
  if (lines <= REPORT_LINE_LIMIT) return { decision: 'pass', reason: 'within-line-limit', lines, chars };
  return {
    decision: 'block',
    reason: `頼まれていない完了報告が ${lines} 行（${chars} 文字）ある。CLAUDE.md の既定は 1〜3 行。\nチャットには結論を 3 行以内で書け。詳細が必要ならファイルに書き、リンクを1本だけ貼れ: kim が読む文書は Drive の Doc URL（docs.google.com/a/orgiast.jp/document/d/{ID}/edit）、開発資料（コード・設定）は相対パス。ローカルの .md/.pdf 等を kim 読み文書として直リンクすると doc-link-drive-guard で再度 block される（2026-09-10 実測: 片方の助言に従ったらもう片方に差し戻された）。\n実測: user の読字量531,000字のうち34%がこの型の報告から出ている（132/1831 turn）。\nuser が実際に詳細を求めている場合や、どうしても本文に必要な場合は応答に \`[REPORT-OK]\` と理由を書けば通る。`,
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

export function enabled() {
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
