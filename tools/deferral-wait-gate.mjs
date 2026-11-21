export const GATE_CONTRACT = {"name": "deferral-wait-gate", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "deferral-wait-gate"}]};

import { detect } from './permanent-fix-deferral-scan.mjs';

// 「完了を待つ」と「その完了後にやる作業」が近接しているときだけ、ターンを閉じる先送りと判定する。
// 本文全体を見る: 実際の違反は本文の途中に「完了を待っています」があり、その後に
// 「次に kim がすること: なし」の定型文が続く。末尾だけを見ると取りこぼす
// （2026-10-18T07:32:28.656Z / 49d68696 の実文がその形）。
// 2026-10-21 の実測（05:14:03 / 05:36:10 / 06:18:53）で「完了報告が届いたら…する」と
// 「完了を待ってから…実行する」が素通りしたため、通知の受け取りと待機後の実行も後続作業に含める。
const FUTURE_WORK = /終わり次第|終わったら|終わると|終了後|完了後|でき次第|出来次第|通知が(?:来|届)|届いたら|(?:完了|終了)を?待ってから|終えたら|上がったら|返ってきたら/;
// 実測 5 件はいずれも 40 字以内に後続作業が続く（`（終わり次第…）` / `（終わると…）` / `（通知が来たら…）`）。
// 離れた位置の言及（ツールの説明文など）を拾わないための距離。
const FUTURE_WINDOW = 160;

// 2026-10-22 実測: 「Codex が作業中です。終わったら本番まで出して確認します。」は
// detect() の W（完了を待って／のを待っています）に一致せず、3 行とも素通りした。
// 他AIレーンの実行中・待機を待機語として扱い、近接する後続作業があるときだけ block する。
const AGENT = '(?:Codex|codex|他AI|エージェント|レーン)';
const AGENT_RUNNING = new RegExp(`${AGENT}[^\\n」"']{0,40}?(?:作業中|実行中|進行中|稼働中|動いてい(?:ます|る)|走ってい(?:ます|る))`, 'g');
// 「Codex の作業が終わったら、…します」「…のを待って、…します」は、条件節自体が待機で
// 後続の動作が同一文に続くため、FUTURE_WORK を待たずに block する（動作が続くときだけ）。
const AGENT_WAIT_THEN = new RegExp(`${AGENT}[^\\n」"']{0,40}?(?:終わったら|終わり次第|終わると|完了したら|待って[、,])`, 'g');
const ACTION_AFTER = /します|する|進めます|実行します|確認します|出します|当てます|テストして|反映して|検証して|報告します|送ります|作ります|実装します|修正します|終えます/;
const ACTION_WINDOW = 120;
const AUDIT_QUOTE_MARKER = /handoff-audit:[0-9a-f]{16}/;

// 監査記録・検証報告が実 excerpt を「…」で引用した行は、先送りの実行ではなく引用なので除外する。
function inAuditQuote(prose, index) {
  // 引用した本文自身が「…」を含む（「「承認」か…」）ため、直近の開き括弧は見出し語の中にある。
  // 開き括弧を手前へ辿り、その行に handoff-audit ID が入っている開き括弧が 1 つでもあれば引用。
  let open = prose.lastIndexOf('「', index);
  while (open >= 0) {
    const lineStart = prose.lastIndexOf('\n', open - 1) + 1;
    if (AUDIT_QUOTE_MARKER.test(prose.slice(lineStart, open))) return true;
    // open===0 のとき lastIndexOf('「', -1) は 0 にクランプされて open が減らず無限ループする。
    if (open === 0) break;
    open = prose.lastIndexOf('「', open - 1);
  }
  return false;
}

const REPLY_WAIT = /(?:返信|返事)(?:を|が)?お?(?:待って|待ち|待っています)|(?:返信|返事)が来たら|「?続けて」?と返|続けてと返|返信待ち|返事待ち/g;
const PROD = /本番反映|本番デプロイ|本番配備|本番公開|vercel|deploy|デプロイ/i;
const REPLY_WAIT_DONE = /不要|ありません|なし|完了|済み/;
const REPLY_WAIT_WINDOW = 160;
const REPLY_WAIT_DONE_WINDOW = 40;

