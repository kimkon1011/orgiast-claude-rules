#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "next-action-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "next-action-gate"}]};
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { currentTurnEntries, blocks } from './state-claim-evidence.mjs';
import { isLandingDeferral } from './permanent-fix-deferral-scan.mjs';

export const MIN_ENFORCED_LENGTH = 200;
const FOOTER_PATTERN = /(?:^|\n)次に kim がすること:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?この後の自動進行:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?このセッション:[ \t]*([^\r\n]*)$/;
const MULTIPLE_ACTIONS_PATTERN = /[、,，・]/;
const WAITING_PATTERN = /(完了通知|待ち|実行中|バックグラウンド|cron|定期実行|CI)/i;
const BACKGROUND_PATTERN = /(バックグラウンド|実行中|完了通知|Codex が|走ってい)/i;
const COMPLETE_PATTERN = /^なし\s*[（(]\s*完了\s*[）)]$/;
const DEFERRAL_PATTERN = /(恒久策|恒久化|恒久的|次セッション|次回セッション|後日|先送り)/;
const IMPLEMENTATION_PATTERN = /(実装|修正|改修|修復|作り直)/;
const DELIVERY_PATTERN = /着地|マージ|\bPR\b|push|ブランチ|main に/;
const NO_ACTION_PATTERN = /^(?:なし|無し|ありません|不要|返信不要)(?:[。．.]?[ \t]*$|[ \t]*[（(][^\r\n]*[）)][。．.]?[ \t]*$)/;
const WAREHOUSE_PATTERN = /倉庫|棚|箱に入れ|セットに入れ|同梱|運ぶ|積む|持ち出し|格納|移動/;
const PERMANENT_FIX_REASON = '人に作業を残すなら、今後その作業が人に来ないようにする策（自動化／担当者への依頼経路／ルール・ゲート・memory 化）をこのターンで実装し、`恒久策:` 行に実装物を書く。初回だけの作業なら `恒久策: 一回限り: <理由>`。';
const DEFERRAL_REASON = '[NEXT-ACTION-DEFERRAL] 「次に kim がすること」に恒久修正の先送り（実装・修正・恒久化・次セッション対応）が書かれています。同じ文面は夜間監査 permanent-fix-deferral-scan が P3 として検出します（2026-10-14〜10-15 に 6 件）。kim に渡してよいのは「人が一度だけ実行できる具体的手順」だけです。自分で潰せるものはこのターン内に実装して着地させ、実行不能なら実行したコマンドと終了コードを本文に記録したうえで、移せる経路（例: Codex が生きている受信PCへの fleet-mail --exec codex 便）へ流してください。どうしても人にしかできない物理操作のときだけ、先送り語（恒久策・次セッション等）を使わず具体的な1手順だけを書いてください。';
// kim が毎回同じ文で判断できるよう、表記ゆれを許さない完全一致の定型文にする（2026-09-25 kim 指示）。
// 「閉じてよい」だけでは /session-close をこれからするのか、済んだので消してよいのかが分からない
// （2026-10-01 kim 指示）ので、/session-close の状態とタブを閉じてよいかを1文に両方書く。
export const SESSION_PHRASES = {
  closed: '/session-close は終わっているので、このセッションを閉じてよい',
  delete: '/session-close は不要なので、このセッションを閉じてよい',
  pending: '/session-close をして（まだ閉じない）',
  open: 'まだ閉じない（作業中）',
};
const SESSION_PHRASE_LIST = Object.values(SESSION_PHRASES).map(phrase => `「${phrase}」`).join('');
const CLOSABLE_STATES = new Set(['closed', 'delete']);
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

function hasWarehouseDispatch(transcriptRaw) {
  return blocks(currentTurnEntries(transcriptRaw), 'tool_use').some(tool => {
    if (/^mcp__claude_ai_Discord__(?:send_dm|send_message)$/.test(tool.name || '')) return true;
    if (tool.name !== 'Bash') return false;
    const command = String(tool.input?.command || '');
    // ファイル名への言及・dry-run は依頼送信の実行に数えない。
    return /(?:^|[;\n&|])\s*node\s+["']?(?:[^\s"']*[\\/])?discord-dm\.mjs["']?\s+\S/.test(command)
      && !/--(?:dry-run|help)\b/.test(command);
  });
}

