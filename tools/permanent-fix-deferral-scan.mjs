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
const P1_BASE = /(恒久|改修|実装|修正|対応|恒久化)[^」"'\n]{0,60}?(次セッション|次回セッション|次回に|後日|来週|(?<!の)先送り(?!文))/;
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
const P2 = { find: text => auditAwareFind(/(次セッション|次回セッション|次回に|後日)[^」"'\n]{0,60}(実装|対応|修正|改修|恒久)/, text) };
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
const ARRIVAL_WAIT = /(?:終わる|終わった|完了する|完了した|マージされ(?:る|た))[^」"'\n]{0,20}(?:自動で)?(?:知らせ|通知|連絡)が(?:届|来|着)|(?:知らせ|通知|連絡)が(?:届|来|着)[^」"'\n]{0,20}(?:まで)?待|届き次第(?:検証|確認|対応|報告)|(?:結果|完了|終了)(?:が|を)?(?:出|戻っ|返っ|揃っ|届い|着い)(?:たら|次第)[^」"'\n]{0,20}(?:報告|お知らせ|共有|連絡)|(?:終わり|完了|終了)次第[^」"'\n]{0,20}(?:報告|お伝え|お知らせ|共有|連絡)|(?:PR|マージ|取り込み)[^」"'\n]{0,20}を待って(?:います|いる|ます|おります)/;
const LANE_STATUS_WAIT = /(?:セッション|Codex|codex-do|他AI|レーン)[^\n」"']{0,60}?(?:完了は?まだ|まだ完了|まだ実行中|完了待ち|結果を待って|(?:している|ている|待っている|動いている|走っている)ところです|(?:している|ている)最中|を待っています|を待っている)/;
const W  = { find: text => auditAwareFind(new RegExp(`(数分|しばらく|少し|少々)[^」"'\\n]{0,20}(お?待ち|待って)|完了を?待って|完了待ちで|[^\\s」"'\\n]{0,30}?のを待って(?:います|ます|いる|おります)|${ARRIVAL_WAIT.source}|${LANE_STATUS_WAIT.source}`), text) };
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
export function isLandingDeferral(value) {
  const text = String(value ?? '');
  return LANDING_DEFERRAL.test(text) && LANDING_TARGET.test(text) && LANDING_APPROVAL.test(text);
}
// 「可否」は裸では実現可能性の名詞（実行可否/利用可否/復旧の可否）で誤検出になるため、
// 許可要求の形（疑問節「か」＋可否）に限定する。
const ASK_PERMISSION = /(やりますか|進めますか|進めてよいか|よろしいですか|(?<=か)の?可否|判断してください|決めてください|選んでください)/;
const ASK_CONTEXT = /(恒久|配布|自動修復|実装|修正|改修|恒久化)/;
const P3 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(HANDOFF_LINE, 'g'))) {
      if (!isAuditCitation(text, match.index) && !HANDOFF_EMPTY.test(match[1]) && (new RegExp(FIX).test(match[1]) || isLandingDeferral(match[1]))) return match;
    }
    return null;
  }
};
const P4 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(ASK_PERMISSION, 'g'))) {
      const context = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 60);
      if (!isAuditCitation(text, match.index) && ASK_CONTEXT.test(context)) return match;
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

export function scan({ home = os.homedir(), since = DEFAULT_SINCE, until = null } = {}) {
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
      const quotes = index === 0 ? [String(entry.excerpt ?? '')]
        : (Array.isArray(entry.violations) ? entry.violations : []).map(v => String(v?.quote ?? ''));
      let text = '';
      let found = null;
      for (const quote of quotes) {
        found = detect(quote)[0];
        if (found) {
          text = quote;
          break;
        }
      }
      if (!found) continue;
      const { pattern, match } = found;
      byPattern[pattern]++;
      const day = new Date(entry.ts).toISOString().slice(0, 10);
      counts[day] = (counts[day] || 0) + 1;
      rows.push({ pattern, ts: entry.ts, verdict: entry.verdict ?? entry.decision ?? '', sessionId: String(entry.sessionId ?? ''),
        match: text.slice(Math.max(0, match.index - 45), match.index + match[0].length + 110).replace(/[\r\n]+/g, ' ') });
    }
    return { name, file, total: lines.length, hits: rows.length, byPattern, byDay: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), rows };
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
  let since = DEFAULT_SINCE, until = null, json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--since' && validIso(args[i + 1] ?? '')) since = args[++i];
    else if (args[i] === '--until' && validIso(args[i + 1] ?? '')) until = args[++i];
    else {
      console.error('Usage: node tools/permanent-fix-deferral-scan.mjs [--since <ISO>] [--until <ISO>] [--json]');
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
      for (const row of source.rows) console.log(`${row.ts} ${row.verdict} ${row.sessionId.slice(0, 8)}  …${row.match}…`);
    }
  } catch (error) { console.error(`permanent-fix-deferral-scan: ${error.message}`); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();
