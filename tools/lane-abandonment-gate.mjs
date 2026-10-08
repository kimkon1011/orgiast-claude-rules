#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { turnEntries, redact } from './handoff-audit-gate.mjs';
import { inspectTranscript, inspectTranscriptRaw } from './fable-session-guard.mjs';
import { laneHome, readJson } from './lane-doctor.mjs';
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
      || /HTTP\s*4(?:02|29)\b(?!\s*:)/i.test(line)
      || (/codex-do(?:\.mjs)?/i.test(command) && /\bexit code\s*[:=]?\s*[1-9]\d*\b/i.test(line))) return safeText(line).slice(0, 180);
  }
  return '';
}
export function exemptions(ctx, events, failureIndex = -1) {
  const users = turnEntries(ctx.transcriptRaw || '').filter(r => r.type === 'human' || r.message?.role === 'user');
  const userText = users.flatMap(r => typeof r.message?.content === 'string' ? [r.message.content] : (r.message?.content || []).filter(b => b.type === 'text').map(b => b.text)).join('\n');
  if (userText.includes('[LANE-OK]')) return 'lane-ok';
  if (/\[LANE-FALLBACK\][ \t]*\S[^\r\n]*/.test(ctx.assistantText || '')) return 'fallback';
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
      const text = resultText(event.content);
      const signal = failureSignal(text, use?.input?.command || use?.input?.script || '');
      if (signal) { signals.push(signal); if (failedAt < 0) failedAt = i; }
    }
    if (event.type !== 'tool_use') continue;
    uses.set(event.id, event);
    if (failedAt < 0) continue;
    if (/^(?:Bash|PowerShell)$/.test(event.name)) shellCalls++;
    const target = String(event.input?.file_path || event.input?.path || '').replace(/\\/g, '/');
    const doc = /\.md$/i.test(target) || /memory|scratchpad/i.test(target) || /(?:^|\/)\.claude(?:\/|$)/i.test(target);
    if ((/^(?:Edit|Write|MultiEdit)$/.test(event.name) && !doc) || (event.name === 'Agent' && /opus|fable/i.test(event.input?.model || '')) || shellCalls >= 3) abandoned = true;
  }
  const exemption = exemptions(ctx, events, failedAt);
  const block = /fable|opus/i.test(currentModel(ctx)) && failedAt >= 0 && abandoned && !exemption;
  const health = readJson(path.join(home, '.claude', 'lane-health.json'));
  const result = { decision: block ? 'block' : 'pass', code: 'LANE-ABANDON', signals, exemption };
  if (block) result.reason = `[LANE-ABANDON] 他AIレーンの失敗(${signals[0]})を放置して Claude 本体で作業した。先に node tools/lane-doctor.mjs --probe を実行し、生存レーン(${(health.implementOrder || []).join(', ') || '未確認'})へ委譲し直せ。全滅なら本文に [LANE-FALLBACK] <理由> を書け（§1.18 / kim 2026-10-08）`;
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
