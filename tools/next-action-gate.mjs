#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const MIN_ENFORCED_LENGTH = 200;
const FOOTER_PATTERN = /(?:^|\n)次に kim がすること:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?この後の自動進行:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?このセッション:[ \t]*([^\r\n]*)$/;
const MULTIPLE_ACTIONS_PATTERN = /[、,，・]/;
const WAITING_PATTERN = /(完了通知|待ち|実行中|バックグラウンド|cron|定期実行|CI)/i;
const BACKGROUND_PATTERN = /(バックグラウンド|実行中|完了通知|Codex が|走ってい)/i;
const COMPLETE_PATTERN = /^なし\s*[（(]\s*完了\s*[）)]$/;
const SESSION_STATES = [
  ['closed', /^閉じてよい(?:\s*[（(].*[）)])?$/],
  ['open', /^まだ閉じない(?:\s*[（(].*[）)])?$/],
  ['delete', /^もう削除してよい(?:\s*[（(].*[）)])?$/],
];

export function enabled() {
  return process.env.ORGIAST_NEXT_ACTION_GATE !== '0';
}

export function footerValues(text) {
  const source = String(text || '').trimEnd();
  const match = source.match(FOOTER_PATTERN);
  if (!match) return null;
  return { nextAction: match[1].trim(), autopilot: match[2].trim(), session: match[3].trim() };
}

export function hasRequiredFooter(text) {
  return footerValues(text) !== null;
}

export function hasSessionCloseEvidence(text, transcriptRaw = '') {
  const body = String(text || '').split(/(?:^|\n)次に kim がすること:/)[0];
  if (/(?:\/session-close\s*(?:を)?(?:実行|完了|済み)|(?:実行|完了)済み[^\r\n]*\/session-close)/i.test(body)) return true;
  return /<command-name>\s*\/session-close\s*<\/command-name>|<local-command[^>]*>[^<]*\/session-close/i.test(String(transcriptRaw || ''));
}

export function judgeNextAction(text, transcriptRaw = '') {
  const source = String(text || '').trimEnd();
  if (!enabled()) return { decision: 'pass', reason: 'disabled' };
  if (source.length < MIN_ENFORCED_LENGTH) return { decision: 'pass', reason: 'short-response' };
  if (/[?？]$/.test(source)) return { decision: 'pass', reason: 'question' };

  const footer = footerValues(source);
  if (!footer) {
    return {
      decision: 'block',
      code: 'NEXT-ACTION-FOOTER',
      reason: '応答末尾に「次に kim がすること」「この後の自動進行」「このセッション」の3行を、この順で連続して書いてください（各行間の空行は1つまで）。',
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
  if (!footer.session) {
    return { decision: 'block', code: 'SESSION-EMPTY', reason: '「このセッション:」の値が空です。「閉じてよい」「まだ閉じない」「もう削除してよい」のいずれかを書いてください。' };
  }
  const sessionState = SESSION_STATES.find(([, pattern]) => pattern.test(footer.session))?.[0];
  if (!sessionState) {
    return { decision: 'block', code: 'SESSION-INVALID', reason: '「このセッション:」は「閉じてよい」「まだ閉じない」「もう削除してよい」の3分類のいずれかで書いてください。' };
  }
  const body = source.slice(0, source.lastIndexOf('次に kim がすること:'));
  const isComplete = COMPLETE_PATTERN.test(footer.autopilot);
  if (!isComplete && footer.autopilot.length < 10) {
    return { decision: 'block', code: 'AUTOPILOT-TOO-SHORT', reason: '「この後の自動進行:」が10文字未満です。誰が・何を・いつ・どうやって kim に届けるかを具体化してください。' };
  }
  if (isComplete && WAITING_PATTERN.test(body)) {
    return { decision: 'block', code: 'AUTOPILOT-CONTRADICTION', reason: '本文に待ち状態があるのに「この後の自動進行: なし（完了）」となっており矛盾しています。次に誰がいつ動き、結果がどう届くかを書いてください。' };
  }
  if (sessionState !== 'open' && BACKGROUND_PATTERN.test(body)) {
    return { decision: 'block', code: 'SESSION-BACKGROUND-CONTRADICTION', reason: '本文ではバックグラウンド処理が進行中なのに、セッションを閉じるか削除すると書かれており矛盾しています。ジョブが宙に浮かないよう「まだ閉じない」としてください。' };
  }
  if (sessionState === 'closed' && !hasSessionCloseEvidence(source, transcriptRaw)) {
    return { decision: 'block', code: 'SESSION-CLOSE-NO-EVIDENCE', reason: '「このセッション: 閉じてよい」とありますが、本文または会話に /session-close を実行した形跡がありません。未実行を実行済みとして扱わないでください。' };
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
    const context = readTranscriptContext(input?.transcript_path);
    const assistantText = input?.assistant_text || context.assistantText;
    if (!assistantText) return;
    const result = judgeNextAction(assistantText, context.raw);
    if (result.decision === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
  } catch { /* ゲート自身の失敗で応答を止めない。 */ }
}

if (isEntry(import.meta.url)) await main();
