#!/usr/bin/env node
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
  const eligible = /fable|opus/i.test(currentModel(ctx)) && failedAt >= 0;
  const unrepaired = eligible && exemption !== 'lane-ok' && !repairReported(ctx.assistantText);
  const abandon = eligible && abandoned && !exemption;
  const block = abandon || unrepaired;
  const repairReason = `他AIレーンの失敗(${signals[0]})を直さずに終えようとしている。原因を調べてその場で修復し、修復後に1回実行して成功を実測してから [LANE-REPAIR] <レーン>: 修復済み <内容> を書け。どうしても直せない場合だけ [LANE-REPAIR] <レーン>: 修復不可 試行: <試した手段> を書け（nishi 2026-10-09: user のコストパフォーマンス最優先）`;
  const health = readJson(path.join(home, '.claude', 'lane-health.json'));
  const result = { decision: block ? 'block' : 'pass', code: unrepaired && !abandon ? 'LANE-UNREPAIRED' : 'LANE-ABANDON', signals, exemption };
  if (abandon) result.reason = `[LANE-ABANDON] 他AIレーンの失敗(${signals[0]})を放置して Claude 本体で作業した。先に node tools/lane-doctor.mjs --probe を実行し、生存レーン(${(health.implementOrder || []).join(', ') || '未確認'})へ委譲し直せ。全滅なら有効な [LANE-REPAIR] 行とともに本文に [LANE-FALLBACK] <理由> を書け（§1.18 / kim 2026-10-08）`;
  if (unrepaired) result.reason = abandon ? `${result.reason} ${repairReason}` : repairReason;
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
