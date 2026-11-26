#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"lane-claim-evidence-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"lane-claim-evidence-gate"},{"kind":"command","ref":"node tools/lane-doctor.mjs --probe"}]};
import path from 'node:path';
import crypto from 'node:crypto';
import { laneHome, readJson, atomicJson, PROVIDERS } from './lane-doctor.mjs';
import { LANE_NAMES } from './lib/lane-real-health.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';

export function claimProse(text) {
  let fence = '';
  return String(text || '').split(/\r?\n/).filter(line => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1][0]; else if (fence === marker[1][0]) fence = ''; return false; }
    return !fence && !/^\s*>/.test(line);
  }).join('\n');
}
const stopped = /残高(?:が)?(?:切れ|不足)|入金(?:が必要|[（(]または上限[）)])|請求上限で停止|全滅|全レーン停止|全て失敗|使えません|使えない|停止中|停止して|停止です|は停止/;
const allStopped = /全滅|全レーン停止|全て失敗/;
const fresh = (at, now) => Number.isFinite(Date.parse(at)) && now >= Date.parse(at) && now - Date.parse(at) <= 1800000;

export function evaluateLaneClaimEvidence(ctx, { home = laneHome(), now = Date.now(), record = true } = {}) {
  const prose = claimProse(ctx.assistantText ?? ctx.assistant_text);
  const health = readJson(path.join(home, '.claude/lane-health.json'));
  const markers = [...prose.matchAll(/\[LANE-PROBE: lane=([\w-]+) at=(\S+) direct=(yes|no) result=(fail|alive) evidence=([^\]\r\n]+)\]/g)];
  const claims = new Map();
  for (const sentence of prose.replace(/\[LANE-PROBE:[^\]\n]*\]/g, '').split(/[。\n]+/)) {
    // A qualified report of a monitor's unverified display is not a diagnosis.
    if (/未確認/.test(sentence) && /lane-watch|監視|表示|引用/.test(sentence)) continue;
    const lanes = LANE_NAMES.filter(lane => new RegExp(`\\b${lane}\\b`, 'i').test(sentence));
    if (allStopped.test(sentence) && (lanes.length || /レーン/.test(sentence))) {
      for (const lane of new Set([...PROVIDERS, ...Object.keys(health.lanes || {}).filter(l => LANE_NAMES.includes(l))])) claims.set(lane, claims.get(lane) || /残高|入金|請求/.test(sentence));
    } else if (stopped.test(sentence)) for (const lane of lanes) claims.set(lane, claims.get(lane) || /残高|入金|請求/.test(sentence));
  }
  const invalid = [...claims.keys()].filter(lane => {
    const state = health.lanes?.[lane];
    return !markers.some(([, name, at, direct, result, evidence]) =>
      name.toLowerCase() === lane && direct === 'yes' && result === 'fail' && evidence.trim()
      && fresh(at, now) && state && fresh(state.probedAt, now)
      && Date.parse(at) === Date.parse(state.probedAt) && state.viaChain === false
      && state.probeResult === 'fail' && state.alive === false
      && state.reason !== 'probe_inconclusive'
      && (!claims.get(lane) || state.reason === 'billing')
    );
  });
  if (!invalid.length) return { decision: 'pass' };
  const reason = `[LANE-CLAIM-EVIDENCE] ${invalid.join(', ')} の断定に一致する30分以内の直接実測がありません。node tools/lane-doctor.mjs --probe を実行し、記録と一致する [LANE-PROBE: lane=<名> at=<ISO時刻> direct=yes result=fail|alive evidence=<要約または終了コード>] を添えてください。Codex は CODEX_DO_CHEAP_FIRST=0 node tools/codex-do.mjs ... --no-fallback で直接確認し、稼働中の安いAIへ直接渡し直して作業を続けてください。未実測なら未確認と明記してください。`;
  // Dedicated session ledger, like the Stop runner's registerStopViolation counter.
  const session = ctx.sessionId || ctx.session_id || ctx.input?.session_id || ctx.input?.transcript_path || 'unknown';
  const key = crypto.createHash('sha256').update(session).digest('hex');
  const file = path.join(home, '.claude/lane-claim-evidence-state.json');
  const counters = readJson(file);
  if ((counters[key] || 0) >= 3) return { decision: 'warn', code: 'LANE-CLAIM-EVIDENCE-CAP', reason };
  if (record) { counters[key] = (counters[key] || 0) + 1; atomicJson(file, counters); }
  return { decision: 'block', code: 'LANE-CLAIM-EVIDENCE', reason };
}
export async function main() {
  const input = JSON.parse(await readStdinWithTimeout());
  const assistantText = input.assistantText ?? input.assistant_text ?? input.last_assistant_message ?? readTranscriptContext(input.transcript_path).assistantText;
  const result = evaluateLaneClaimEvidence({ ...input, assistantText });
  if (result.decision === 'block') console.log(JSON.stringify(result));
}
if (isEntry(import.meta.url)) await main();
