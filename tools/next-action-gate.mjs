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
// kim が毎回同じ文で判断できるよう、表記ゆれを許さない完全一致の定型3文にする（2026-09-25 kim 指示）。
export const SESSION_PHRASES = {
  closed: 'アーカイブしてよい（/session-close 実行済み）',
  delete: 'アーカイブしてよい（/session-close 不要）',
  open: 'まだアーカイブしない（/session-close 未実行）',
};
const SESSION_PHRASE_LIST = Object.values(SESSION_PHRASES).map(phrase => `「${phrase}」`).join('');
const SESSION_STATES = Object.entries(SESSION_PHRASES).map(([state, phrase]) => [state, { test: value => value === phrase }]);

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

function reportsSessionClose(text) {
  // 末尾の自己申告だけ、実行予定、未実行は証拠にしない。
  const body = String(text || '').split(/(?:^|\n)次に kim がすること:/)[0];
  return /\/session-close(?:[ \t]|[`「」])*を?[ \t]*(?:実行済み|実行しました|実行した|完了しました|完了済み)(?=$|[\s。、（(）)])/m.test(body);
}

export function hasSessionCloseEvidence(text, transcriptRaw = '') {
  if (reportsSessionClose(text)) return true;
  const uses = new Set();
  for (const line of String(transcriptRaw || '').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.isSidechain === true) continue;
    const role = entry?.message?.role || entry?.type;
    const content = entry?.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    const message = typeof content === 'string' ? content : blocks.filter(block => block?.type === 'text').map(block => block.text || '').join('\n');
    // 生の JSON への部分一致では、説明やツール引数中の例まで実行証拠になる。
    if (role === 'user' && /^\s*(?:<command-message>[^<]*<\/command-message>\s*)?<command-name>\s*\/session-close\s*<\/command-name>/.test(message)) return true;
    if (role === 'assistant' && reportsSessionClose(message)) return true;
    for (const block of blocks) {
      if (role === 'assistant' && block?.type === 'tool_use' && block.name === 'Skill' && /^\/?session-close$/.test(block.input?.skill || '') && block.id) uses.add(block.id);
      if (role === 'user' && block?.type === 'tool_result' && uses.has(block.tool_use_id) && block.is_error !== true) {
        const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '');
        if (!/(?:denied|拒否|\berror\b|失敗)/i.test(result)) return true;
      }
    }
  }
  return false;
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
    return { decision: 'block', code: 'SESSION-EMPTY', reason: `「このセッション:」の値が空です。${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください。` };
  }
  const sessionState = SESSION_STATES.find(([, pattern]) => pattern.test(footer.session))?.[0];
  if (!sessionState) {
    return { decision: 'block', code: 'SESSION-INVALID', reason: `「このセッション:」は定型3文${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください（理由は「この後の自動進行」に書く）。` };
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
    return { decision: 'block', code: 'SESSION-BACKGROUND-CONTRADICTION', reason: `本文ではバックグラウンド処理が進行中なのに、アーカイブしてよいと書かれており矛盾しています。ジョブが宙に浮かないよう「${SESSION_PHRASES.open}」としてください。` };
  }
  if (sessionState === 'closed' && !hasSessionCloseEvidence(source, transcriptRaw)) {
    return { decision: 'block', code: 'SESSION-CLOSE-NO-EVIDENCE', reason: `「このセッション: ${SESSION_PHRASES.closed}」とありますが、本文または会話に /session-close を実行した形跡がありません。/session-close を実行するか、「${SESSION_PHRASES.open}」にしてください。` };
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
