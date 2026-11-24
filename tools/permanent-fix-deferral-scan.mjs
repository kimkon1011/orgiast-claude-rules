#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// 末尾の (?<!の)先送り(?!文): 「恒久修正の先送り文」「原価フロア実装の先送り」＝先送りを
// **名詞句として説明**した自己言及（先送りを検証する側の文）で誤検出しないため。行為形
// （先送りする/した/にする）は前後が「の」でも「文」でもないので引き続き検出する。
// 量化子は非貪欲（`{0,60}?`）。貪欲だと1つの文に先送り語が2回出るとき最後の語まで飲み込み、
// 引用の判定（一致の直後が閉じ括弧か）が後ろの語にずれる。
const P1_BASE = /(恒久|改修|実装|修正|対応|恒久化)[^」"'\n]{0,60}?(次(?:の)?セッション|次回セッション|次回に|後日|来週|(?<!の)先送り(?!文))/;
// 監査項目名の引用は P1 から除く。例: 「`59f6caca0d69166e`（event-shop.jp「AUJUST」誤記の
// 恒久修正先送り）の実物検証と記録」。括弧で閉じた先送り語は「先送りを名詞句として名指しした」
// だけで、先送りを実行した文ではない（行為形は必ず 先送りする/した/にする と続く）。
// これを数えると検証セッションの成果物が翌晩の新しい P1 になり、毎晩「検証の検証」を積む
// 自己言及ループが止まらない（2026-10-06T18:23 と 2026-10-07T18:26 が同型）。
// 括弧で閉じているだけでは除かず、直後が検証・記録の文脈のときだけ引用とみなす。
const P1_CITATION_AFTER = /(実物検証|再発|検証|記録)/;
const P1 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(P1_BASE, 'g'))) {
      const end = match.index + match[0].length;
      const bracketed = /[」）]/.test(text[end] ?? '');
      const after = text.slice(end, end + 60).split('\n')[0];
      if (bracketed && P1_CITATION_AFTER.test(after)) continue;
      return match;
    }
    return null;
  }
};
// 監査IDの参照は角括弧つき（handoff-audit の TODO 行）と角括弧なし（検証報告の本文）の両方がある。
// 検証セッションの完了報告は `handoff-audit:<id>（W / TJP-09「…」）を実物検証し` の形で
// 監査項目のタイトルを引用するため、括弧なし形を知らないと引用内の待機語を W と誤検出し、
// 「検証の検証」を毎晩積む自己言及ループが再発する（2026-10-13T15:45 / session 0c5f9631 が実例）。
const AUDIT_MARKER = /\[?handoff-audit:[0-9a-f]{16}\]?|\[?off-audit:[0-9a-f]{16}\]?|恒久修正の先送り文を検出（/;
function isAuditCitation(text, index) {
  const quoteStart = text.lastIndexOf('「', index);
  if (quoteStart < 0 || text.indexOf('」', quoteStart + 1) < index) return false;
  const lineStart = Math.max(text.lastIndexOf('\n', quoteStart - 1) + 1, 0);
  if (!AUDIT_MARKER.test(text.slice(lineStart, quoteStart))) return false;
  // 監査IDの近傍（80字以内）にある引用は、その項目の抜粋を引いたもの。
  // 40字だと `handoff-audit:<16hex>（W / TJP-09` で ID の先頭が切れて認識できない。
  if (AUDIT_MARKER.test(text.slice(Math.max(0, quoteStart - 80), quoteStart))) return true;
  // 実物の TODO はマーカーと引用の間に日時・session ID・判定を挟む。
  return /（[^\r\n「」]*）$/.test(text.slice(lineStart, quoteStart));
}
// 監査 TODO の引用（isAuditCitation）とは別に、検証セッションの handoff が検出結果そのものを
// 引用する形がある。実測（2026-10-13T18:04:42.788Z / 599d5772）: `原文は \`W\`/"完了待ちで" で再現`。
// これは先送りを実行した文ではなく検出器の出力をデータとして引いた文なので、一致がその引用スパンの
// 内側にあり、開き引用符の手前にパターン名（P1-P4/W）がある場合だけ採用しない。パターン名の前置きを
// 条件にするのは、素の引用文（「…完了を待っています」）を巻き込まないため。
const QUOTE_PAIRS = [['「', '」'], ['"', '"'], ["'", "'"]];
const PATTERN_TOKEN = /(?:^|[^A-Za-z0-9])(P1|P2|P3|P4|W)(?![A-Za-z0-9])/;
function isPatternNameQuote(text, index) {
  return QUOTE_PAIRS.some(([open, close]) => {
    const start = text.lastIndexOf(open, index);
    if (start < 0 || start === index) return false;
    if (text.indexOf(close, index) < 0) return false;
    return PATTERN_TOKEN.test(text.slice(Math.max(0, start - 40), start));
  });
}
function auditAwareFind(regex, text) {
  for (const match of text.matchAll(new RegExp(regex, 'g'))) {
    if (isAuditCitation(text, match.index) || isPatternNameQuote(text, match.index)) continue;
    return match;
  }
  return null;
}
const P2 = { find: text => auditAwareFind(/(次(?:の)?セッション|次回セッション|次回に|後日)[^」"'\n]{0,60}(実装|対応|修正|改修|恒久)/, text) };
// 2026-10-19 の実測3件で「〜のを待っています」と「終わると知らせが届きます」が素通りしたため、
// 名詞化した待機と完了通知待ちも W に含める。
// 2026-10-21T05:14:03.146Z（handoff-audit:38fe891783fc6ce2 / 4d7e4383）の原文は
// 「完了待ちです」で拾えていたが、同じセッションが以後 7 ターン（05:15:06〜06:00:15）
// 「完了はまだです」「〜しているところです」「結果を待っています」と言い換えて待機し、
// W に一致せず全部 pass した。他レーン（別セッション・Codex）の名前の近くに完了待ちを
// 表す言い回しがある形も W に含める。レーン名から 60 字以内に限るのは、離れた言及
// （レポート本文の前置き）と結び付けて誤検出しないため。素の「サブエージェントの
// 結果を待っています」は自分のサブエージェント待ちなので対象外（レーン名に一致しない）。
// 2026-10-23T06:54:05.630Z（handoff-audit:05b1b5a651a474e1 / 017b465e / W）の原文
// 「ルール側の PR のマージと、Codex の実装完了の両方を待っています。どちらも終わると通知が
// 来るので、届き次第検証に入ります。」は、`Codex` と `完了` が同じ文にあったため偶然
// LANE_STATUS_WAIT に当たっていた。レーン名・「完了」・「のを待って」のどれかを落とす
// （例:「PR のマージを待っています。終わると通知が来るので…」）だけで全部素通りするので、
// **完了通知の到着待ち・マージ待ちの言い回し自体**を W に含める。
// 2026-10-27 quota-sweep 再監査（91cd4fa3）: 「検証は Codex に任せています。結果が出たらここに報告します。」が
// 待機語を含まず素通りしたため、結果到着後の報告約束そのものも W に含める。
const ARRIVAL_WAIT = /(?:終わる|終わった|完了する|完了した|マージされ(?:る|た))[^」"'\n]{0,20}(?:自動で)?(?:知らせ|通知|連絡)が(?:届|来|着)|(?:知らせ|通知|連絡)が(?:届|来|着)[^」"'\n]{0,20}(?:まで)?待|(?:通知|連絡)がまだ(?:来て|届いて|着いて)いません|届き次第(?:検証|確認|対応|報告)|(?:結果|完了|終了)(?:が|を)?(?:出|戻っ|返っ|揃っ|届い|着い)(?:たら|次第)[^」"'\n]{0,20}(?:報告|お知らせ|共有|連絡)|(?:終わり|完了|終了)次第[^」"'\n]{0,20}(?:報告|お伝え|お知らせ|共有|連絡)|(?:PR|マージ|取り込み)[^」"'\n]{0,20}を待って(?:います|いる|ます|おります)/;
// 116827928ab09de7: 他レーンが「修正中で、まだ確かめられる状態にない」
// と再テストを後続へ残す表現。レーン名と未検証理由が揃う場合に限る。
const LANE_STATUS_WAIT = /(?:セッション|Codex|codex-do|他AI|レーン)[^\n」"']{0,60}?(?:完了は?まだ|まだ完了|まだ実行中|完了待ち|結果を待って|(?:している|ている|待っている|動いている|走っている)ところです|(?:している|ている)最中|(?:修正|実装|改修|検証)中(?:で|のため|なので)[、, ]*まだ(?:確かめ|確認|検証)(?:られる状態にない|できない|できません)|を待っています|を待っている)/;
// 2026-11-01T18:02:06.670Z（handoff-audit:5a993ac7de7ccdf5 / 91cd4fa3 / W）の
// 「「下記みつもりつくって」のセッション: event-shop.jp の価格を変えるかどうかの返事を待っています。」は
// LANE_STATUS_WAIT が `セッション:` と `を待っています` の近接で偶然拾っていた。同じセッションの
// 03:47:46.105Z「価格改定の返事を待っているセッションも、まだ止まったままです。」は語順が逆
// （待機→セッション）で素通りしており、待機の名詞化（返事/返答を待って）自体を W に含める。
// 全3台帳で測ると新規に当たるのは4件だけで、すべて kim-PC / nishi の返事待ち（外部の返事待ちは0件）。
// お客様・取引先など外部の返事待ちは Claude が実装で解消できない正当な待機なので除外する
// （自分のサブエージェント待ちも同様）。
const REPLY_WAIT = /(?:返事|返答)を待って(?:います|いる|おります)/;
// 2026-11-18 実測（96bfba6f / d5fa33a8）: kim-inbox の info 通知を【受信箱】形式で転記した文が
// 「のを待って」に当たっていた。通知文面の言い換えであって Claude 自身の先送りではない。
// 受信箱ブロックの見出し語が一致位置の手前 200 字以内にある場合だけ採用しない。
const INBOX_RELAY = /(?:【受信箱】|起きたこと[:：]|判断してほしいこと[:：]|返事の例[:：])/;
// 2026-11-18 実測（e88a780c / 8b21d815）: 当ターンで指示書を書いて codex-do を起動した直後の
// 「完了を待っています」「完了を待ちます」が W に当たっていた。委譲を起動した上での待機は
// Claude 側の作業が終わっている正当な状態で、委譲せずに待つ放置とは区別する。
// 委譲を起動したと明記した語が一致位置の手前 120 字以内にある場合だけ採用しない。
// （委譲の報告が無いまま待つ形 — 2026-10-21 の 7 ターン言い換え待機 — は従来どおり検出する）
const DELEGATION_STARTED = /(?:codex-do|cheap-code|llm-ask|指示書を(?:作成|書|渡|用意)|(?:Codex|Gemini|DeepSeek|Groq|OpenRouter|Mistral|サブエージェント)[ \t]*(?:に|へ|を)[^。\n]{0,24}(?:委譲|依頼|渡し|投げ|起動|実行させ)|`[a-z0-9]{6,12}`[^。\n]{0,80}(?:完了待ち|完了後|push|CI[^。\n]{0,20}結果を待|結果を待って))/i;
// 委譲の報告と待機文が表やフッターで離れる中間報告もある。同じメッセージに
// 「実行中」と「当セッションで着地まで進める／まだ閉じない」の両方がある場合に限り、
// 未委譲の放置ではなく同一セッション内の一時待機とみなす。
const ACTIVE_DELEGATION_CONTEXT = /(?:Codex|委譲)[^\n]{0,80}(?:作成中|実行中|監視中)/i;
const SAME_SESSION_CONTINUATION = /(?:当|同一|この)セッションで[^。\n]{0,60}(?:進め|完了|着地)|このセッション[:：][^\n]{0,80}まだ閉じない/;
// 2026-11-18 実測（e88a780c / 2026-11-17T04:04:04.337Z）: 3行フッターだけのメッセージ
// 「次に kim がすること: なし（Codex の生成完了を待っています）」が W に当たっていた。
// 人の作業がゼロ（なし）で、待つ相手が自動レーンなら、委譲済みの正当な待機なので除外する。
// 委譲の起動語が同じメッセージに無くてもよい（フッターだけの応答は起動を別ターンで報告している）。
const HANDOFF_NONE_LINE = /次に\s*kim\s*がすること[:：][ \t*_`]*(?:なし|特になし|ありません|無し)/;
const LANE_NAME = /(Codex|codex-do|cheap-code|llm-ask|Gemini|DeepSeek|Groq|OpenRouter|Mistral|Kimi|GLM|サブエージェント)/;
const EXTERNAL_WAIT_SUBJECT = /(お客様|客様|顧客|取引先|先方|問い?合わ?せ|サブエージェント)/;
// 2026-11-02T04:31:09.948Z（handoff-audit:9b11ce35d2bc6d3a / 6b41b59b / W）の原文は
// 「雇保の喪失届は、10月度の給与データが取り込まれるのを待っている状態です」で拾えたが、
// 同じセッションが 04:08〜04:30 に書いた言い換え（「10月分の賃金が入れられず途中で止めています」
// 「10月度の給与データはまだ未登録でした」「雇保は…そこで止まっています」）は全て素通りした。
// 給与・勤怠など社内データの取込待ちは、Claude が取込を実行できるか取込後に自動で続けられる
// 作業なので、待機の言い換えごと W に含める。外部（お客様・取引先）の入金待ちは正当な待機なので
// 対象語をデータ種別に限る。過去形の報告（「…を取り込みました」「…を確認しました」）は
// 「再開・続き・止まっています」など未了を示す語を要求して除外する。
const DATA_SUBJECT = '(?:給与|賃金|勤怠|明細|データ|CSV|シート)';
const DATA_WAIT = [
  // 取込待ちです／取込を待っています／反映待ちの状態です
  `${DATA_SUBJECT}[^」"'\\n]{0,15}(?:取込|取り込み|登録|反映)(?:を)?待ち(?:です|ます|の状態|中)?`,
  // 取り込まれたら再開します／登録され次第、続きをやります／入るまで止めています
  `${DATA_SUBJECT}[^」"'\\n]{0,25}(?:取り込まれ|登録され|反映され|入り|入る|揃い|揃う)(?:たら|次第|まで|までは)[^」"'\\n]{0,20}(?:再開|続き|進め|始め|埋め|止め)`,
  // 給与データが揃うのを待って、賃金表を埋めます
  `${DATA_SUBJECT}[^」"'\\n]{0,25}のを待って[、,][^」"'\\n]{0,20}(?:再開|続き|進め|始め|埋め|止め|実行|作り|作る|登録)`,
  // 10月度の給与データが未登録のため、そこで止まっています
  `(?:未登録|未取込|未反映)[^」"'\\n]{0,15}(?:ため|ので|で)[^」"'\\n]{0,12}(?:止まって(?:います|いる|おり)|止めています|中断|進め(?:ません|られ)|入れられ)`,
  // 10月分の賃金が入れられず途中で止めています
  `(?:賃金|給与)[^」"'\\n]{0,12}(?:が|を)?入れられ(?:ず|ません|ない)[^」"'\\n]{0,20}(?:止まって(?:います|いる|おり)|止めています|中断|保留)`
].join('|');
const DATA_WAIT_RE = new RegExp(DATA_WAIT);
const W  = {
  find(text) {
    for (const match of text.matchAll(new RegExp(`(数分|しばらく|少し|少々)[^」"'\\n]{0,20}(お?待ち|待って)|完了を?待って|完了を待ち(?:ます|、)|完了待ちで|[^\\s」"'\\n]{0,30}?のを待って(?:います|ます|いる|おります)|${REPLY_WAIT.source}|${ARRIVAL_WAIT.source}|${LANE_STATUS_WAIT.source}|${DATA_WAIT}`, 'g'))) {
      if (isAuditCitation(text, match.index) || isPatternNameQuote(text, match.index)) continue;
      // 別セッションの待機文を引用した検証・報告と、待機対象が無い旨の否定は W にしない。
      // 一方、返事や完了通知が未着、作業が未完了という否定は待機継続なので残す。
      const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
      const lineEndAt = text.indexOf('\n', match.index);
      const lineEnd = lineEndAt < 0 ? text.length : lineEndAt;
      const line = text.slice(lineStart, lineEnd);
      const quoteStart = text.lastIndexOf('「', match.index);
      const quoteEnd = quoteStart < 0 ? -1 : text.indexOf('」', match.index);
      const inQuote = quoteStart >= lineStart && quoteEnd >= match.index && quoteEnd < lineEnd;
      const clauseStart = Math.max(lineStart, text.lastIndexOf('。', match.index - 1) + 1, text.lastIndexOf('|', match.index - 1) + 1);
      const periodEnd = text.indexOf('。', match.index);
      const pipeEnd = text.indexOf('|', match.index);
      const clauseEnd = Math.min(lineEnd, periodEnd < 0 ? lineEnd : periodEnd, pipeEnd < 0 ? lineEnd : pipeEnd);
      const clause = text.slice(clauseStart, clauseEnd).trim();
      const sessionId = /\b(?=[0-9a-f]{0,7}[a-f])[0-9a-f]{8}\b/i;
      if (inQuote && sessionId.test(clause)) continue;
      if (line.includes('|') && sessionId.test(line)) continue;
      if (/(?:ありません|ない|なし|いません)$/.test(clause)
          && !/(?:返事|返答|回答)[^。|\n]{0,20}(?:ありません|ない)$|(?:通知|連絡)[^。|\n]{0,20}(?:来て|届いて|着いて)いません$|(?:まだ[^。|\n]{0,12})?(?:終わって|完了して)いません$/.test(clause)) continue;
      if (REPLY_WAIT.test(match[0]) && EXTERNAL_WAIT_SUBJECT.test(text.slice(Math.max(0, match.index - 60), match.index))) continue;
      if (INBOX_RELAY.test(text.slice(Math.max(0, match.index - 200), match.index))) continue;
      if (DELEGATION_STARTED.test(text.slice(Math.max(0, match.index - 120), match.index + match[0].length + 120))) continue;
      if (ACTIVE_DELEGATION_CONTEXT.test(text) && SAME_SESSION_CONTINUATION.test(text)) continue;
      if (/CI\s*監視の完了待ち/.test(match[0])
          && /PR[^\n]{0,500}(?:作成|auto-merge[^\n]{0,30}(?:有効|設定))/.test(text)) continue;
      if (LANE_NAME.test(text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60)) && HANDOFF_NONE_LINE.test(text.slice(Math.max(0, match.index - 200), match.index))) continue;
      if (DATA_WAIT_RE.test(match[0]) && EXTERNAL_WAIT_SUBJECT.test(text.slice(Math.max(0, match.index - 40), match.index))) continue;
      return match;
    }
    return null;
  }
};
const FIX = '実装|修正|改修|恒久|恒久化|修復|作り直';
const HANDOFF_LINE = /次に\s*kim\s*がすること[:：][ \t*_`]*([^\r\n]*)/;
// 2026-10-17T06:40:46.164Z / session 3694d684: 太字ラベル直後の「特になし」を P3 と誤検出した。
const HANDOFF_EMPTY = /^[\s*_`]*(?:なし|ありません|ありません。|特になし|無し)/;
// 「main へのマージ／着地の承認」を kim に渡す手渡しも P3 とする。FIX 語（修正・実装…）が無くても、
// 具体的なコミット/branch を名指しして着地の承認を求める文は Claude が PR+automerge で実行できる作業で、
// 人に渡すべき手順ではない。実測（2026-10-23T07:23:51Z / 342a5479、2026-10-24T04:36:20Z / 61af55b9）では
// FIX 語が無いため P3 も next-action-gate も素通りし、同じ先送りが 2 日続いた。
// 対象語を「具体的な識別子（7桁以上の hex / slash を含む branch 風トークン）」に限るのは、
// 既存の非該当例 `PR #14 を確認（マージ判断のみ）`（確認作業の依頼）を巻き込まないため。
const LANDING_DEFERRAL = /(マージ|着地|取り込|merge)/i;
const LANDING_TARGET = /\b[0-9a-f]{7,40}\b|[\w.-]+\/[\w.-]+/;
const LANDING_APPROVAL = /(承認|判断|決め|指示|ください|返す|据え置き|待ち)/;
const REQUIRED_APPROVAL_CONTEXT = /(?:automerge[^。\n]{0,30}(?:ラベル)?(?:が|は)?(?:無い|ない|無し)|(?:全PC|全アカウント)[^。\n]{0,40}(?:配られ|配布され)|draft(?:\s*PR)?[^。\n]{0,80}(?:(?:merge|マージ)[^。\n]{0,20})?(?:拒否|できない|不可|マージしない|解除してまで)|無人セッション[^。\n]{0,100}(?:本番反映|マージ)[^。\n]{0,50}(?:禁止|承認待ち|保留))/i;
function hasRequiredApprovalContext(text) {
  return REQUIRED_APPROVAL_CONTEXT.test(text)
    || (/draft/i.test(text) && /マージしない/.test(text))
    || (/本番反映/.test(text) && /(?:禁止|承認待ち)/.test(text))
    || (/無人セッション/.test(text) && /本番反映[^。\n]{0,40}禁止/.test(text));
}
export function isLandingDeferral(value) {
  const text = String(value ?? '');
  return LANDING_DEFERRAL.test(text) && LANDING_TARGET.test(text) && LANDING_APPROVAL.test(text);
}
// 「可否」は裸では実現可能性の名詞（実行可否/利用可否/復旧の可否）で誤検出になるため、
// 許可要求の形（疑問節「か」＋可否）に限定する。
const ASK_PERMISSION = /(やりますか|進めますか|進めてよいか|よろしいですか|(?<=か)の?可否|判断してください|決めてください|選んでください)/;
const ASK_CONTEXT = /(恒久|配布|自動修復|実装|修正|改修|恒久化)/;
const NON_BLOCKING_ANSWER = /(?:答え|回答)(?:が|が来|が無く|なく|なくて|なくとも)[^。\n]{0,50}(?:修正|実装)[^。\n]{0,30}(?:自動|進み|進め)/;
const P3 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(HANDOFF_LINE, 'g'))) {
      // A final report can put the approval constraint in section 1 and the
      // handoff in section 3, well beyond a fixed character window.
      const context = text;
      if (!isAuditCitation(text, match.index) && !hasRequiredApprovalContext(context) && !NON_BLOCKING_ANSWER.test(context) && !HANDOFF_EMPTY.test(match[1]) && (new RegExp(FIX).test(match[1]) || isLandingDeferral(match[1]))) return match;
    }
    return null;
  }
};
const P4 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(ASK_PERMISSION, 'g'))) {
      const context = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
      const approvalContext = text;
      if (!isAuditCitation(text, match.index) && !hasRequiredApprovalContext(approvalContext) && ASK_CONTEXT.test(context)) return match;
    }
    return null;
  }
};
export const PATTERNS = { P1, P2, P3, P4, W };

