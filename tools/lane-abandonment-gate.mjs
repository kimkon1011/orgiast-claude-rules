#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "lane-abandonment-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "lane-abandonment-gate"}, {"kind": "command", "ref": "node tools/lane-doctor.mjs --probe"}, {"kind": "keyserve-key", "ref": "deepseek.env#DEEPSEEK_API_KEY"}]};
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { turnEntries, redact } from './handoff-audit-gate.mjs';
import { inspectTranscript, inspectTranscriptRaw } from './fable-session-guard.mjs';
import { laneHome, readJson } from './lane-doctor.mjs';
import { classifyBashCommand } from './usage-stats.mjs';
import { delegated } from './pretooluse-lane-guard.mjs';
import { redactAll } from './lib/redact.mjs';

// 2026-10-20T00:37:39Z / bdbf73fd（handoff-audit:e524c1f72f058577）: Codex の完了を待つ
// 「見張り」が期限切れになり、そのまま Claude 本体で実装を続ける型。待機の期限切れは
// レーンの失敗シグナルではないため従来の評価では素通りするが、本体へ戻る理由にもならない
// （§1.18 / rule 13）。期限切れの通知そのもの（「Codex は既に終わっていたので何もしない」）は
// 再発ではないので、「レーンの待機が期限切れ」と「本体で実装・続行」が近接するときだけ拾う。
const LANE_WAIT = /(?:Codex|codex-do|他AI|レーン|サブエージェント)[^\n。]{0,40}(?:待機|待ち|見張り|監視)|(?:待機|待ち|見張り|監視)[^\n。]{0,40}(?:Codex|codex-do|他AI|レーン|サブエージェント)/i;
const WAIT_EXPIRED = /期限切れ|期限が?切れ|タイムアウト|満了|expired/gi;
const BODY_CONTINUE = /(?:Claude\s*本体|本体で|自分で|こちらで)[^\n。]{0,40}(?:実装|修正|改修|作成|対応|進め|続行|作業)|(?:実装|修正|改修|作成)[^\n。]{0,20}(?:本体で|自分で|こちらで)(?:進め|続行|対応)/;
const WAIT_WINDOW = 140;
const LANE_EXEMPT = /\[LANE-(?:FALLBACK|REPAIR)\]/;