// 2026-10-22 実測（handoff-audit:42a15ac380371976 / f8387b05・677e8433）:
// 「「承認」か「却下 <理由>」で返信する」「返事が来るまでは何もしません」は、user の返信を
// 待つ形なのに REPLY_WAIT に一致せず Stop gate を 2 ターンとも pass していた。
// 提案の採否を user に投げ返して止まる文面を直接拾う（本番反映語との近接は要求しない）。
// 2026-11-13 再発（handoff-audit:aa6f123644833d7c / e50bea8a）: 「このセッション: まだ閉じません（kim の返信を待っています）」。
// 本番反映語も後続作業語も無い「閉じない」＋「返事待ち」の組み合わせを直接拾う。
const SESSION_CLOSE_WAIT_REPLY = /(?:このセッション|本セッション)[^」"'\n]{0,60}?(?:閉じない|閉じません|閉じず)[^」"'\n]{0,60}?(?:返信|返事)[^」"'\n]{0,30}?(?:待って|待ち|待っています)/g;
const SESSION_CLOSE_WAIT_REPLY_REASON = '「閉じない」＋「返事待ち」でセッションを開いたままにせず、返事を待つ必要がないなら当ターン内で完了まで進めて結果まで報告、待つ必要があるなら待機期限を付けて「まだ閉じない（作業中・YYYY-MM-DD HH:MM まで待つ）」と書き、確認せず自分で /session-close を実行してください。';

const DECISION_DEFERRAL = /「?承認」?(?:か|または|もしくは)「?却下|(?:返事|返信)が来るまで(?:は)?(?:何も|着手|実行)|採否を?(?:user|ユーザー|kim|あなた)?の?(?:返信|返事)/g;
const DECISION_DEFERRAL_REASON = '提案の採否を user の返信に委ねて止まらず、推奨案を採用して当ターン内で実行し結果まで報告してください。採否が本当に user 固有の判断（支払い・アカウント作成・不可逆操作）なら、その理由を明記してください。';

// 2026-10-24T04:12Z 実測（handoff-audit:d1237245b7711cd0 / session 175e831d）:
// 「PR #1060 のレビューとマージは通常のPR運用に任せます」は、PR の状態確認もマージも
// 当ターンで行わず「次に kim がすること: なし」と書いて閉じたが、本ゲートは pass した
// （夜間再審査で初めて block）。マージを通常運用へ委ねる文面を直接拾う。
const MERGE_DEFERRAL = /(?:マージ|merge)[^\n。]{0,40}?通常(?:の)?(?:PR|プルリク|マージ)?運用(?:に|へ)(?:任せ|委ね|回し)(?!ず|ない)/gi;
const MERGE_DEFERRAL_REASON = 'PR のマージを「通常運用に任せる」として止まらず、当ターン内に gh pr view で状態を確認し、条件を満たすなら tools/pr-merge.mjs（または gh pr merge）で完了まで進めてください。条件を満たさない場合は、その具体的な理由（未通過のチェック・必要なラベル等）を実測値つきで書いてください。';

