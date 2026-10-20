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
const W  = { find: text => auditAwareFind(/(数分|しばらく|少し|少々)[^」"'\n]{0,20}(お?待ち|待って)|完了を?待って|完了待ちで/, text) };
const FIX = '恒久化|作り直|実装|修正|改修|恒久|修復';
const FIX_NOUN_PREFIX = /^(?:指示|点|内容|事項|案|方針|予定|項目|対象|箇所|など|等|方法|手順)/;
const HANDOFF_LINE = /次に\s*kim\s*がすること[:：][ \t*_`]*([^\r\n]*)/;
// 2026-10-17T06:40:46.164Z / session 3694d684: 太字ラベル直後の「特になし」を P3 と誤検出した。
const HANDOFF_EMPTY = /^[\s*_`]*(?:なし|ありません|ありません。|特になし|無し)/;
// 「可否」は裸では実現可能性の名詞（実行可否/利用可否/復旧の可否）で誤検出になるため、
// 許可要求の形（疑問節「か」＋可否）に限定する。
const ASK_PERMISSION = /(やりますか|進めますか|進めてよいか|よろしいですか|(?<=か)の?可否|判断してください|決めてください|選んでください)/;
const ASK_CONTEXT = /(恒久|配布|自動修復|実装|修正|改修|恒久化)/;
const P3 = {
  find(text) {
    for (const match of text.matchAll(new RegExp(HANDOFF_LINE, 'g'))) {
      if (isAuditCitation(text, match.index) || HANDOFF_EMPTY.test(match[1])) continue;
      // 実測7件はすべて「実装指示により」「修正点を返す」「数式修正など」のように、FIX 語が
      // 後続名詞を修飾する用法で、真の先送りは0件だった。行内に行為形が1つでもあれば従来どおり検出する。
      const fixes = [...match[1].matchAll(new RegExp(FIX, 'g'))];
      if (fixes.some(fix => !FIX_NOUN_PREFIX.test(match[1].slice(fix.index + fix[0].length)))) return match;
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
    let entries = lines.map(line => {
      let entry;
      try { entry = JSON.parse(line); } catch { return null; }
      return entry;
    }).filter(Boolean);
    if (index === 0) {
      // Stop フックはターンごとに同じ sessionId を追記する。実測例 8edc4e46 では
      // 2026-10-19T06:41:59.527Z の「Codex の完了を待っています」の後に実装・デプロイ・検証完了が
      // 記録されたため、経過行や blocked 行ではなく、ファイル全体で ts 最大の最終状態だけを検出する。
      const latestBySession = new Map();
      for (const entry of entries) {
        const sessionId = String(entry.sessionId ?? '');
        const previous = latestBySession.get(sessionId);
        if (!previous || Date.parse(entry.ts) > Date.parse(previous.ts)) latestBySession.set(sessionId, entry);
      }
      entries = [...latestBySession.values()];
    }
    for (const entry of entries) {
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
