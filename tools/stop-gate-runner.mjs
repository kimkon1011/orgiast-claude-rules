#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "stop-gate-runner", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "stop-gate-runner"}]};
// 2026-09-06: Stop 304回中198回が再Stop、handoff-quality 78件中71件が誤爆だった。
// 9プロセスの逐次差し戻しを1回の評価・1つのblockへまとめ、userの再読を最大1回にする。
import { evaluatePastLogSearch, listPlaybookNames, classifyHandoff } from './past-log-search-gate.mjs';
import { evaluateInvitePermissions } from './hooks/discord-invite-permission-gate.mjs';
import { applyNamedGatePolicy } from './gate-runtime.mjs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { runGate as evaluateQuality } from './handoff-quality-gate.mjs';
import { evaluateHandoffActionFromRaw } from './handoff-action-gate.mjs';
import { judge as judgeFullSteps } from './manual-request-fullsteps-gate.mjs';
import { check as checkBranchCoverage, formatReason as branchCoverageReason } from './handoff-branch-coverage-gate.mjs';
import { evaluateInvestigation, failureReason } from './handoff-investigation-gate.mjs';
import { evaluateHandoffRegret } from './handoff-regret-gate.mjs';
import { findHandoffWithoutInfo, formatViolationMessage as formatHandoffInfo } from './handoff-info-guard.mjs';
import { judge as judgeGhHandoff, formatReason as ghHandoffReason } from './gh-handoff-gate.mjs';
import { judge as judgeUrlAccount, formatReason as urlAccountReason } from './url-account-gate.mjs';
import { judge as judgeMessageLocator, formatReason as messageLocatorReason } from './message-locator-gate.mjs';
import { judge as judgeDecisionResearch, formatReason as decisionResearchReason } from './decision-research-gate.mjs';
import { configuredMode, evaluateNegativeClaimFromRaw } from './negative-claim-gate.mjs';
import { configuredMode as externalStateMode, evaluateExternalStateClaimFromRaw } from './external-state-claim-gate.mjs';
import { evaluateReportedSymptomFromRaw } from './reported-symptom-gate.mjs';
import { evaluateLaneAbandonment } from './lane-abandonment-gate.mjs';
import { evaluateCourseCorrections } from './course-correction-gate.mjs';
import { evaluateAudit } from './handoff-audit-gate.mjs';
import { enabled as reportLengthEnabled, judgeReportLengthWithLlm } from './report-length-gate.mjs';
import { hasRequiredFooter, judgeNextAction, reportsCloseSteps } from './next-action-gate.mjs';
import { judgeSubstituteCapability } from './substitute-capability-gate.mjs';
import { judgeUserBurden, desktopLauncherPattern } from './user-burden-gate.mjs';
import { findOutsourcedInvestigation, formatViolationMessage as formatSelfCheck, scanToolUsesFromRaw } from './self-check-before-asking-guard.mjs';
import { findLocalDocLinks, findBareLocalDocPaths, formatBarePathMessage, formatViolationMessage as formatDocLink } from './doc-link-drive-guard.mjs';
import { enabled as stopGateEnabled, progressQuestionReason, reasonFor, remainingItems, shouldBlock, shouldBlockProgressQuestion } from './stop-gate.mjs';
import { runControlGroup } from './control-group-stop-gate.mjs';
import { evaluatePrHandoff } from './pr-handoff-gate.mjs';
import { evaluateMergeHandoff } from './merge-handoff-gate.mjs';
import { currentTurnEntries, blocks } from './state-claim-evidence.mjs';
import { judgeSideEffectLeft } from './side-effect-left-gate.mjs';
import { judgeAnswerCanonical } from './answer-canonical-gate.mjs';
import { judge as judgeDeferralWait } from './deferral-wait-gate.mjs';
import { evaluateShallowAnswer } from './shallow-answer-gate.mjs';
import { judgeResponseLanguage } from './response-language-gate.mjs';
import { appendStopLedger, registerStopViolation, CAP_CONTEXT } from './lib/stop-recheck.mjs';


const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
export const FORM_GATES = ['handoff-quality-gate', 'manual-request-fullsteps-gate', 'handoff-info-guard', 'handoff-branch-coverage-gate', 'user-burden-gate', 'handoff-investigation-gate'];
const HANDOFF_HINT = "末尾に『次に kim がすること』『この後の自動進行』『このセッション: /session-close は終わっているので、このセッションを閉じてよい / /session-close は不要なので、このセッションを閉じてよい / /session-close をして（まだ閉じない・YYYY-MM-DD HH:MM まで待つ） / まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）』の定型文を3行で入れること(user が『この先はどうしたらいいの？』と聞き返した回数: 7日で9回)";