export function detect(text) {
  return Object.entries(PATTERNS).map(([pattern, regex]) => {
    const match = typeof regex.find === 'function' ? regex.find(text) : regex.exec(text);
    return match ? { pattern, match } : null;
  }).filter(Boolean).sort((a, b) => a.match.index - b.match.index);
}

const DEFAULT_SINCE = '1970-01-01T00:00:00Z';
const NAMES = ['stop-gate-runner-ledger.jsonl', 'handoff-audit-ledger.jsonl', 'handoff-audit-nightly-ledger.jsonl'];
const CROSS_SESSION_WINDOW_MS = 72 * 60 * 60 * 1000;
const COMPLETION_WORD = /(?:マージ済み|MERGED|着地|merged|squash)/i;
const BRANCH_PREFIX = '(?:fix|feat|feature|chore|refactor|hotfix|bugfix|release|revert|docs|test|ci|perf|build)';

export function extractIdentifiers(text) {
  const identifiers = new Set();
  const value = String(text ?? '');
  for (const match of value.matchAll(/(?:#(\d+)|\bPR\s*#?(\d+)\b|\bpull\/(\d+)\b)/gi)) {
    identifiers.add(`pr:${match[1] ?? match[2] ?? match[3]}`);
  }
  for (const match of value.matchAll(new RegExp(`(?:^|[\\s\`'\"\uff08(])(${BRANCH_PREFIX}\/[A-Za-z0-9._/-]+)`, 'gi'))) {
    identifiers.add(`branch:${match[1].replace(/[.,;:!?)\uff09\u3001\u3002]+$/, '')}`);
  }
  return [...identifiers];
}

function identifierAppears(text, identifier) {
  return extractIdentifiers(text).some(value => value.toLowerCase() === identifier.toLowerCase());
}

function assistantTexts(transcript, { before = Infinity, limit = Infinity } = {}) {
  const messages = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.timestamp);
    if (entry?.type !== 'assistant' || !Number.isFinite(at) || at > before) continue;
    const text = Array.isArray(entry.message?.content)
      ? entry.message.content.map(item => {
          if (item?.type === 'text' && typeof item.text === 'string') return item.text;
          // Branch/PR identifiers often first appear in the assistant's tool
          // invocation rather than its prose. Task IDs remain excluded because
          // extractIdentifiers only accepts PR and conservative branch forms.
          if (item?.type === 'tool_use' && item.input) return JSON.stringify(item.input);
          return '';
        }).filter(Boolean).join('\n')
      : typeof entry.message?.content === 'string' ? entry.message.content : '';
    if (text) messages.push({ at, text });
  }
  messages.sort((a, b) => a.at - b.at);
  return messages.slice(-limit);
}