// 2026-11-15 実測: 「次のセッションで最初に修理します。」の文面を検出する。
// 直せる作業を次のセッション・後日へ先送りする文面を直接拾う。
const NEXT_SESSION_DEFERRAL = /(?:次のセッション|次回(?:のセッション)?|別のセッション|新しいセッション|明日|後日|後で|あとで).{0,40}?(?:修理|修復|直し|直す|対応します|着手します|実施します|やります)/gu;
const NEXT_SESSION_EXCEPTION = /\bkim\b|金さん|お客様|返事|承認/i;
const NEXT_SESSION_UNFIXABLE = /直せない|\bunfixable\b|試した/i;
const NEXT_SESSION_ERROR = /(?:エラー(?:本文)?|\b(?:error|failed|fatal))\s*[:：]\s*[「『`"]?[^\s。！？!?「」『』`"]|\b(?:HTTP\s+[45]\d{2}|EACCES|EPERM|ENOENT|EROFS|ETIMEDOUT|ECONNREFUSED)\b/i;
const NEXT_SESSION_DEFERRAL_REASON = '直せる作業を次のセッション・後日へ先送りしています。このターンで直すか、直せない証拠（試した手段とエラー本文）を書いてください。';

// 2026-11-16 実測（kim 指摘）: 「次に kim から返信があれば、008・014 への配布に進みます」と
// 承認不要の作業を返信待ちで止め、kim に「なにを返信したら良いの？」と聞き返させた。
// 「返信があれば＋後続作業」の形を直接拾う。REPLY_WAIT の「返信が来たら」とは別形。
const REPLY_IF = /(?:返信|返事|連絡|指示|合図|OK|ＯＫ)(?:が|を)?(?:あれば|あったら|もらえれば|いただければ|頂ければ|くれれば|もらったら|いただいたら)/g;
// ACTION_AFTER は「進みます」（みます）や「着手」「配布」等を含まないため、後続作業の語彙を広く取る。
const REPLY_IF_ACTION = /進みます|進めます|着手します|着手する|実行します|配布します|反映します|取りかかります|対応します|作業に入ります/;
const REPLY_IF_AUTOMATION = /自動|仕組み|定期|cron|スイープ|ジョブ/;
const REPLY_IF_THIRD_PARTY = /お客様|先方|相手|社員|スタッフ|取引先/;
const REPLY_IF_WINDOW = 160;
// 本当に承認待ち（社外送信・削除・課金・権限・契約）のときだけ例外とする。
const REPLY_IF_APPROVAL_FORM = /【kim 確認用の全文】/;
const REPLY_IF_APPROVAL_WORDS = /送信|削除|課金|支払|権限|契約|社外/;
const REPLY_IF_APPROVAL_WINDOW = 200;
const REPLY_IF_REASON = '承認・判断が不要な作業を「返信があれば進めます」で止めず、当ターン内で完了まで実行して結果を報告してください。止めてよいのは承認必須（社外送信・削除・課金・権限変更）か人にしかできない操作だけで、その場合は理由と kim の1操作を書いてください。';

// 2026-11-16 実測（kim 指摘）: 「返信は不要です。このまま進めます。まず配布する経路を確認します。」
// と宣言だけしてツール実行の途中で応答を終え、何も進まなかった。最後の非空段落が宣言だけで
// 実行結果を伴わない形を直接拾う（コードブロック・引用行は proseLines で既に除外済み）。
const ANNOUNCE_STOP = /(?:このまま|これから|続けて|引き続き|次に|まず)[^。\n]{0,60}(?:進めます|確認します|始めます|取りかかります|着手します|実行します|対応します)。?\s*$/;
const ANNOUNCE_STOP_REASON = '『このまま進めます』等の宣言で応答を終えず、宣言した作業を当ターン内で実行し、結果（実データ）まで書いてから終えてください。';

export function enabled() {
  return process.env.ORGIAST_DEFERRAL_WAIT_GATE !== '0';
}

// 引用行と fenced code block は、回答本文ではなく例示・引用なので判定から外す。
function proseLines(text) {
  let fence;
  return String(text || '').split(/\r?\n/).map(line => {
    if (/^\s*>/.test(line)) return '';
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n');
}

export function judge(text) {
  if (!enabled()) return { decision: 'pass' };
  const prose = proseLines(text);
  for (const replyWait of prose.matchAll(REPLY_WAIT)) {
    const from = replyWait.index;
    const doneNearby = prose.slice(
      Math.max(0, from - REPLY_WAIT_DONE_WINDOW),
      from + replyWait[0].length + REPLY_WAIT_DONE_WINDOW,
    );
    if (REPLY_WAIT_DONE.test(doneNearby)) continue;
    const prodNearby = prose.slice(
      Math.max(0, from - REPLY_WAIT_WINDOW),
      from + replyWait[0].length + REPLY_WAIT_WINDOW,
    );
    if (PROD.test(prodNearby)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '本番反映を user の返信待ちにせず、Claude 側の経路（vercel deploy 等）で当ターン内に完了まで進めてください。',
      };
    }
  }
  // 「閉じない」＋「返事待ち」の組み合わせは直接 block（本番反映語・後続作業語の近接を要求しない）
  for (const match of [...prose.matchAll(SESSION_CLOSE_WAIT_REPLY)]) {
    if (!inAuditQuote(prose, match.index)) {
      return { decision: 'block', code: 'DEFERRAL-WAIT', reason: SESSION_CLOSE_WAIT_REPLY_REASON };
    }
  }
  const waits = [];
  const literal = detect(prose).find(result => result.pattern === 'W');
  if (literal) waits.push(literal.match);
  for (const match of prose.matchAll(AGENT_RUNNING)) {
    if (!inAuditQuote(prose, match.index)) waits.push(match);
  }
  // 引用判定は正規表現のカウンタに依存しないよう、配列に写してから回す。
  for (const match of [...prose.matchAll(DECISION_DEFERRAL)]) {
    if (!inAuditQuote(prose, match.index)) {
      return { decision: 'block', code: 'DEFERRAL-WAIT', reason: DECISION_DEFERRAL_REASON };
    }
  }
  for (const match of [...prose.matchAll(MERGE_DEFERRAL)]) {
    if (!inAuditQuote(prose, match.index)) {
      return { decision: 'block', code: 'DEFERRAL-WAIT', reason: MERGE_DEFERRAL_REASON };
    }
  }
  for (const match of [...prose.matchAll(REPLY_IF)]) {
    if (inAuditQuote(prose, match.index)) continue;
    const after = prose.slice(match.index + match[0].length, match.index + match[0].length + REPLY_IF_WINDOW);
    if (!REPLY_IF_ACTION.test(after)) continue;
    if (REPLY_IF_AUTOMATION.test(after)) continue;
    const before = prose.slice(Math.max(0, match.index - 30), match.index);
    if (REPLY_IF_THIRD_PARTY.test(before)) continue;
    // 【kim 確認用の全文】があり、かつ承認必須の語が近傍にある場合は本当に承認待ちなので除外する。
    if (REPLY_IF_APPROVAL_FORM.test(prose)) {
      const near = prose.slice(
        Math.max(0, match.index - REPLY_IF_APPROVAL_WINDOW),
        match.index + match[0].length + REPLY_IF_APPROVAL_WINDOW,
      );
      if (REPLY_IF_APPROVAL_WORDS.test(near)) continue;
    }
    return { decision: 'block', code: 'DEFERRAL-WAIT', reason: REPLY_IF_REASON };
  }
  // 引用内の日時や動作を除外し、文中の位置は元の本文とそろえる。
  const unquoted = prose.replace(/「(?:[^「」]|「[^「」]*」)*」|『[^『』]*』|`+[^`\n]+`+/g,
    quote => quote.replace(/[^\r\n]/g, ' '));
  for (const sentence of unquoted.matchAll(/(?:[^\n。！？!?\r.]|\.(?!\s|$))+/g)) {
    const body = prose.slice(sentence.index, sentence.index + sentence[0].length);
    if (NEXT_SESSION_EXCEPTION.test(body)) continue;
    if (NEXT_SESSION_UNFIXABLE.test(body) && NEXT_SESSION_ERROR.test(body)) continue;
    for (const match of sentence[0].matchAll(NEXT_SESSION_DEFERRAL)) {
      const beforeMatch = unquoted.slice(0, sentence.index + match.index);
      if (inAuditQuote(beforeMatch, beforeMatch.length)) continue;
      return { decision: 'block', code: 'DEFERRAL-WAIT', reason: NEXT_SESSION_DEFERRAL_REASON };
    }
  }
  for (const match of [...prose.matchAll(AGENT_WAIT_THEN)]) {
    if (inAuditQuote(prose, match.index)) continue;
    const after = prose.slice(match.index + match[0].length, match.index + match[0].length + ACTION_WINDOW);
    if (ACTION_AFTER.test(after)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '完了を待つのではなく、当ターン内に完了まで進めてください。待機が不要なら、待たずに次の作業へ進めて結果まで報告してください。',
      };
    }
  }
  for (const wait of waits) {
    const from = wait.index;
    const nearby = prose.slice(Math.max(0, from - FUTURE_WINDOW), from + wait.length + FUTURE_WINDOW);
    if (FUTURE_WORK.test(nearby)) {
      return {
        decision: 'block',
        code: 'DEFERRAL-WAIT',
        reason: '完了を待つのではなく、当ターン内に完了まで進めてください。待機が不要なら、待たずに次の作業へ進めて結果まで報告してください。',
      };
    }
  }
  // 最後の非空段落が「このまま進めます」等の宣言だけで終わっている場合（実行結果が無い）。
  // 既存のどの検出にも該当しなかった応答だけに適用するため、最後に判定する。
  const lastParagraph = prose.split('\n').map(line => line.trim()).filter(Boolean).at(-1);
  if (lastParagraph && ANNOUNCE_STOP.test(lastParagraph)) {
    return { decision: 'block', code: 'DEFERRAL-WAIT', reason: ANNOUNCE_STOP_REASON };
  }
  return { decision: 'pass' };
}