function fullStepsReason(missing) {
  return `[FULL-STEPS] 人に手作業を頼んでいますが、次が足りません: ${missing.join('・')}（§1.5.1 絶対ルール）`;
}

export async function evaluateGates(ctx, auditOptions = {}) {
  const gates = [
    ['response-language-gate', () => judgeResponseLanguage(ctx.assistantText, ctx.humanText)],
    ['past-log-search-gate', () => evaluatePastLogSearch({ text: ctx.assistantText, humanText: ctx.humanText, transcriptRaw: ctx.transcriptRaw, playbookNames: listPlaybookNames(home()) })],
    ['handoff-quality-gate', () => evaluateQuality({ ...ctx.input, assistant_text: ctx.assistantText, transcript_raw: ctx.transcriptRaw })],
    ['handoff-action-gate', () => evaluateHandoffActionFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw })],
    ['manual-request-fullsteps-gate', () => { if (desktopLauncherPattern.test(ctx.assistantText) && judgeUserBurden(ctx.assistantText, ctx.humanText).decision === 'pass') return { decision: 'pass' }; const result = judgeFullSteps(ctx.assistantText); return result.triggered && result.missing.length ? { decision: 'block', reason: fullStepsReason(result.missing), code: 'FULL-STEPS' } : { decision: 'pass' }; }],
    ['handoff-branch-coverage-gate', () => { const result = checkBranchCoverage(ctx.assistantText); return result.triggered && result.missing.length ? { decision: 'block', reason: branchCoverageReason(result.missing), code: 'BRANCH-COVERAGE' } : { decision: 'pass' }; }],
    ['handoff-investigation-gate', () => { const result = evaluateInvestigation(ctx.assistantText, { transcriptRaw: ctx.transcriptRaw }); return result.decision === 'block' ? { ...result, reason: failureReason(result.missing, result.reason), code: result.code || 'INVESTIGATION' } : result; }],
    ['shallow-answer-gate', () => evaluateShallowAnswer({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw })],
    ['handoff-regret-gate', () => evaluateHandoffRegret(ctx.transcriptRaw, ctx.assistantText)],
    ['handoff-info-guard', () => { const found = findHandoffWithoutInfo(ctx.assistantText); return found ? { decision: 'block', reason: formatHandoffInfo(found), code: 'HANDOFF-INFO' } : { decision: 'pass' }; }],
    ['gh-handoff-gate', () => { const result = judgeGhHandoff(ctx.assistantText); return result.triggered && result.missing.length ? { decision: 'block', reason: ghHandoffReason(), code: 'GH-HANDOFF' } : { decision: 'pass' }; }],
    ['url-account-gate', () => { const result = judgeUrlAccount(ctx.assistantText); return result.triggered && result.missing.length ? { decision: 'block', reason: urlAccountReason(result.missing), code: 'URL-ACCOUNT' } : { decision: 'pass' }; }],
    ['message-locator-gate', () => { const result = judgeMessageLocator(ctx.assistantText); return result.triggered ? { decision: 'block', reason: messageLocatorReason(result.missing, result.line), code: 'MSG-LOCATOR' } : { decision: 'pass' }; }],
    ['decision-research-gate', () => { const result = judgeDecisionResearch(ctx.assistantText); return result.triggered ? { decision: 'block', reason: decisionResearchReason(result.missing), code: 'RESEARCH-FIRST' } : { decision: 'pass' }; }],
    ['negative-claim-gate', () => { const result = evaluateNegativeClaimFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw }); return result.decision === 'block' && configuredMode() !== 'block' ? { ...result, decision: 'warn' } : result; }],
    ['external-state-claim-gate', () => { const result = evaluateExternalStateClaimFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw }); return result.decision === 'block' && externalStateMode() !== 'block' ? { ...result, decision: 'warn' } : result; }],
    ['control-group-gate', () => runControlGroup({ cwd: ctx.input?.cwd })],
    ['pr-handoff-gate', () => evaluatePrHandoff(ctx.assistantText)],
    ['merge-handoff-gate', () => evaluateMergeHandoff(ctx.assistantText, blocks(currentTurnEntries(ctx.transcriptRaw), 'tool_use'))],
    ['reported-symptom-gate', () => evaluateReportedSymptomFromRaw({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw })],
    ['lane-abandonment-gate', () => evaluateLaneAbandonment(ctx, { home: home(), ...auditOptions })],
    ['course-correction-gate', () => evaluateCourseCorrections(ctx, { home: home(), ...auditOptions })],
    // 第2段は全regexの結果確定後に評価する。
    ['handoff-audit-gate', () => evaluateAudit({ text: ctx.assistantText, transcriptRaw: ctx.transcriptRaw, sessionId: ctx.sessionId, regexBlocked: results.length > 0 }, { home: home(), ...auditOptions })],
    ['self-check-before-asking-guard', () => { const found = findOutsourcedInvestigation(ctx.assistantText, scanToolUsesFromRaw(ctx.transcriptRaw)); return found ? { decision: 'block', reason: formatSelfCheck(found), code: 'SELF-CHECK' } : { decision: 'pass' }; }],
    ['stop-gate', () => { if (!stopGateEnabled()) return { decision: 'pass' }; const todo = shouldBlock(ctx.assistantText); const question = !todo && shouldBlockProgressQuestion(ctx.assistantText); return todo ? { decision: 'block', reason: reasonFor(remainingItems(ctx.assistantText)), code: 'remaining-todo' } : question ? { decision: 'block', reason: progressQuestionReason(), code: 'progress-question' } : { decision: 'pass' }; }],
    ['report-length-gate', () => reportLengthEnabled() ? judgeReportLengthWithLlm(ctx.assistantText, ctx.humanText) : { decision: 'pass' }],
    ['side-effect-left-gate', () => judgeSideEffectLeft(ctx.assistantText, blocks(currentTurnEntries(ctx.transcriptRaw), 'tool_use'))],
    ['answer-canonical-gate', () => judgeAnswerCanonical(ctx.assistantText)],
    ['deferral-wait-gate', () => judgeDeferralWait(ctx.assistantText)],
    ['next-action-gate', () => judgeNextAction(ctx.assistantText, ctx.transcriptRaw, ctx.input)],
    ['user-burden-gate', () => judgeUserBurden(ctx.assistantText, ctx.humanText)],
    ['substitute-capability-gate', () => judgeSubstituteCapability(ctx.assistantText)],
    ['doc-link-drive-guard', () => { const hits = findLocalDocLinks(ctx.assistantText); if (hits.length) return { decision: 'block', reason: formatDocLink(hits), code: 'DOC-LINK' }; const bare = findBareLocalDocPaths(ctx.assistantText); return bare.length ? { decision: 'block', reason: formatBarePathMessage(bare), code: 'DOC-LINK' } : { decision: 'pass' }; }],
  ];
  const results = [];
  const errors = [];
  for (const [name, evaluate] of gates) {
    if (name === 'handoff-audit-gate') continue;
    try { const result = await evaluate(); if (['block', 'warn'].includes(result?.decision)) results.push({ name, ...result }); }
    catch { errors.push(`error:${name}`); }
  }
  const audit = await gates.find(([name]) => name === 'handoff-audit-gate')[1]();
  if (['block', 'warn'].includes(audit.decision)) results.push({ name: 'handoff-audit-gate', ...audit });
  results.sort((a, b) => gates.findIndex(([name]) => name === a.name) - gates.findIndex(([name]) => name === b.name));
  return { results, errors, audit, retry: async name => ({ name, ...await gates.find(([gate]) => gate === name)[1]() }) };
}

