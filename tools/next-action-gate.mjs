#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "next-action-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "next-action-gate"}]};
import { sessionWakeupEvidence } from './session-wakeup-evidence.mjs';
import { isEntry } from './is-entry.mjs';
import { readTranscriptContext } from './lib/assistant-text.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { currentTurnEntries, blocks } from './state-claim-evidence.mjs';
import { isLandingDeferral } from './permanent-fix-deferral-scan.mjs';
import { ledgerFile, readLedger, latestOpenPromises } from './auto-progress-ledger.mjs';
import { classifyHandoff } from './lib/handoff-kind.mjs';
import { judgeBgTurnReport } from './bg-turn-report-gate.mjs';

export const MIN_ENFORCED_LENGTH = 200;
const FOOTER_PATTERN = /(?:^|\n)次に kim がすること:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?この後の自動進行:[ \t]*([^\r\n]*)\r?\n(?:[ \t]*\r?\n)?このセッション:[ \t]*([^\r\n]*)$/;
// Match list/action separators; exclude digit-grouping commas (e.g. "7,920円")
// and 「、または」「、もしくは」「、あるいは」disjunctive phrases (one choice, not two actions).
const MULTIPLE_ACTIONS_PATTERN = /[、・](?!\s*(?:または|もしくは|あるいは))|(?<!\d)[,，](?!\d)/;
const ACTION_LABEL_PATTERN = /[①-⑳]|[A-ZＡ-Ｚa-z0-9０-９一二三]案|案[A-ZＡ-Ｚ0-9０-９]|選択肢\s*[0-9０-９]+|(?:番号|記号)で(?:選|答|返)/gu;
const LABEL_ONLY_REASON = '[NEXT-ACTION-LABEL-ONLY] 「次に kim がすること」にラベル（①・B案・案A など）だけが書かれています。kim はそのラベルの中身を探しに遡る羽目になります（kim 2026-10-28）。(1) kim の過去の決定がある・支払いや同意が要らない・取り消せる判断なら、聞かずに Claude が決めて進め、結果を報告する。この行は「なし」にする (2) どうしても聞くなら、ラベルではなく中身をこの1行に書く（例:「1Password を月 $24.95 で契約するかを はい/いいえ で答える」）。例外は [NEXT-ACTION-LABEL-OK: <理由>]。';

function hasUnexplainedLabel(action) {
  for (const match of action.matchAll(ACTION_LABEL_PATTERN)) {
    const suffix = action.slice(match.index + match[0].length);
    const explanation = suffix.match(/^(?:（([^（）\r\n]*)）|\(([^()\r\n]*)\))/u);
    if (!explanation || [...(explanation[1] ?? explanation[2]).trim()].length < 8) return true;
  }
  return false;
}

