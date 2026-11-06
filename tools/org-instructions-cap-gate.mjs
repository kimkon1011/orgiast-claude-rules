#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"org-instructions-cap-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"org-instructions-cap-gate"}]};
import { isEntry } from './is-entry.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { appendStopLedger, registerStopViolation, stopGateOutput } from './lib/stop-recheck.mjs';
import { withStopRetryInstruction } from './lib/stop-retry-message.mjs';

const blank = value => value.replace(/[^\r\n]/g, ' ');
function prose(text) {
  return text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\S\r\n]*$/gm, blank)
    .replace(/(`+)[^\r\n]*?\1/g, blank)
    .replace(/https?:\/\/[^\s<>`"'）)\]]+/g, blank);
}

const TRIGGER_WORDS = ['追記', '追加', '以下の通り', '以下を', '新設', '導入'];

export function judge(text) {
  const raw = String(text || '');
  const body = prose(raw);
  // 組織指示に触れない応答はトリガーしない
  if (!body.includes('組織指示')) return { decision: 'pass', reasonCodes: [], reason: '' };
  // 組織指示の引用・説明だけか、追記の意図がないか
  const hasTrigger = TRIGGER_WORDS.some(word => body.includes(word));
  if (!hasTrigger) return { decision: 'pass', reasonCodes: [], reason: '' };
  // 字数の記載があるか
  const hasCharCount = /\d[\d,.]*\s*字/.test(body) || body.includes('字数') || body.includes('文字数');
  if (hasCharCount) return { decision: 'pass', reasonCodes: [], reason: '' };
  const reason = `[ORG-INSTR-CHAR-CAP] 組織指示への追記案には、現行組織指示（システムプロンプト）＋追記案の合計字数（例: 「現行 2,680 字＋追記 120 字＝合計 2,800 字」）を必ず明記してください（組織指示 3,000 字上限、kim 2026-11-07）。
合計が 2,800 字を超える場合は、この追記案の代わりに全文短縮版（正本: 組織指示_全文_短縮版_1-20 https://docs.google.com/document/d/17z0-3hgvINvQGwzv_Zc8OlXFxXe3tiWOmG9P_y7Ktpk/edit?authuser=kim@orgiast.jp ）を基にした短縮案を併せて渡すこと。`;
  return { decision: 'block', reasonCodes: ['ORG-INSTR-CHAR-CAP'], reason };
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const text = input.last_assistant_message ?? input.assistant_text ?? latestAssistantText(input.transcript_path);
    if (!text) return;
    const result = judge(text);
    if (result.decision !== 'block') return;
    const recheck = registerStopViolation({ input, assistantText: text, blockedBy: ['org-instructions-cap-gate'], reasonCodes: result.reasonCodes });
    appendStopLedger({ sessionId: recheck.sessionId, verdict: recheck.verdict, blockedBy: recheck.blockedBy, reasonCodes: recheck.reasonCodes, retryCap: recheck.retryCap });
    console.log(JSON.stringify(stopGateOutput(recheck, withStopRetryInstruction(result.reason))));
  } catch { /* fail-open 規約。 */ }
}
if (isEntry(import.meta.url)) await main();