function permanentFixViolation(text, transcriptRaw) {
  const prose = text.replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '').replace(/^[ \t]*>.*$/gm, '');
  const actions = [...prose.matchAll(/^[ \t]*(?:[-*][ \t]+)?(?:\*\*)?次に\s*kim\s*がすること(?:\*\*)?[ \t]*[:：][ \t]*(.*)$/gm)]
    .map(([, value]) => value.replace(/\*\*/g, '').trim()).filter(value => value && !NO_ACTION_PATTERN.test(value));
  if (!actions.length) return null;
  const override = [...prose.matchAll(/\[PERMANENT-FIX-OK:[ \t]*([^\]\r\n]*)\]/g)].some(([, reason]) => [...reason.trim()].length >= 10);
  const fixes = [...prose.matchAll(/^[ \t]*恒久策[:：][ \t]*([^\r\n]*)/gm)].map(([, value]) => value.trim());
  const concrete = /[\p{L}\p{N}_./-]+\.(?:mjs|cjs|js|ts|py|ps1|sh|md|json|ya?ml)\b|\bPR\s*#?\d+\b|\/pull\/\d+|\bmcp__\w+|\b(?:node|gh|npm|git)\s+\S+|[^\s。、]+(?:さん|担当|チーム)(?:へ|に)|(?:送信先|ツール名)[:：]\s*\S+/u;
  const implemented = /(?:実装|設定|追加|登録|作成|送信|依頼|導入|修正)(?:済み?|した(?!い)|しました)|(?:自動実行|自動化)(?:に)?(?:した(?!い)|しました)/;
  const pending = /検討|予定|未実装|未設定|未送信|未追加|してい(?:ない|ません)|でき(?:ない|ません)|済み?では(?:ない|ありません)/;
  if (!override && !fixes.some(fix => /^一回限り[:：][ \t]*\S/.test(fix) || (concrete.test(fix) && implemented.test(fix) && !pending.test(fix)))) {
    return { decision: 'block', code: 'PERMANENT-FIX-REQUIRED', reason: PERMANENT_FIX_REASON };
  }
  if (actions.some(action => WAREHOUSE_PATTERN.test(action)) && !hasWarehouseDispatch(transcriptRaw)) {
    return { decision: 'block', code: 'WAREHOUSE-DISPATCH-REQUIRED', reason: '倉庫の物理作業は倉庫担当へ Claude が依頼する（`node tools/discord-dm.mjs <倉庫担当> --body-file <本文>`）。依頼済みなら「倉庫担当へ依頼済み」と書き、次に kim がすることから外す。' };
  }
  return null;
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

// session-close SKILL.md §7.1: 閉じ際は「誰が・何を・どの順で」の 1./2./3.（close-session.mjs 実行 →
// 新タブで Enter → このタブを ✕、/clear は使わない）を出す。この文面は定型3行フッターを持たないが、
// 3行そのものが次の一手の指示なので block しない（block すると余分な1ターンでログが書き戻り、
// 退避したはずのセッションが一覧に復活する／[[feedback-close-session-then-keep-talking-recreates-jsonl]]）。
export function reportsCloseSteps(text) {
  const body = String(text || '');
  if (!/close-session\.mjs/.test(body) || !/✕/.test(body) || !/\/clear/.test(body)) return false;
  // §7.1 は必ず「1./2./3.」の番号付き3行で出す。3語に"言及しただけ"の長文レポート
  // （閉じ際の仕組みを説明する完了報告など）を閉じ際と誤認しないための最低条件。
  const numbered = step => new RegExp(`(?:^|\\n)[ \\t]*${step}[.．、)）]`).test(body);
  return numbered('1') && numbered('2') && numbered('3');
}

// Cron evidence survives user turns; background evidence belongs only to this turn.
// Use the conservative latest-create/latest-delete fallback when job ids vary.
function hasSessionWakeup(raw) {
  let cronActive = false;
  let background = false;
  for (const line of String(raw || '').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry || entry.isSidechain === true) continue;
    const role = entry.message?.role || entry.type;
    const content = entry.message?.content;
    const parts = Array.isArray(content) ? content : [];
    const text = typeof content === 'string' ? content : parts.filter(b => b?.type === 'text').map(b => b.text || '').join('\n');
    if (role === 'user' && !entry.isMeta && !parts.some(b => b?.type === 'tool_result')
      && !/^\s*<task-notification>/.test(text)) background = false;
    if (role !== 'assistant') continue;
    for (const tool of parts) {
      if (tool?.type !== 'tool_use') continue;
      if (tool.name === 'CronCreate') cronActive = true;
      if (tool.name === 'CronDelete') cronActive = false;
      // Completion detection is deliberately conservative: any current-turn call counts.
      if ((tool.name === 'Agent' && tool.input?.run_in_background !== false)
        || (/^(?:Bash|PowerShell)$/.test(tool.name || '') && tool.input?.run_in_background === true)) background = true;
    }
  }
  return cronActive || background;
}

