#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';

const COMPLETION_KEYWORDS = ['完了', 'deploy 完了', 'deploy 済', 'commit 済', 'deploy しました', 'commit しました', '全 PASS', '✅', 'verify 完了', '実装完了'];
const VERIFY_KEYWORDS = ['e2e', 'Layer 2', 'Layer2', 'Playwright', 'playwright', 'passed', 'PASS ✅', 'Layer 1', 'Layer1', 'spec'];

export function checkE2eBeforeStop(text) {
  const value = String(text || '');
  if (!COMPLETION_KEYWORDS.some(keyword => value.includes(keyword))) return { decision: 'pass' };
  if (VERIFY_KEYWORDS.some(keyword => value.includes(keyword))) return { decision: 'pass' };
  const message = `🚨 ONBOARDING §1.4.4 ルール違反疑い (Stop hook 検出)

直近の応答に '完了'/'deploy 済'/'✅' 等の 完了報告キーワードが含まれるが、
'e2e'/'Layer 2'/'Playwright'/'passed' のいずれも検出されませんでした。

ONBOARDING の報告テンプレ:
  - 実装: <変更内容>
  - typecheck: PASS
  - Layer 1: <script> PASS
  - Layer 2: <spec> e2e N passed
  - deploy: <commit hash> Vercel Ready

UI 変更なら Playwright e2e、 DB 操作なら Layer 1 script、 を 必ず通してから 完了報告してください。
typecheck + commit + deploy だけでは 完了報告と見なされません。`;
  return { decision: 'warn', message };
}

async function main() {
  try {
    let raw = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active || !input?.transcript_path || !fs.existsSync(input.transcript_path)) return;
    const text = latestAssistantText(input.transcript_path); if (!text) return;
    const result = checkE2eBeforeStop(text);
    if (result.decision === 'warn') console.log(JSON.stringify({ systemMessage: result.message }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
