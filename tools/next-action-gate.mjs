#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readAssistantText } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const MIN_ENFORCED_LENGTH = 200;
const FOOTER_PATTERN = /(?:^|\n)次に kim がすること:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?この後の自動進行:[ \t]*([^\r\n]*)$/;
const MULTIPLE_ACTIONS_PATTERN = /[、,，・]/;
const WAITING_PATTERN = /(完了通知|待ち|実行中|バックグラウンド|cron|定期実行|CI)/i;
const COMPLETE_PATTERN = /^なし\s*[（(]\s*完了\s*[）)]$/;

export function enabled() {
  return process.env.ORGIAST_NEXT_ACTION_GATE !== '0';
}

export function footerValues(text) {
  const source = String(text || '').trimEnd();
  const match = source.match(FOOTER_PATTERN);
  if (!match) return null;
  return { nextAction: match[1].trim(), autopilot: match[2].trim() };
}

export function hasRequiredFooter(text) {
  return footerValues(text) !== null;
}

export function judgeNextAction(text) {
  const source = String(text || '').trimEnd();
  if (!enabled()) return { decision: 'pass', reason: 'disabled' };
  if (source.length < MIN_ENFORCED_LENGTH) return { decision: 'pass', reason: 'short-response' };
  if (/[?？]$/.test(source)) return { decision: 'pass', reason: 'question' };

  const footer = footerValues(source);
  if (!footer) {
    return {
      decision: 'block',
      code: 'NEXT-ACTION-FOOTER',
      reason: '応答末尾に「次に kim がすること」と「この後の自動進行」の2行を、この順で連続して書いてください（間の空行は1つまで）。',
    };
  }
  if (!footer.nextAction) {
    return { decision: 'block', code: 'NEXT-ACTION-EMPTY', reason: '「次に kim がすること:」の値が空です。なし、または具体的な1件を書いてください。' };
  }
  if (footer.nextAction !== 'なし' && MULTIPLE_ACTIONS_PATTERN.test(footer.nextAction)) {
    return { decision: 'block', code: 'NEXT-ACTION-MULTIPLE', reason: 'kim への手渡しが2件以上あります。§1.1 最上位原則に従い、まず自分で潰して1件以下にしてください。' };
  }
  if (!footer.autopilot) {
    return { decision: 'block', code: 'AUTOPILOT-EMPTY', reason: '「この後の自動進行:」の値が空です。誰が・何を・いつ・どうやって kim に届けるかを書いてください。' };
  }
  const isComplete = COMPLETE_PATTERN.test(footer.autopilot);
  if (!isComplete && footer.autopilot.length < 10) {
    return { decision: 'block', code: 'AUTOPILOT-TOO-SHORT', reason: '「この後の自動進行:」が10文字未満です。誰が・何を・いつ・どうやって kim に届けるかを具体化してください。' };
  }
  if (isComplete && WAITING_PATTERN.test(source.slice(0, source.lastIndexOf('次に kim がすること:')))) {
    return { decision: 'block', code: 'AUTOPILOT-CONTRADICTION', reason: '本文に待ち状態があるのに「この後の自動進行: なし（完了）」となっており矛盾しています。次に誰がいつ動き、結果がどう届くかを書いてください。' };
  }
  return { decision: 'pass', reason: 'valid-footer' };
}

async function main() {
  if (!enabled()) return;
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    if (input?.stop_hook_active) return;
    const assistant = input?.assistant_text ? { text: input.assistant_text } : readAssistantText(input?.transcript_path);
    if (!assistant.text) return;
    const result = judgeNextAction(assistant.text);
    if (result.decision === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
  } catch { /* ゲート自身の失敗で応答を止めない。 */ }
}

if (isEntry(import.meta.url)) await main();