/** レーンの待機期限切れを理由に本体で実装を続ける文か。一致部分を返す（無ければ空文字）。 */
export function expiredWaitBody(text) {
  const prose = String(text || '');
  for (const expired of prose.matchAll(WAIT_EXPIRED)) {
    const around = prose.slice(
      Math.max(0, expired.index - WAIT_WINDOW),
      expired.index + expired[0].length + WAIT_WINDOW,
    );
    if (LANE_WAIT.test(around) && BODY_CONTINUE.test(around)) return around.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return '';
}

export const safeText = value => redactAll(redact(value));
export function turnEvents(raw) {
  return turnEntries(raw).flatMap(row => (Array.isArray(row.message?.content) ? row.message.content : []).map(block => ({ ...block, role: row.message?.role || row.type })));
}
export function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(resultText).join('\n');
  return content?.text || (content?.content ? resultText(content.content) : '');
}
export function failureSignal(text, command = '') {
  for (const line of String(text).split(/\r?\n/)) {
    // Test descriptions quote failure messages; they are not provider output.
    const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trimStart();
    if (/^(?:[✔✖ℹ]\s|(?:not )?ok\s+\d+\s+-\s|# Subtest:)/.test(plain)) continue;
    if (/全候補が失敗|demote中|usage limit|credits are depleted|RESOURCE_EXHAUSTED|PreToolUse:Bash hook error: このターンで Fable\/Opus 本体が直接/i.test(line)
      || /WSL ディストリが見つかりません|spawn \S+ ENOENT/.test(line)
      || ((delegated.test(command) || /(?:^|[\s/\\])(?:codex-do|cheap-code|llm-ask|gemini|qwen)(?:\.mjs)?(?=[\s"']|$)/i.test(command)) && /is not recognized as an internal or external command|command not found/i.test(line))
      || /HTTP\s*4(?:02|29)\b(?!\s*:)/i.test(line)
      || (/codex-do(?:\.mjs)?/i.test(command) && /\bexit code\s*[:=]?\s*[1-9]\d*\b/i.test(line))) return safeText(line).slice(0, 180);
  }
  return '';
}
export function repairReported(text) {
  return String(text || '').split(/\r?\n/).some(line => /^\[LANE-REPAIR\][ \t]+[^:\r\n]+:[ \t]*(?:修復済み[ \t]+\S[^\r\n]*|修復不可[ \t]+試行:[ \t]*\S[^\r\n]*)$/.test(line.trim()));
}
export function exemptions(ctx, events, failureIndex = -1, { requireRepair = false } = {}) {
  const users = turnEntries(ctx.transcriptRaw || '').filter(r => r.type === 'human' || r.message?.role === 'user');
  const userText = users.flatMap(r => typeof r.message?.content === 'string' ? [r.message.content] : (r.message?.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
  if (userText.includes('[LANE-OK]')) return 'lane-ok';
  // 汎用 course-correction の免除判定は互換性を維持し、この gate は修理必須で呼ぶ。
  if ((!requireRepair || repairReported(ctx.assistantText)) && /\[LANE-FALLBACK\][ \t]*\S[^\r\n]*/.test(ctx.assistantText || '')) return 'fallback';
  if (events.slice(failureIndex + 1).some(e => e.type === 'tool_use' && /^(?:Bash|PowerShell)$/.test(e.name) && /(?:^|[\s/\\"'])lane-doctor\.mjs(?:\s|["']|$)/.test(e.input?.command || e.input?.script || ''))) return 'doctor';
  return '';
}
export function currentModel(ctx) {
  try { if (ctx.input?.transcript_path) return inspectTranscript(ctx.input.transcript_path).currentModel; } catch {}
  return inspectTranscriptRaw(ctx.transcriptRaw || '').currentModel;
}
export function appendCorrection(home, row) {
  const file = path.join(home, '.claude', 'course-corrections-ledger.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...row, excerpt: safeText(row.excerpt || '').slice(0, 500), signals: (row.signals || []).map(safeText) }) + '\n');
}
export function evaluateLaneAbandonment(ctx, { home = laneHome() } = {}) {
  const events = turnEvents(ctx.transcriptRaw || ''), uses = new Map(), signals = [];
  let failedAt = -1, abandoned = false, shellCalls = 0;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'tool_result') {
      const use = uses.get(event.tool_use_id);
      if (!use || !/^(?:Bash|PowerShell)$/.test(use.name)) continue;
      const text = resultText(event.content);
      const signal = failureSignal(text, use?.input?.command || use?.input?.script || '');
      if (signal) { signals.push(signal); if (failedAt < 0) failedAt = i; }
    }
    if (event.type !== 'tool_use') continue;
    uses.set(event.id, event);
    if (failedAt < 0) continue;
    if (/^(?:Bash|PowerShell)$/.test(event.name)) {
      const command = String(event.input?.command || event.input?.script || '');
      if (!delegated.test(command) && !['read-only', 'git'].includes(classifyBashCommand(command))) shellCalls++;
    }
    const target = String(event.input?.file_path || event.input?.path || '').replace(/\\/g, '/');
    const doc = /\.md$/i.test(target) || /memory|scratchpad/i.test(target) || /(?:^|\/)\.claude(?:\/|$)/i.test(target);
    if ((/^(?:Edit|Write|MultiEdit)$/.test(event.name) && !doc) || (event.name === 'Agent' && /opus|fable/i.test(event.input?.model || '')) || shellCalls >= 3) abandoned = true;
  }
  const exemption = exemptions(ctx, events, failedAt, { requireRepair: true });
  const enforcement = readJson(path.join(home, '.claude/rule-enforcement.json'));
  const promoted = enforcement['repair-failed-lane-first']?.mode === 'block';
  const modelEligible = promoted || /fable|opus/i.test(currentModel(ctx));
  const eligible = modelEligible && failedAt >= 0;
  const unrepaired = eligible && exemption !== 'lane-ok' && !repairReported(ctx.assistantText);
  const abandon = eligible && abandoned && !exemption;
  const expiry = modelEligible && !LANE_EXEMPT.test(ctx.assistantText || '') ? expiredWaitBody(ctx.assistantText) : '';
  const block = abandon || unrepaired || Boolean(expiry);
  const repairReason = `他AIレーンの失敗(${signals[0]})を直さずに終えようとしている。原因を調べてその場で修復し、修復後に1回実行して成功を実測してから [LANE-REPAIR] <レーン>: 修復済み <内容> を書け。どうしても直せない場合だけ [LANE-REPAIR] <レーン>: 修復不可 試行: <試した手段> を書け（nishi 2026-10-09: user のコストパフォーマンス最優先）`;
  const health = readJson(path.join(home, '.claude', 'lane-health.json'));
  const result = { decision: block ? 'block' : 'pass', code: unrepaired && !abandon ? 'LANE-UNREPAIRED' : 'LANE-ABANDON', signals, exemption };
  if (abandon) result.reason = `[LANE-ABANDON] 他AIレーンの失敗(${signals[0]})を放置して Claude 本体で作業した。先に node tools/lane-doctor.mjs --probe を実行し、生存レーン(${(health.implementOrder || []).join(', ') || '未確認'})へ委譲し直せ。全滅なら有効な [LANE-REPAIR] 行とともに本文に [LANE-FALLBACK] <理由> を書け（§1.18 / kim 2026-10-08）`;
  if (expiry && !abandon) result.reason = `[LANE-ABANDON] 他AIレーンの待機が期限切れになったことを理由に Claude 本体で実装を続けている（${expiry}）。待機の期限切れはレーン失敗ではないが、本体へ戻る理由にもならない。node tools/codex-do.mjs を前景・--timeout 付きで当ターン内に実行し直し、完了まで見届けてください（§1.18 / rule 13）`;
  if (unrepaired) result.reason = abandon || expiry ? `${result.reason} ${repairReason}` : repairReason;
  try { appendCorrection(home, { sessionId: ctx.sessionId || '', gate: 'lane-abandonment', verdict: result.decision, signals, excerpt: ctx.assistantText }); } catch { result.ledgerError = true; }
  return result;
}
export async function main() {
  const input = JSON.parse(await readStdinWithTimeout());
  const transcriptRaw = input.transcriptRaw ?? (input.transcript_path ? fs.readFileSync(input.transcript_path, 'utf8') : '');
  const result = evaluateLaneAbandonment({ ...input, input, transcriptRaw, assistantText: input.assistantText || input.assistant_text || '', sessionId: input.session_id });
  if (result.decision === 'block') console.log(JSON.stringify(result));
}
if (isEntry(import.meta.url)) await main();
