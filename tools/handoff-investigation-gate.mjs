#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { hasManualRequest } from './manual-request-fullsteps-gate.mjs';

const home = () => process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();

export function evaluateInvestigation(text) {
  const value = String(text || '');
  if (!hasManualRequest(value)) return { decision: 'pass', reason: '手作業依頼なし', exempt: false };
  if (value.includes('[INVESTIGATION-OK]')) return { decision: 'pass', reason: 'INVESTIGATION-OK', exempt: true };

  const missing = [];
  const marker = value.search(/\[手渡し判定\]/);
  if (marker < 0) missing.push('[手渡し判定] ブロック');

  const block = marker < 0 ? '' : value.slice(marker);
  const heading = block.match(/^\s*(?:[-*]\s*)?(?:\*{1,2})?(試したこと|調査済み)(?:\*{1,2})?\s*[:：]?\s*$/m);
  if (!heading) missing.push('試したこと（または調査済み）の見出し');

  const reason = block.match(/^\s*(?:[-*]\s*)?(?:\*{1,2})?(user でないと無理な理由|本人しかできない理由)(?:\*{1,2})?\s*[:：]\s*(\S.*)$/mi);
  if (!reason) missing.push('user でないと無理な理由（または本人しかできない理由）');

  const afterHeading = heading ? block.slice((heading.index || 0) + heading[0].length) : '';
  const section = afterHeading.split(/^\s*(?:[-*]\s*)?(?:\*{1,2})?(?:user でないと無理な理由|本人しかできない理由)(?:\*{1,2})?\s*[:：]/mi)[0];
  const trialLines = section.split(/\r?\n/).filter(line => /^\s*(?:[①②③④⑤⑥⑦⑧⑨⑩]|\d+[.)]|[-*])\s*\S/.test(line));
  if (trialLines.length < 2) missing.push('試行2件以上');
  if (trialLines.filter(line => /(?:→|⇒)/.test(line)).length < 2) missing.push('各試行の結果（→ または ⇒）');

  return missing.length ? { decision: 'block', missing, exempt: false } : { decision: 'pass', reason: '調査証拠あり', missing: [], exempt: false };
}

export function failureReason(missing) {
  return `[INVESTIGATION] user に依頼していますが、事前調査の証拠がありません。\n不足: ${missing.join(', ')}\n\n[手渡し判定] ブロックに次を書いてください:\n  試したこと:\n    ① <実際に叩いた/検索した内容> → <結果>\n    ② <別経路> → <結果>\n  user でないと無理な理由: <OAuth初回同意 / 支払い / アカウント作成・ログイン / 物理操作 のどれか>\n\n「たぶん要る」は不可。手を動かして確かめた結果だけを書くこと。\n受け取っても使えないものを頼んでいないか(=受領後に機能する確証)も先に確かめること。`;
}

function record(input, result, text) {
  if (!hasManualRequest(text)) return;
  const ledger = path.join(home(), '.claude', 'handoff-ledger.jsonl');
  const record = {
    ts: new Date().toISOString(),
    sessionId: input.session_id || path.basename(input.transcript_path || '', '.jsonl'),
    gate: 'handoff-investigation',
    verdict: result.exempt ? 'bypassed' : result.decision === 'pass' ? 'passed' : 'blocked',
    reason: result.reason || (result.missing || []).join(', '),
    excerpt: text.slice(0, 200),
  };
  try {
    fs.mkdirSync(path.dirname(ledger), { recursive: true });
    fs.appendFileSync(ledger, JSON.stringify(record) + '\n');
  } catch (error) {
    console.error(`[handoff-investigation-gate] ledger書き込み失敗: ${error instanceof Error ? error.message : String(error)} path=${ledger}`);
  }
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    const input = JSON.parse(raw);
    const text = input.assistant_text || latestAssistantText(input.transcript_path);
    if (!text) return;
    const result = evaluateInvestigation(text);
    record(input, result, text);
    if (input.stop_hook_active || result.decision === 'pass') return;
    console.error(failureReason(result.missing));
    process.exitCode = 2;
  } catch {
    // 想定外エラーは既存ゲートと同じく fail-open。
  }
}

if (isEntry(import.meta.url)) await main();