const BACKREF_PATTERN = /前の応答|前々回|前回の応答|上の応答|先ほどの|さっきの|末尾の返信文|前に出した|既に提示|上記の文面|上記の返信|前述|以前の応答|過去の応答|遡って|スクロール/;
const APPROVAL_PATTERN = /OK|承認|確認|了承|選んで|選択|どちら|可否|返事|返信文|文面/;
const BACKREF_REASON = '[NEXT-ACTION-BACKREF] 「次に kim がすること」が前の応答を参照しています。kim はこの行だけを見て判断します。確認してほしい文面・選択肢・URL は、3行フッターの直前に「【kim 確認用の全文】」ブロックとして省略せず再掲し、この行は「上の【kim 確認用の全文】を読んで 返事を一言」のようにその応答内で閉じてください（nishi 2026-10-27 厳命・全PC）。例外は [NEXT-ACTION-BACKREF-OK: <理由>]。';
const APPROVAL_INLINE_REASON = '[NEXT-ACTION-APPROVAL-INLINE] kim に確認・承認を求めていますが、対象の全文がこの応答にありません。3行フッターの直前に「【kim 確認用の全文】」見出しを置き、文面・選択肢・URL を省略せず全文載せてください（承認待ちが続く間は毎回の応答で再掲する。要約・参照・リンク置換は不可）。例外は [NEXT-ACTION-APPROVAL-INLINE-OK: <理由>]。';
const APPROVAL_NOT_LAST_REASON = '[NEXT-ACTION-APPROVAL-NOT-LAST] 【kim 確認用の全文】の後ろに別の節（③・手間監査・恒久策・別見出し等）があります。kim は一番下だけを読むので、【kim 確認用の全文】は3行フッターの真上（最後の節）に置き、③・手間監査・恒久策はその前へ移してください（kim 2026-11-04）。例外は [NEXT-ACTION-APPROVAL-NOT-LAST-OK: <理由>]。';
const APPROVAL_HEADING = '【kim 確認用の全文】';
const SECTION_START_PATTERN = /^(?:[①-⑨]|【|手間監査|恒久策|#{1,6}\s|\[)/;
// フッター直前40行の【kim 確認用の全文】の位置: missing / not-last（後ろに別の節がある）/ last。
function approvalPlacement(turnSource) {
  const footerLabel = turnSource.lastIndexOf('次に kim がすること:');
  const footerStart = Math.max(0, turnSource.lastIndexOf('\n', footerLabel));
  const lines = turnSource.slice(0, footerStart).split(/\r?\n/).slice(-40).map(line => line.trim());
  const heading = lines.lastIndexOf(APPROVAL_HEADING);
  if (heading < 0) return 'missing';
  return lines.slice(heading + 1).some(line => SECTION_START_PATTERN.test(line)) ? 'not-last' : 'last';
}
const OPEN_ACTION_PATTERN = /マージ|merge|\bPR\b|#\d+|https?:\/\/|\]\(|開く|開いて|ひらいて|確認(?:する|して|を)|見る|見て|目を通|レビュー|チェック(?:する|して)|読む|読んで|反映を確か/i;
const HUMAN_ONLY_PATTERN = /支払|入金|決済|課金|OAuth|同意|ログインして許可|アカウント(?:を)?作成|物理|現地|署名|押印|電話(?:する|して)|口頭|選んで|選ぶ|決めて|決める|判断/;
const OPEN_ACTION_REASON = '[NEXT-ACTION-OPEN] 「次に kim がすること」に、開いて見る・確認する・マージする・レビューするなど、Claude や自動処理で済む項目が入っています。開く手間そのものが user の負担です（2026-10-26 cr 指摘）。(1) 状態は自分で照会する（例: gh pr view <N> --json state,mergedAt）。済んでいれば書かない (2) 未了なら自分で実行するか（gh pr merge <N> --squash --auto 等）「この後の自動進行」に回す (3) この行は「なし」にする。書いてよいのは人にしかできない操作（支払い・OAuth 同意・アカウント作成・物理作業・本文で選択肢を示した判断）だけ。例外は [NEXT-ACTION-OPEN-OK: <理由>]。';
const WAITING_PATTERN = /(完了通知|待ち|実行中|バックグラウンド|cron|定期実行|CI)/i;
const BACKGROUND_PATTERN = /(バックグラウンド|実行中|完了通知|Codex が|走ってい)/i;
const COMPLETE_PATTERN = /^なし\s*[（(]\s*完了\s*[）)]$/;
const DEFERRAL_PATTERN = /(恒久策|恒久化|恒久的|次セッション|次回セッション|後日|先送り)/;
const IMPLEMENTATION_PATTERN = /(実装|修正|改修|修復|作り直)/;
const DELIVERY_PATTERN = /着地|マージ|\bPR\b|push|ブランチ|main に/;
export const NO_ACTION_PATTERN = /^(?:なし|無し|ありません|不要|返信不要)(?:[。．.]?[ \t]*$|[ \t]*[（(][^\r\n]*[）)][。．.]?[ \t]*$)/;
const WAREHOUSE_PATTERN = /倉庫|棚|箱に入れ|セットに入れ|同梱|運ぶ|積む|持ち出し|格納|移動/;
const SESSION_CRON_REASON = '「まだ閉じない」で待つなら、このセッション内に定期の進捗確認を仕込んでから終える。CronCreate（recurring・毎時・分は 0/30 を避ける）で、プロンプトに『残作業の状態を照会し 1〜3 行でこのセッションに報告、状態が変わった時か判断が要る時だけ PushNotification、全部終わったら CronDelete して、確認せず自分で /session-close を実行』を書く。台帳（auto-progress --add-check）は Discord 通知用でセッションには報告しないので代わりにならない（nishi 2026-10-29・11-04 指示）。例外は [NO-SESSION-CRON-OK: <理由>]（理由5文字以上）。';
const SESSION_CLOSE_HANDOFF_REASON = '[SESSION-CLOSE-HANDOFF] 「/session-close をして」は kim に close を委ねる終わり方なので禁止です（2026-08-30・2026-11-04 kim 厳命「最終の場合は自動でセッションクローズをして」・全PC全アカウント全プロジェクト）。作業が終わったなら、確認や提案をせず、このターンで Skill session-close を自分で実行し、「このセッション: /session-close は終わっているので、このセッションを閉じてよい」で終えてください。まだ待つなら「まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）」です。実行したが失敗した時だけ、実行したコマンドと終了コードを本文に書き [SESSION-CLOSE-PENDING-OK: <理由>]（理由5文字以上）を付けてください。';
const PERMANENT_FIX_REASON ='人に作業を残すなら、今後その作業が人に来ないようにする策（自動化／担当者への依頼経路／ルール・ゲート・memory 化）をこのターンで実装し、`恒久策:` 行に実装物を書く。初回だけの作業なら `恒久策: 一回限り: <理由>`。';
const DEFERRAL_REASON = '[NEXT-ACTION-DEFERRAL] 「次に kim がすること」に恒久修正の先送り（実装・修正・恒久化・次セッション対応）が書かれています。同じ文面は夜間監査 permanent-fix-deferral-scan が P3 として検出します（2026-10-14〜10-15 に 6 件）。kim に渡してよいのは「人が一度だけ実行できる具体的手順」だけです。自分で潰せるものはこのターン内に実装して着地させ、実行不能なら実行したコマンドと終了コードを本文に記録したうえで、移せる経路（例: Codex が生きている受信PCへの fleet-mail --exec codex 便）へ流してください。どうしても人にしかできない物理操作のときだけ、先送り語（恒久策・次セッション等）を使わず具体的な1手順だけを書いてください。';
// kim が毎回同じ文で判断できるよう、表記ゆれを許さない完全一致の定型文にする（2026-09-25 kim 指示）。
// 「閉じてよい」だけでは /session-close をこれからするのか、済んだので消してよいのかが分からない
// （2026-10-01 kim 指示）ので、/session-close の状態とタブを閉じてよいかを1文に両方書く。
export const SESSION_PHRASES = {
  closed: '/session-close は終わっているので、このセッションを閉じてよい',
  delete: '/session-close は不要なので、このセッションを閉じてよい',
  // pending も「まだ閉じない」なので、同じく待つ期限を必ず書く（2026-10-27 nishi 指示）。
  pending: '/session-close をして（まだ閉じない・YYYY-MM-DD HH:MM まで待つ）',
  // まだ閉じない場合は、何日の何時まで待つかを必ず書く（2026-10-27 nishi 指示・全PC全アカウント）。
  // 期限が無いと、user はいつまでタブを開けておけばよいか分からず「進捗どう？」と聞き直すことになる。
  open: 'まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）',
};
const DEADLINE = '(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2})';
const WAIT_PATTERNS = {
  open: new RegExp(`^まだ閉じない（作業中・${DEADLINE} まで待つ）$`),
  pending: new RegExp(`^/session-close をして（まだ閉じない・${DEADLINE} まで待つ）$`),
};
const WAIT_STATES = new Set(Object.keys(WAIT_PATTERNS));

// 「まだ閉じない」行（open / pending）の待つ期限（PC のローカル時刻）。書式違い・存在しない日時は null。
export function openDeadline(value) {
  const text = String(value || '');
  const m = Object.values(WAIT_PATTERNS).map(pattern => text.match(pattern)).find(Boolean);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || h > 23 || mi > 59) return null;
  return date;
}