export function judgeNextAction(text, transcriptRaw = '', input = {}) {
  const source = String(text || '').trimEnd();
  if (!enabled()) return { decision: 'pass', reason: 'disabled' };
  const permanentFix = permanentFixViolation(source, transcriptRaw);
  if (/[?？]$/.test(source)) return permanentFix || { decision: 'pass', reason: 'question' };
  if (reportsCloseSteps(source)) return permanentFix || { decision: 'pass', reason: 'close-steps' };

  const footer = footerValues(source);
  // フッターを書いた短文も定型文を検査する（短文素通しで『閉じてOKです』が通った 2026-10-09 実害）。
  // 短文素通しは雑談・相槌だけ。ツールで作業したターンは短文・空文でもフッター必須
  // （作業後に「No response requested.」だけで終わり、自動進行が台帳に載らず kim が進捗を聞く羽目になった 2026-10-23 実害）。
  const worked = blocks(currentTurnEntries(transcriptRaw), 'tool_use').length > 0;
  if (!footer && (!worked || !source) && source.length < MIN_ENFORCED_LENGTH) return permanentFix || { decision: 'pass', reason: 'short-response' };
  if (!footer) {
    return {
      decision: 'block',
      code: 'NEXT-ACTION-FOOTER',
      reason: `応答末尾に「次に kim がすること」「この後の自動進行」「このセッション」の3行を、この順で連続して書いてください（各行間の空行は1つまで）。「このセッション:」は定型文${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書く。`,
    };
  }
  if (!footer.nextAction) {
    return { decision: 'block', code: 'NEXT-ACTION-EMPTY', reason: '「次に kim がすること:」の値が空です。なし、または具体的な1件を書いてください。' };
  }
  if (footer.nextAction !== 'なし' && MULTIPLE_ACTIONS_PATTERN.test(footer.nextAction)) {
    return { decision: 'block', code: 'NEXT-ACTION-MULTIPLE', reason: 'kim への手渡しが2件以上あります。§1.1 最上位原則に従い、まず自分で潰して1件以下にしてください。' };
  }
  if (!footer.session) {
    return { decision: 'block', code: 'SESSION-EMPTY', reason: `「このセッション:」の値が空です。${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください。` };
  }
  const sessionState = SESSION_STATES.find(([, pattern]) => pattern.test(footer.session))?.[0];
  if (!sessionState) {
    return { decision: 'block', code: 'SESSION-INVALID', reason: `「このセッション:」は定型文${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください（理由は「この後の自動進行」に書く）。` };
  }
  const body = source.slice(0, source.lastIndexOf('次に kim がすること:'));
  const isComplete = COMPLETE_PATTERN.test(footer.autopilot);
  const hasAutopilot = !!footer.autopilot && !footer.autopilot.startsWith('なし');
  if (hasAutopilot && footer.autopilot.length < 10) {
    return { decision: 'block', code: 'AUTOPILOT-TOO-SHORT', reason: '「この後の自動進行:」が10文字未満です。誰が・何を・いつ・どうやって kim に届けるかを具体化してください。' };
  }
  if (isComplete && WAITING_PATTERN.test(body)) {
    return { decision: 'block', code: 'AUTOPILOT-CONTRADICTION', reason: '本文に待ち状態があるのに「この後の自動進行: なし（完了）」となっており矛盾しています。次に誰がいつ動き、結果がどう届くかを書いてください。' };
  }
  if (CLOSABLE_STATES.has(sessionState) && BACKGROUND_PATTERN.test(body)) {
    return { decision: 'block', code: 'SESSION-BACKGROUND-CONTRADICTION', reason: `本文ではバックグラウンド処理が進行中なのに、このセッションを閉じてよいと書かれており矛盾しています。ジョブが宙に浮かないよう「${SESSION_PHRASES.open}」としてください。` };
  }
  if (sessionState === 'closed' && !hasSessionCloseEvidence(source, transcriptRaw)) {
    return { decision: 'block', code: 'SESSION-CLOSE-NO-EVIDENCE', reason: `「このセッション: ${SESSION_PHRASES.closed}」とありますが、本文または会話に /session-close を実行した形跡がありません。/session-close を実行するか、「${SESSION_PHRASES.pending}」にしてください。` };
  }
  if (footer.nextAction !== 'なし' && (DEFERRAL_PATTERN.test(footer.nextAction) || isLandingDeferral(footer.nextAction) || (IMPLEMENTATION_PATTERN.test(footer.nextAction) && DELIVERY_PATTERN.test(body)))) {
    return { decision: 'block', code: 'NEXT-ACTION-DEFERRAL', reason: DEFERRAL_REASON };
  }
  if (!permanentFix && hasAutopilot && process.env.CLAUDE_HEADLESS !== '1'
    && !/subagents/i.test(input.transcript_path || '') && !hasSessionWakeup(transcriptRaw)) {
    return { decision: 'block', code: 'AUTOPILOT-NO-SESSION-WAKEUP', reason: '「この後の自動進行」が残っていますが、このセッションを定期的に起こす仕組みがありません。CronCreate で毎時の進捗チェック（:00/:30 を避ける・未完了項目・変化時だけ報告・完了で CronDelete）を登録してから終えてください。自動進行が無いなら「この後の自動進行: なし」と書いてください。' };
  }
  return permanentFix || { decision: 'pass', reason: 'valid-footer' };
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
    const result = judgeNextAction(assistantText, context.raw, input);
    if (result.decision === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
  } catch { /* ゲート自身の失敗で応答を止めない。 */ }
}

if (isEntry(import.meta.url)) await main();