function assistantTextImmediatelyBefore(transcript, rowTs, maxAgeMs = 2 * 60 * 1000) {
  const rowTime = Date.parse(rowTs);
  const messages = assistantTexts(transcript, { before: rowTime });
  const latest = messages.at(-1);
  return latest && rowTime - latest.at <= maxAgeMs ? latest.text : null;
}

function assistantTextContaining(transcript, fragment) {
  if (!fragment) return null;
  const messages = assistantTexts(transcript);
  return messages.findLast(message => message.text.includes(fragment))?.text ?? null;
}

function listTranscripts(projectsDir, archiveDir) {
  const files = [];
  for (const root of [projectsDir, archiveDir]) {
    let projects;
    try { projects = fs.readdirSync(root, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const dir = path.join(root, project.name);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(dir, entry.name));
      }
    }
  }
  return files;
}

function findTranscript(projectsDir, sessionId, archiveDir) {
  if (!sessionId) return null;
  let projects;
  try { projects = fs.readdirSync(projectsDir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (projects) {
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = path.join(projectsDir, project.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
  }
  // Fall back to archive directory (projects-archive sibling)
  if (!archiveDir) return null;
  let archiveProjects;
  try { archiveProjects = fs.readdirSync(archiveDir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const project of archiveProjects) {
    if (!project.isDirectory()) continue;
    const file = path.join(archiveDir, project.name, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function hasTextContent(content) {
  return Array.isArray(content) && content.some(item => item?.type === 'text' && typeof item.text === 'string' && item.text.length > 0);
}

export function resolvedWait(transcript, rowTs) {
  const rowTime = Date.parse(rowTs);
  const entries = [];
  for (const line of fs.readFileSync(transcript, 'utf8').split(/\r?\n/)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const at = Date.parse(entry?.timestamp);
    if (!(at > rowTime)) continue;
    entries.push({ entry, at });
  }
  // Two-pass because transcript timestamps aren't monotonically increasing per
  // line order (e.g. attachment with queued_command appears later but has an
  // earlier timestamp). First pass: find the earliest notification timestamp.
  let notifiedAt = null;
  for (const { entry, at } of entries) {
    const isNotification =
      (entry.type === 'user' && JSON.stringify(entry.message?.content ?? '').includes('task-notification')) ||
      (entry.type === 'queue-operation' && typeof entry.content === 'string' && entry.content.includes('task-notification')) ||
      (entry.type === 'attachment' && entry.attachment?.type === 'queued_command' && typeof entry.attachment?.prompt === 'string' && entry.attachment.prompt.includes('task-notification'));
    if (isNotification && (notifiedAt === null || at < notifiedAt)) notifiedAt = at;
  }
  if (notifiedAt === null) return false;
  // Second pass: check for assistant text response after the notification.
  for (const { entry, at } of entries) {
    if (at > notifiedAt && entry.type === 'assistant' && hasTextContent(entry.message?.content)) return true;
  }
  return false;
}

export function scan({ home = os.homedir(), since = DEFAULT_SINCE, until = null,
  projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(home, '.claude', 'projects'),
  archiveDir } = {}) {
  if (archiveDir === undefined) {
    archiveDir = process.env.CLAUDE_PROJECTS_ARCHIVE_DIR || path.join(path.dirname(projectsDir), 'projects-archive');
  }
  const transcriptCache = new Map();
  let allTranscripts = null;
  const assistantTextCache = new Map();
  function crossSessionResolution(row, waitContext, originTranscript) {
    const rowTime = Date.parse(row.ts);
    let identifiers = extractIdentifiers(waitContext);
    // A quoted wait from another session is evidence being discussed, not the
    // current work. Do not borrow an unrelated identifier from nearby turns.
    const referencesAnotherSession = /セッション\s+[0-9a-f]{8}\b/i.test(waitContext);
    if (identifiers.length === 0 && originTranscript && !referencesAnotherSession) {
      const recent = assistantTexts(originTranscript, { before: rowTime, limit: 20 });
      for (let i = recent.length - 1; i >= 0; i--) {
        identifiers = extractIdentifiers(recent[i].text);
        if (identifiers.length > 0) break;
      }
    }
    if (identifiers.length === 0) return null;
    allTranscripts ??= listTranscripts(projectsDir, archiveDir);
    const originPath = originTranscript ? path.resolve(originTranscript).toLowerCase() : null;
    let best = null;
    for (const transcript of allTranscripts) {
      if ((originPath && path.resolve(transcript).toLowerCase() === originPath)
          || path.basename(transcript, '.jsonl') === row.sessionId) continue;
      let messages = assistantTextCache.get(transcript);
      if (!messages) {
        messages = assistantTexts(transcript);
        assistantTextCache.set(transcript, messages);
      }
      for (const message of messages) {
        if (!(message.at > rowTime && message.at <= rowTime + CROSS_SESSION_WINDOW_MS) || !COMPLETION_WORD.test(message.text)) continue;
        const identifier = identifiers.find(value => identifierAppears(message.text, value));
        if (!identifier || (best && best.at <= message.at)) continue;
        best = { at: message.at, identifier, resolvedBy: path.basename(transcript, '.jsonl') };
      }
    }
    return best;
  }
  const sources = NAMES.map((name, index) => {
    const file = path.join(home, '.claude', name);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const rows = [], counts = {};
    const byPattern = Object.fromEntries(Object.keys(PATTERNS).map(pattern => [pattern, 0]));
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry) continue;
      const at = Date.parse(entry.ts);
      if (!(at >= Date.parse(since)) || (until !== null && !(at < Date.parse(until)))) continue;
      const candidates = index === 0
        ? [{ text: String(entry.excerpt ?? ''), field: 'quote' }]
        : [
            ...(Array.isArray(entry.violations) ? entry.violations : []).map(v => ({ text: String(v?.quote ?? ''), field: 'quote' })),
            { text: String(entry.excerpt ?? ''), field: 'excerpt' }
          ];
      let text = '';
      let found = null;
      let foundField = 'quote';
      for (const { text: t, field } of candidates) {
        found = detect(t)[0];
        if (found?.pattern === 'P3') {
          const sessionId = String(entry.sessionId ?? '');
          if (!transcriptCache.has(sessionId)) transcriptCache.set(sessionId, findTranscript(projectsDir, sessionId, archiveDir));
          const transcript = transcriptCache.get(sessionId);
          const fullMessage = transcript && (assistantTextImmediatelyBefore(transcript, entry.ts)
            || assistantTextContaining(transcript, found.match[0]));
          // The ledger excerpt is truncated around the match. Re-evaluate P3 on
          // the originating assistant message so approval constraints earlier
          // in the same message (draft / all-PC rollout / no automerge) survive.
          if (fullMessage && !detect(fullMessage).some(hit => hit.pattern === 'P3')) {
            found = null;
            continue;
          }
        }
        if (found) {
          text = t;
          foundField = field;
          break;
        }
      }
      if (!found) continue;
      const { pattern, match } = found;
      const row = { pattern, field: foundField, ts: entry.ts, verdict: entry.verdict ?? entry.decision ?? '', sessionId: String(entry.sessionId ?? ''),
        match: text.slice(Math.max(0, match.index - 45), match.index + match[0].length + 110).replace(/[\r\n]+/g, ' ') };
      if (pattern === 'W') {
        if (!transcriptCache.has(row.sessionId)) transcriptCache.set(row.sessionId, findTranscript(projectsDir, row.sessionId, archiveDir));
        const transcript = transcriptCache.get(row.sessionId);
        // 2026-11-19T18:06Z / 6a5e38de は通知後に最終報告まで進んだため、
        // 同一セッション内で解消した一時的な委譲待ちは監査件数から外す。
        if (!transcript) row.resolved = 'unknown';
        else if (resolvedWait(transcript, row.ts)) row.resolved = 'in-session';
        if (row.resolved !== 'in-session') {
          const waitContext = text.slice(Math.max(0, match.index - 300), match.index + match[0].length + 300);
          const resolution = crossSessionResolution(row, waitContext, transcript);
          if (resolution) {
            row.resolved = 'cross-session';
            row.resolvedBy = resolution.resolvedBy;
            row.identifier = resolution.identifier;
          }
        }
      }
      rows.push(row);
      if (row.resolved === 'in-session' || row.resolved === 'cross-session') continue;
      byPattern[pattern]++;
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
    }
    return { name, file, total: lines.length, hits: rows.filter(row => !['in-session', 'cross-session'].includes(row.resolved)).length, byPattern, byDay: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), rows };
  });
  return { since, sources };
}

function validIso(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  return date.toISOString().slice(0, 10) === value.slice(0, 10);
}
export function main(args = process.argv.slice(2)) {
  let since = DEFAULT_SINCE, until = null, json = false, showResolved = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--show-resolved') showResolved = true;
    else if (args[i] === '--since' && validIso(args[i + 1] ?? '')) since = args[++i];
    else if (args[i] === '--until' && validIso(args[i + 1] ?? '')) until = args[++i];
    else {
      console.error('Usage: node tools/permanent-fix-deferral-scan.mjs [--since <ISO>] [--until <ISO>] [--json] [--show-resolved]');
      return 2;
    }
  }
  try {
    const report = scan({ since, until });
    if (json) console.log(JSON.stringify(report, null, 2));
    else for (const source of report.sources) {
      console.log(`${source.name}: hits=${source.hits} / ${source.total}`);
      console.log(Object.entries(source.byPattern).map(([pattern, count]) => `${pattern}:${count}`).join(' '));
      console.log(Object.entries(source.byDay).map(([day, count]) => `${day}:${count}`).join(' '));
      for (const row of source.rows) {
        if (['in-session', 'cross-session'].includes(row.resolved) && !showResolved) continue;
        const resolution = row.resolvedBy ? ` resolvedBy=${row.resolvedBy} identifier=${row.identifier}` : '';
        console.log(`${row.ts} ${row.verdict} ${row.sessionId.slice(0, 8)}${row.resolved ? ` resolved=${row.resolved}` : ''}${resolution}  …${row.match}…`);
      }
    }
  } catch (error) { console.error(`permanent-fix-deferral-scan: ${error.message}`); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();