export function openPhrase(date, state = 'open') {
  const p = n => String(n).padStart(2, '0');
  return SESSION_PHRASES[state].replace('YYYY-MM-DD HH:MM', `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`);
}
// pending（kim に /session-close を委ねる）は SESSION-CLOSE-HANDOFF で禁止したので案内しない。
const SESSION_PHRASE_LIST = Object.entries(SESSION_PHRASES).filter(([state]) => state !== 'pending').map(([, phrase]) => `「${phrase}」`).join('');
const CLOSABLE_STATES = new Set(['closed', 'delete']);
const SESSION_STATES = Object.entries(SESSION_PHRASES).map(([state, phrase]) => [state, { test: WAIT_STATES.has(state) ? value => WAIT_PATTERNS[state].test(value) && openDeadline(value) !== null : value => value === phrase }]);

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

export function hasOpenSessionCheck(input, home) {
  if (!input.session_id) return false;
  try {
    return latestOpenPromises(readLedger(ledgerFile(home)))
      .some(row => row.sessionId === input.session_id && row.status === 'open' && ((typeof row.check === 'string' && row.check.trim()) || row.autoRegisteredCheck === true));
  } catch { return false; }
}

// Persistent registrations survive user turns until expiration or task termination.
export function hasSessionWakeup(raw, input = {}) {
  let autoProgress = false;
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
      if (/^(?:Bash|PowerShell)$/.test(tool.name || '')) {
        const cmd = String(tool.input?.command || tool.input?.script || '');
        if (/\bauto-progress(?:\.mjs)?\b/.test(cmd) && /--(?:add-check|start-when)\b/.test(cmd) && !/--help\b/.test(cmd)) {
          autoProgress = true;
        }
      }
      // Completion detection is deliberately conservative: any current-turn call counts.
      if ((tool.name === 'Agent' && tool.input?.run_in_background !== false)
        || (tool.name === 'PowerShell' && tool.input?.run_in_background === true)) background = true;
    }
  }
  if (!autoProgress && input.session_id) {
    try {
      autoProgress = latestOpenPromises(readLedger(ledgerFile()))
        .some(row => row.sessionId === input.session_id && row.status === 'open' && ((typeof row.check === 'string' && row.check.trim()) || row.autoRegisteredCheck === true));
    } catch { /* A missing or unreadable ledger is not wakeup evidence. */ }
  }
  const persistent = sessionWakeupEvidence(raw, input.now ?? Date.now());
  return { autoProgress, background: background || persistent.background, scheduled: persistent.scheduled, cron: persistent.cron === true };
}

