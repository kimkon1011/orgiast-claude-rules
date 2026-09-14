#!/usr/bin/env node
// 2026-09-06: Stop 304回中198回が再Stop、handoff-quality 78件中71件が誤爆だった。
// 9プロセスの逐次差し戻しを1回の評価・1つのblockへまとめ、userの再読を最大1回にする。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { runGate as evaluateQuality } from './handoff-quality-gate.mjs';
import { judge as judgeFullSteps } from './manual-request-fullsteps-gate.mjs';
import { evaluateInvestigation, failureReason } from './handoff-investigation-gate.mjs';
import { findHandoffWithoutInfo, formatViolationMessage as formatHandoffInfo } from './handoff-info-guard.mjs';
import { configuredMode, evaluateNegativeClaimFromRaw } from './negative-claim-gate.mjs';
import { configuredMode as externalStateMode, evaluateExternalStateClaimFromRaw } from './external-state-claim-gate.mjs';
import { evaluateAudit } from './handoff-audit-gate.mjs';
import { enabled as reportLengthEnabled, judgeReportLength } from './report-length-gate.mjs';
import { findOutsourcedInvestigation, formatViolationMessage as formatSelfCheck, scanToolUsesFromRaw } from './self-check-before-asking-guard.mjs';
import { findLocalDocLinks, formatViolationMessage as formatDocLink } from './doc-link-drive-guard.mjs';
import { enabled as stopGateEnabled, progressQuestionReason, reasonFor, remainingItems, shouldBlock, shouldBlockProgressQuestion } from './stop-gate.mjs';


const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
const HANDOFF_HINT = "末尾に『次に kim がすること: なし / <1件>』を1行入れること(user が『この先はどうしたらいいの？』と聞き返した回数: 7日で9回)";
const NEXT_ACTION = /(?:^|\n)次に kim がすること:\s*(?:なし|\S.*)\s*$/;

function fullStepsReason(missing) {
  return `[FULL-STEPS] 人に手作業を頼んでいますが、次が足りません: ${missing.join('・')}（§1.5.1 絶対ルール）`;
}

export async function evaluateGates(ctx, auditOptions = {}) {
  const gates = [
    ['handoff-quality-gate', () => evaluateQuality({ ...ctx.input, assistant_text: ctx.assistantText })],
    ['manual-request-fullsteps-gate', () => { const result = judgeFullSteps(ctx.assistantText); return result.triggered && result.missing.length ? { decision: 'block', reason: fullStepsReason(result.missing), code: 'FULL-STEPS' } : { decision: 'pass' }; }],
    ['handoff-investigation-gate', () => { const result = evaluateInvestigation(ctx.assistantText); return result.decision === 'block' ? { ...result, reason: failureReason(result.missing), code: 'INVESTIGATION' } : result; }],
    ['handoff-info-guard', () => { const found = findHandoffWithoutInfo(ctx.assistantText); return found ? { decision: 'block', reason: formatHandoffInfo(found), code: 'HANDOFF-INFO' } : { decision: 'pass' }; }],
    ['negative-claim-gate', () => { const result = evaluateNegativeClaimFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw }); return result.decision === 'block' && configuredMode() !== 'block' ? { ...result, decision: 'pass' } : result; }],
    ['external-state-claim-gate', () => { const result = evaluateExternalStateClaimFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw }); return result.decision === 'block' && externalStateMode() !== 'block' ? { ...result, decision: 'pass' } : result; }],
    // 第2段は全regexの結果確定後に評価する。
    ['handoff-audit-gate', () => evaluateAudit({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw, sessionId: ctx.sessionId, regexBlocked: results.length > 0 }, { home: home(), ...auditOptions })],
    ['self-check-before-asking-guard', () => { const found = findOutsourcedInvestigation(ctx.assistantText, scanToolUsesFromRaw(ctx.transcriptRaw)); return found ? { decision: 'block', reason: formatSelfCheck(found), code: 'SELF-CHECK' } : { decision: 'pass' }; }],
    ['stop-gate', () => { if (!stopGateEnabled()) return { decision: 'pass' }; const todo = shouldBlock(ctx.assistantText); const question = !todo && shouldBlockProgressQuestion(ctx.assistantText); return todo ? { decision: 'block', reason: reasonFor(remainingItems(ctx.assistantText)), code: 'remaining-todo' } : question ? { decision: 'block', reason: progressQuestionReason(), code: 'progress-question' } : { decision: 'pass' }; }],
    ['report-length-gate', () => reportLengthEnabled() ? judgeReportLength(ctx.assistantText, ctx.humanText) : { decision: 'pass' }],
    ['doc-link-drive-guard', () => { const hits = findLocalDocLinks(ctx.assistantText); return hits.length ? { decision: 'block', reason: formatDocLink(hits), code: 'DOC-LINK' } : { decision: 'pass' }; }],
  ];
  const results = [];
  const errors = [];
  for (const [name, evaluate] of gates) {
    if (name === 'handoff-audit-gate') continue;
    try { const result = evaluate(); if (result?.decision === 'block') results.push({ name, ...result }); }
    catch { errors.push(`error:${name}`); }
  }
  const audit = await gates.find(([name]) => name === 'handoff-audit-gate')[1]();
  if (audit.decision === 'block') results.push({ name: 'handoff-audit-gate', ...audit });
  results.sort((a, b) => gates.findIndex(([name]) => name === a.name) - gates.findIndex(([name]) => name === b.name));
  return { results, errors, audit };
}