function ledger(record) {
  appendStopLedger(record, home());
}

export async function run(input, context, auditOptions = {}) {
  const sessionId = input?.session_id || input?.sessionId || path.basename(input?.transcript_path || '', '.jsonl');
  const assistantText = input?.last_assistant_message ?? input?.assistant_text ?? context.assistantText;
  // Deterministic permission guard: enforce before retry/close bypasses and rollout demotion.
  const invite = evaluateInvitePermissions(assistantText);
  if (invite.decision === 'block') return invite;
  const base = { sessionId, blockedBy: [], reasonCodes: [], excerpt: String(assistantText || '').slice(0, 200) };
  if (!assistantText) { const record = { ...base, verdict: 'skipped', reasonCodes: [context.reason || 'no-assistant-text'] }; ledger(record); return { record }; }
  // session-close SKILL.md §7.1 の閉じ際3行は、それ自体が user への次の一手の指示なので手渡し系ゲートを適用しない。
  // 適用すると「ルール通りに閉じる」だけで FULL-STEPS／INVESTIGATION／USER-BURDEN が発火して余分な1ターンを強制し、
  // タブが開いている限りプロセスが会話ログを書き戻して退避済みセッションが一覧に復活する
  // （[[feedback-close-session-then-keep-talking-recreates-jsonl]]）。
  if (reportsCloseSteps(assistantText)) {
    const record = { ...base, verdict: 'pass', reasonCodes: ['close-steps'], auditEvidence: 'close-steps' };
    ledger(record);
    return { record };
  }
  const evaluated = await evaluateGates({ input, assistantText, humanText: context.humanText, transcriptRaw: context.raw, sessionId }, auditOptions);
  const audit = evaluated.audit;
  const warnings = [];
  const effective = [];
  const policyResults = await Promise.all(evaluated.results.map(result => applyNamedGatePolicy(result.name, result, { home: home(), retry: () => evaluated.retry(result.name), ...auditOptions.policyOptions })));
  for (const value of policyResults) {
    if (value.decision === 'block') effective.push(value);
    else if (value.decision === 'warn') warnings.push(`${value.name}: ${value.reason}`);
  }
  const handoffKind = classifyHandoff(assistantText);
  const demoted = handoffKind === 'manual-steps' ? [] : effective.filter(({ name }) => FORM_GATES.includes(name)).map(({ name }) => name);
  evaluated.results = effective.filter(({ name }) => !demoted.includes(name));
  // 先行 gate が発火して第2段を飛ばしたのに、policy/demote で全て無効化された場合は、監査を素通りさせず第2段を改めて評価する。
  if (audit.record.skipped === 'regex-blocked' && !evaluated.results.length) {
    const second = await evaluateAudit({ text: assistantText, transcriptRaw: context.raw, sessionId, regexBlocked: false }, { home: home(), ...auditOptions });
    if (second.decision === 'block') evaluated.results.push({ name: 'handoff-audit-gate', ...second });
  }
  const systemMessage = warnings.length ? warnings.join('\n') : undefined;
  const blockedBy = evaluated.results.map(({ name }) => name);
  const reasonCodes = [...evaluated.results.map(({ code, name }) => code || name), ...evaluated.errors];
  const cap = blockedBy.length ? registerStopViolation({ input, assistantText, blockedBy, reasonCodes, home: home() }) : { retryCap: false, sameTextRetries: 0 };
  // Keep the caller-facing verdict compatible; the ledger records the new
  // operational outcome separately so nightly metrics can count it.
  const verdict = cap.retryCap ? 'retry-cap' : blockedBy.length ? 'block' : 'pass';
  const capMessage = cap.retryCap ? `${CAP_CONTEXT} 残存コード: ${reasonCodes.join(', ')}` : undefined;
  const record = { ...base, verdict, blockedBy, reasonCodes, demoted, handoffKind, retryCap: cap.retryCap, sameTextRetries: cap.sameTextRetries ?? 0, auditEvidence: audit.record.evidence };
  ledger(cap.retryCap ? { ...record, verdict: 'pass_after_cap', runnerVerdict: verdict } : record);
  if (verdict !== 'block') return { record, ...((capMessage || systemMessage) ? { systemMessage: [capMessage, systemMessage].filter(Boolean).join('\n') } : {}) };
  const sections = [];
  let formAdded = false;
  for (const { name, reason } of evaluated.results) {
    if (!FORM_GATES.includes(name)) { sections.push(`### ${name}\n- ${reason}`); continue; }
    if (formAdded) continue;
    formAdded = true;
    const summaries = evaluated.results.filter(r => FORM_GATES.includes(r.name)).map(r => `- ${r.name}: ${String(r.reason || '').split(/\r?\n/).slice(0, 2).map(line => line.slice(0, 200)).join(' ')}`);
    sections.push(`### 手渡しの形式（1回の書き直しでまとめて直す）\n${summaries.join('\n')}`);
  }
  if (!blockedBy.includes('next-action-gate') && !hasRequiredFooter(assistantText)) sections.push(`### ピギーバック・ヒント\n- ${HANDOFF_HINT}`);
  return { decision: 'block', reason: sections.join('\n\n'), record, ...(systemMessage ? { systemMessage } : {}) };
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    let input; try { input = JSON.parse(raw); } catch { ledger({ sessionId: '', verdict: 'skipped', blockedBy: [], reasonCodes: ['invalid-json'], excerpt: raw.slice(0, 200) }); return; }
    const context = readTranscriptContext(input?.transcript_path);
    const result = await run(input, context);
    if (result.decision === 'block') process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason, ...(result.systemMessage ? { systemMessage: result.systemMessage } : {}) }) + '\n');
    else if (result.systemMessage) process.stdout.write(JSON.stringify({ systemMessage: result.systemMessage }) + '\n');
  } catch { /* 1本の例外で Claude の応答を止めないため、ランナー全体も fail-open。 */ }
}

if (isEntry(import.meta.url)) await main();