export const WAIT_CHECK_CODES = new Set([
  'AUTOPILOT-IN-PROGRESS-NEEDS-CHECK', 'SESSION-OPEN-NEEDS-IN-SESSION-CHECK',
  'AUTOPILOT-NO-SESSION-WAKEUP', 'NEXT-ACTION-HUMAN-WAIT-NEEDS-CHECK',
]);

export const WATCH_REGISTRATION_CODES = WAIT_CHECK_CODES;

function waitingCheckIssues(source, transcriptRaw, input, turnSource) {
  if (!enabled()) return [];
  const issues = [];
  const footer = footerValues(source);
  if (!footer) {
    const launched = blocks(currentTurnEntries(transcriptRaw), 'tool_use').some(tool =>
      (/^(?:Bash|PowerShell|Agent)$/.test(tool.name || '') && tool.input?.run_in_background === true)
      || /(?:^|__)codex(?:$|__)/i.test(tool.name || '')
      || (/^(?:Bash|PowerShell)$/.test(tool.name || '')
        && /(?:^|[;&|\n]\s*|\s)(?:codex(?:\.exe)?|(?:node\s+\S*[\\/])?codex[^\s]*\.mjs)\s+(?!--(?:help|version)\b)/i.test(String(tool.input?.command || tool.input?.script || ''))));
    const wakeup = hasSessionWakeup(transcriptRaw, input);
    if (launched && !hasOpenSessionCheck(input) && !wakeup.cron && !wakeup.scheduled) {
      issues.push({ decision: 'block', code: 'AUTOPILOT-IN-PROGRESS-NEEDS-CHECK', reason: 'バックグラウンド処理を起動したターンです。同じセッションの永続チェック（auto-progress --add-check）またはセッション内の定期確認を登録してから応答を終えてください。' });
    }
    return issues;
  }
  const body = source.slice(0, source.lastIndexOf('次に kim がすること:'));
  const sessionState = SESSION_STATES.find(([, pattern]) => pattern.test(footer.session))?.[0];
  const hasAutopilot = !!footer.autopilot && !NO_ACTION_PATTERN.test(footer.autopilot);
  const wakeup = hasSessionWakeup(transcriptRaw, input);
  const noAutocheck = [...turnSource.matchAll(/\[NO-AUTOCHECK-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => reason.trim().length > 0);
  // チャットで答えるだけの返信待ち（reply-only）は会話に戻ってくるので台帳は要らない。それ以外の人待ちは載せる。
  const userHandoff = /\[手渡し判定\]|お願いする操作|^手間監査:/m.test(body);
  if ((userHandoff || !NO_ACTION_PATTERN.test(footer.nextAction)) && classifyHandoff(source) !== 'reply-only'
    && !hasOpenSessionCheck(input) && !noAutocheck) {
    issues.push({ decision: 'block', code: 'NEXT-ACTION-HUMAN-WAIT-NEEDS-CHECK', reason: (userHandoff ? 'user 本人への手渡し（[手渡し判定]／お願いする操作）も人待ちです。' : '') + '人待ちの自動進行は台帳の定期チェックに載せる: node tools/auto-progress.mjs --add-check --session <id> --check "<exit0=達成/1=未達のコマンド>" --deadline +7d --label "<名前>" --next-claude "<次の手>"。自動進行が「なし」でも同じセッションの open 行が必要です。自動確認できない場合だけ [NO-AUTOCHECK-OK: <理由>] を記載してください。' });
  }
  // Monitor / 起床通知はセッション終了で消える。実際の永続台帳を必須にする。
  if (WAIT_STATES.has(sessionState) && !hasOpenSessionCheck(input)) {
    issues.push({ decision: 'block', code: 'AUTOPILOT-IN-PROGRESS-NEEDS-CHECK', reason: '作業中のまま応答を終える前に、同じセッションの永続チェックを登録してください: node tools/auto-progress.mjs --add-check --session <id> --check "<達成判定>" --deadline +3d --label "<作業名>" --next-claude "<次の手>"。自動進行が「なし」でも必要です。バックグラウンド完了通知や登録コマンドへの言及だけでは代替できません。' });
  }
  // 台帳は Discord へ通知するだけでセッション内には何も報告しない。対話セッションで「まだ閉じない」
  // なら、セッション自身を起こす CronCreate（台帳と同じく両方要る）を必須にする（nishi 2026-10-29・11-04）。
  const noSessionCron = [...turnSource.matchAll(/\[NO-SESSION-CRON-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  const interactive = process.env.CLAUDE_HEADLESS !== '1' && !/subagents/i.test(input.transcript_path || '');
  if (WAIT_STATES.has(sessionState) && interactive && !wakeup.cron && !wakeup.scheduled && !noSessionCron) {
    issues.push({ decision: 'block', code: 'SESSION-OPEN-NEEDS-IN-SESSION-CHECK', reason: SESSION_CRON_REASON });
  }
  if (hasAutopilot && process.env.CLAUDE_HEADLESS !== '1'
    && !/subagents/i.test(input.transcript_path || '') && !wakeup.autoProgress && !wakeup.background && !wakeup.scheduled && !wakeup.cron) {
    issues.push({ decision: 'block', code: 'AUTOPILOT-NO-SESSION-WAKEUP', reason: '「この後の自動進行」が残っていますが、このセッションを定期的に起こす仕組みがありません。/loop で自走するか、Monitor か ScheduleWakeup を実際に呼ぶか、node tools/auto-progress.mjs --add-check … で定期チェックを登録してから終えてください（「夜に着手」など開始の予約は --start-when "<開始条件>" --next-claude "<やること>"。--check は完了判定なので時刻を入れない）。『次ターンで』『次回起きたら』は起床手段にならない。自動進行が無いなら「この後の自動進行: なし」と書いてください。' });
  }
  return issues;
}

function judgeNextActionSingle(text, transcriptRaw = '', input = {}, options = {}) {
  const source = String(text || '').trimEnd();
  const turnSource = String(options.turnText || source).trimEnd();
  if (!enabled()) return { decision: 'pass', reason: 'disabled' };
  const permanentFix = permanentFixViolation(turnSource, transcriptRaw);
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
  const labelOverride = [...turnSource.matchAll(/\[NEXT-ACTION-LABEL-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  if (hasUnexplainedLabel(footer.nextAction) && !labelOverride) {
    return { decision: 'block', code: 'NEXT-ACTION-LABEL-ONLY', reason: LABEL_ONLY_REASON };
  }
  if (footer.nextAction !== 'なし' && MULTIPLE_ACTIONS_PATTERN.test(footer.nextAction)) {
    return { decision: 'block', code: 'NEXT-ACTION-MULTIPLE', reason: 'kim への手渡しが2件以上あります。§1.1 最上位原則に従い、まず自分で潰して1件以下にしてください。' };
  }
  const backrefOverride = [...turnSource.matchAll(/\[NEXT-ACTION-BACKREF-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  if (BACKREF_PATTERN.test(footer.nextAction) && !backrefOverride) {
    return { decision: 'block', code: 'NEXT-ACTION-BACKREF', reason: BACKREF_REASON };
  }
  const approvalInlineOverride = [...turnSource.matchAll(/\[NEXT-ACTION-APPROVAL-INLINE-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  // 末尾の実際のフッターより前だけを調べ、見出しが直前40行以内かつ最後の節であることを求める。
  const approvalNotLastOverride = [...turnSource.matchAll(/\[NEXT-ACTION-APPROVAL-NOT-LAST-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  const placement = approvalPlacement(turnSource);
  if (footer.nextAction !== 'なし' && APPROVAL_PATTERN.test(footer.nextAction)) {
    if (placement === 'missing' && !approvalInlineOverride) {
      return { decision: 'block', code: 'NEXT-ACTION-APPROVAL-INLINE', reason: APPROVAL_INLINE_REASON };
    }
    if (placement === 'not-last' && !approvalNotLastOverride) {
      return { decision: 'block', code: 'NEXT-ACTION-APPROVAL-NOT-LAST', reason: APPROVAL_NOT_LAST_REASON };
    }
  }
  const openActionOverride = [...turnSource.matchAll(/\[NEXT-ACTION-OPEN-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  if (footer.nextAction !== 'なし' && OPEN_ACTION_PATTERN.test(footer.nextAction)
    && !HUMAN_ONLY_PATTERN.test(footer.nextAction) && !openActionOverride) {
    return { decision: 'block', code: 'NEXT-ACTION-OPEN', reason: OPEN_ACTION_REASON };
  }
  if (!footer.session) {
    return { decision: 'block', code: 'SESSION-EMPTY', reason: `「このセッション:」の値が空です。${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください。` };
  }
  const sessionState = SESSION_STATES.find(([, pattern]) => pattern.test(footer.session))?.[0];
  // 作業が終わったのに /session-close を kim に委ねる終わり方は禁止（2026-08-30・2026-11-04 kim 厳命・全PC全アカウント）。
  // Claude が確認せず自分で /session-close を実行し、closed の定型文で終える。実行して失敗した時だけ例外マーカーで通す。
  const pendingOverride = [...turnSource.matchAll(/\[SESSION-CLOSE-PENDING-OK:[ \t]*([^\]\r\n]*)\]/g)]
    .some(([, reason]) => [...reason.trim()].length >= 5);
  if (footer.session.startsWith('/session-close をして') && !pendingOverride) {
    return { decision: 'block', code: 'SESSION-CLOSE-HANDOFF', reason: SESSION_CLOSE_HANDOFF_REASON };
  }
  if (!sessionState && (footer.session.startsWith('まだ閉じない（作業中') || footer.session.startsWith('/session-close をして（まだ閉じない'))) {
    const state = footer.session.startsWith('/session-close') ? 'pending' : 'open';
    return { decision: 'block', code: 'SESSION-OPEN-NO-DEADLINE', reason: `「まだ閉じない」のときは、何日の何時まで待つかを入れてください。書式: 「${SESSION_PHRASES[state]}」（例: 「${openPhrase(new Date(Date.now() + 4 * 3600 * 1000), state)}」）。期限は、待っている相手の作業や自動チェックの期限に合わせる。` };
  }
  if (!sessionState) {
    return { decision: 'block', code: 'SESSION-INVALID', reason: `「このセッション:」は定型文${SESSION_PHRASE_LIST}のいずれかを一字一句そのまま書いてください（理由は「この後の自動進行」に書く）。` };
  }
  if (WAIT_STATES.has(sessionState) && openDeadline(footer.session).getTime() < (input.now ?? Date.now())) {
    return { decision: 'block', code: 'SESSION-OPEN-DEADLINE-PAST', reason: '「まだ閉じない」の待つ期限が既に過ぎています。待ち続けるなら新しい期限を書き、待つのをやめるなら確認せず自分で /session-close を実行してください。' };
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
    return { decision: 'block', code: 'SESSION-BACKGROUND-CONTRADICTION', reason: `本文ではバックグラウンド処理が進行中なのに、このセッションを閉じてよいと書かれており矛盾しています。ジョブが宙に浮かないよう「${SESSION_PHRASES.open}」（期限を入れる）としてください。` };
  }
  if (sessionState === 'closed' && !hasSessionCloseEvidence(source, transcriptRaw)) {
    return { decision: 'block', code: 'SESSION-CLOSE-NO-EVIDENCE', reason: `「このセッション: ${SESSION_PHRASES.closed}」とありますが、本文または会話に /session-close を実行した形跡がありません。確認せず自分で /session-close を実行してから終えてください（kim に実行を委ねない）。` };
  }
  if (footer.nextAction !== 'なし' && (DEFERRAL_PATTERN.test(footer.nextAction) || isLandingDeferral(footer.nextAction) || (IMPLEMENTATION_PATTERN.test(footer.nextAction) && DELIVERY_PATTERN.test(body)))) {
    return { decision: 'block', code: 'NEXT-ACTION-DEFERRAL', reason: DEFERRAL_REASON };
  }
  const watchIssue = waitingCheckIssues(source, transcriptRaw, input, turnSource)[0];
  if (!permanentFix && watchIssue) return watchIssue;
  return permanentFix || { decision: 'pass', reason: 'valid-footer' };
}

// Report independent footer defects together. The single evaluator remains the source of truth
// for ordered checks; the supplement reports waiting checks and independent footer
// defects together, including launches hidden by a missing footer.
export function judgeNextAction(text, transcriptRaw = '', input = {}, options = {}) {
  if (input.stop_hook_active) return { decision: 'pass', reason: 'stop-hook-active' };
  if (enabled()) {
    const background = judgeBgTurnReport(transcriptRaw, input);
    if (background.decision === 'block') return background;
  }
  const primary = judgeNextActionSingle(text, transcriptRaw, input, options);
  if (!enabled() || reportsCloseSteps(text)) return primary;
  const source = String(text || '').trimEnd();
  const turnSource = String(options.turnText || source).trimEnd();
  const footer = footerValues(source);
  const waiting = waitingCheckIssues(source, transcriptRaw, input, turnSource);
  if (primary.decision !== 'block' && !waiting.length) return primary;
  const issues = new Map(primary.decision === 'block' ? [[primary.code, primary.reason]] : []);
  for (const issue of waiting) issues.set(issue.code, issue.reason);
  const combined = () => ({ decision: 'block', code: primary.code || waiting[0].code, reasonCodes: [...issues.keys()], reason: issues.size === 1 ? [...issues.values()][0] : [...issues].map(([code, reason]) => String(reason).startsWith(`[${code}]`) ? reason : `[${code}] ${reason}`).join('\n') });
  if (!footer) return combined();
  const add = (code, reason) => issues.set(code, reason);
  const permanent = permanentFixViolation(turnSource, transcriptRaw);
  if (permanent) add(permanent.code, permanent.reason);
  const override = (name, minimum = 5) => [...turnSource.matchAll(new RegExp(`\\[${name}:[ \\t]*([^\\]\\r\\n]*)\\]`, 'g'))]
    .some(([, reason]) => [...reason.trim()].length >= minimum);
  if (hasUnexplainedLabel(footer.nextAction) && !override('NEXT-ACTION-LABEL-OK')) add('NEXT-ACTION-LABEL-ONLY', LABEL_ONLY_REASON);
  if (footer.nextAction !== 'なし' && MULTIPLE_ACTIONS_PATTERN.test(footer.nextAction)) add('NEXT-ACTION-MULTIPLE', 'kim への手渡しが2件以上あります。§1.1 最上位原則に従い、まず自分で潰して1件以下にしてください。');
  if (BACKREF_PATTERN.test(footer.nextAction) && !override('NEXT-ACTION-BACKREF-OK')) add('NEXT-ACTION-BACKREF', BACKREF_REASON);
  const placement = approvalPlacement(turnSource);
  if (footer.nextAction !== 'なし' && APPROVAL_PATTERN.test(footer.nextAction) && placement === 'missing' && !override('NEXT-ACTION-APPROVAL-INLINE-OK')) add('NEXT-ACTION-APPROVAL-INLINE', APPROVAL_INLINE_REASON);
  if (footer.nextAction !== 'なし' && APPROVAL_PATTERN.test(footer.nextAction) && placement === 'not-last' && !override('NEXT-ACTION-APPROVAL-NOT-LAST-OK')) add('NEXT-ACTION-APPROVAL-NOT-LAST', APPROVAL_NOT_LAST_REASON);
  if (footer.nextAction !== 'なし' && OPEN_ACTION_PATTERN.test(footer.nextAction) && !HUMAN_ONLY_PATTERN.test(footer.nextAction) && !override('NEXT-ACTION-OPEN-OK')) add('NEXT-ACTION-OPEN', OPEN_ACTION_REASON);
  return combined();
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
    const result = judgeNextAction(assistantText, context.raw, input);
    if (result.decision === 'block') process.stdout.write(`${JSON.stringify({ decision: 'block', reason: result.reason })}\n`);
  } catch { /* ゲート自身の失敗で応答を止めない。 */ }
}

if (isEntry(import.meta.url)) await main();