function stateResult(sessionId, requestedBlock) {
  const stateFile = path.join(home(), '.claude', 'stop-gate-runner-state.json');
  let state = {}; try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const blocks = Math.max(0, Number(state?.[sessionId]?.blocks) || 0);
  if (!requestedBlock || !sessionId) return { retryCap: false };
  if (blocks >= 2) return { retryCap: true };
  state[sessionId] = { blocks: blocks + 1, lastTs: new Date().toISOString() };
  try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n'); } catch {}
  return { retryCap: false };
}

function ledger(record) {
  try {
    const file = path.join(home(), '.claude', 'stop-gate-runner-ledger.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch {}
}

export async function run(input, context, auditOptions = {}) {
  const sessionId = input?.session_id || input?.sessionId || path.basename(input?.transcript_path || '', '.jsonl');
  const assistantText = input?.assistant_text || context.assistantText;
  const base = { sessionId, blockedBy: [], reasonCodes: [], excerpt: String(assistantText || '').slice(0, 200) };
  if (input?.stop_hook_active) { const record = { ...base, verdict: 'skipped', reasonCodes: ['stop_hook_active'] }; ledger(record); return { record }; }
  if (!assistantText) { const record = { ...base, verdict: 'skipped', reasonCodes: [context.reason || 'no-assistant-text'] }; ledger(record); return { record }; }
  const evaluated = await evaluateGates({ input, assistantText, humanText: context.humanText, transcriptRaw: context.raw, sessionId }, auditOptions);
  const audit = evaluated.audit;
  const blockedBy = evaluated.results.map(({ name }) => name);
  const reasonCodes = [...evaluated.results.map(({ code, name }) => code || name), ...evaluated.errors];
  const cap = stateResult(sessionId, blockedBy.length > 0);
  const verdict = cap.retryCap ? 'retry-cap' : blockedBy.length ? 'block' : 'pass';
  const record = { ...base, verdict, blockedBy, reasonCodes, retryCap: cap.retryCap, auditEvidence: audit.record.evidence }; ledger(record);
  if (verdict !== 'block') return { record };
  const sections = evaluated.results.map(({ name, reason }) => `### ${name}\n- ${reason}`);
  if (!NEXT_ACTION.test(assistantText)) sections.push(`### ピギーバック・ヒント\n- ${HANDOFF_HINT}`);
  return { decision: 'block', reason: sections.join('\n\n'), record };
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    let input; try { input = JSON.parse(raw); } catch { ledger({ sessionId: '', verdict: 'skipped', blockedBy: [], reasonCodes: ['invalid-json'], excerpt: raw.slice(0, 200) }); return; }
    const context = readTranscriptContext(input?.transcript_path);
    const result = await run(input, context);
    if (result.decision === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason }) + '\n');
  } catch { /* 1本の例外で Claude の応答を止めないため、ランナー全体も fail-open。 */ }
}

if (isEntry(import.meta.url)) await main();
