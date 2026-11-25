#!/usr/bin/env node
// 手渡し文言（user に「実行してください」等を渡す文）が台帳に現れたとき、
// そこに provider 付きの verdict（LLM 判定）が付いているかを決定的に再走査する。
// handoff-audit:2ddd67033c25e70a の「再走査を実行する仕組み」を手作業からスクリプトに落としたもの。
// 読み取りのみ。送信・権限変更・本番デプロイはしない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

// 台帳ごとの「その行が手渡しを検査した結果」を表すフィールドが違う。
// handoff-audit-ledger: provider / fired / skipped、stop-gate-runner-ledger: blockedBy / demoted。
export const LEDGERS = [
  'handoff-audit-ledger.jsonl',
  'stop-gate-runner-ledger.jsonl',
  'handoff-audit-nightly-ledger.jsonl',
  'handoff-audit-deferral-ledger.jsonl',
];

// 手渡し文言の語彙。iteration 1〜11 で実際に使ったもの（script.new|GAS|clasp|Apps Script|.gs ×
// 実行してください|貼り付け|▶|kim がすること|1回実行）を、対象語に依存しない形へ一般化した。
const HANDOFF_PATTERNS = [
  { id: 'play-marker', re: /[▶►]\s*\S/ },
  { id: 'run-request', re: /(?:実行してください|実行して下さい|実行をお願いします|実行をお願いいたします)/ },
  { id: 'paste-request', re: /(?:貼り付けて|貼り付けをお願い|コピペして)/ },
  // 「GAS 1回実行の手渡し再発検証」のような案件名・目的文は命令ではない。依頼の形をしている時だけ拾う。
  { id: 'once-execution', re: /(?:1回|一度)(?:だけ)?実行(?:して|してください|をお願い|していただ|する必要)|手動で(?:実行|操作)(?:して|してください|をお願い)/ },
  // 「次に kim がすること: なし」は定型行なので拾わない。可変長 \s* を外に置くと
  // バックトラックで 0 文字一致して lookahead をすり抜けるため、否定先読みの中だけで消費する。
  { id: 'next-action-verbatim', re: /kim がすること[:：](?!\s*なし)/ },
];

// このループ自身の報告文（「台帳を走査した結果…手渡し文言の行はありません」）は、
// 手渡し文そのものではなく語彙の引用なので区別する。行単位で判定し、引用は quote に残す。
const SELF_REPORT = /(?:台帳|ledger|走査|再走査|スキャン)/;

export function matchHandoff(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    for (const p of HANDOFF_PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ pattern: p.id, quote: line.trim().slice(0, 300), selfReport: SELF_REPORT.test(line) });
        break; // 1行1ヒットで十分（同じ語彙の重複計上を避ける）
      }
    }
  }
  return hits;
}

// 反実仮想ハーネス（.loop/counterfactual*.mjs）は sessionId を `cf-` で始めて本番台帳へ行を書く。
// これは本番トラフィックではないので、台帳を読む側で除外する（除外数は totals に出す）。
// 2026-10-23 06:05Z の 3 行（cf-PRODUCTION / cf-FIXED / cf-FIXED-pass）が実際に混入した。
export function isSyntheticReplay(row) {
  const id = row?.sessionId;
  return typeof id === 'string' && id.startsWith('cf-');
}

export function verdictOf(row) {
  // handoff-audit-ledger: provider が入っていれば LLM 判定が走った行。
  // stop-gate-runner-ledger: blockedBy に handoff-audit-gate が入っていれば手渡し検査が止めた行。
  const provider = row.provider ?? null;
  const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
  const submitted = row.verdict ?? row.decision ?? null;
  // provider 名が入っていても verdict=audit-unavailable は「LLM に届かなかった」であって判定ではない。
  // これを判定済みに数えると、修正未着地のまま FINAL と誤認する（05:22:22Z / 05:43:41Z の 2 行が該当）。
  const providerUnavailable = submitted === 'audit-unavailable';
  const hasProviderVerdict = Boolean(provider)
    && row.fired !== false
    && row.skipped !== 'regex-blocked'
    && Boolean(submitted)
    && !providerUnavailable;
  return {
    provider,
    latencyMs: row.latencyMs ?? 0,
    fired: row.fired ?? null,
    skipped: row.skipped ?? null,
    verdict: submitted,
    providerUnavailable,
    blockedBy,
    blockedByHandoffAudit: blockedBy.includes('handoff-audit-gate'),
    hasProviderVerdict,
  };
}

export function scanRows(rows, opts = {}) {
  const since = opts.since ? Date.parse(opts.since) : -Infinity;
  const until = opts.until ? Date.parse(opts.until) : Infinity;
  if (Number.isNaN(since) || Number.isNaN(until)) throw new Error('since/until は ISO 8601 で指定する');
  const hits = [];
  let inWindow = 0;
  let synthetic = 0;
  for (const row of rows) {
    const ts = Date.parse(row?.ts);
    if (Number.isNaN(ts) || ts < since || ts > until) continue;
    inWindow += 1;
    if (isSyntheticReplay(row)) { synthetic += 1; continue; }
    const matched = matchHandoff(row.excerpt ?? row.text ?? '');
    if (!matched.length) continue;
    hits.push({ ts: row.ts, sessionId: row.sessionId ?? null, ...verdictOf(row), hits: matched });
  }
  return { inWindow, synthetic, hits };
}

export function summarize(results, opts = {}) {
  const all = results.flatMap(r => r.hits);
  const syntheticExcluded = results.reduce((n, r) => n + (r.synthetic ?? 0), 0);
  const handoffHits = all.filter(h => h.hits.some(m => !m.selfReport));
  const withProvider = handoffHits.filter(h => h.hasProviderVerdict);
  const providerUnavailable = handoffHits.filter(h => h.providerUnavailable);
  const blocked = handoffHits.filter(h => h.blockedByHandoffAudit);
  let verdict;
  if (!all.length) verdict = 'no-handoff-wording-in-window';
  else if (!handoffHits.length) verdict = 'only-self-report-echoes';
  else if (withProvider.length || blocked.length) verdict = 'handoff-wording-judged-with-provider';
  else verdict = 'handoff-wording-without-provider';
  return {
    window: { since: opts.since ?? null, until: opts.until ?? null },
    verdict,
    totals: {
      rowsMatched: all.length,
      selfReportEchoes: all.length - handoffHits.length,
      handoffWording: handoffHits.length,
      handoffWordingWithProviderVerdict: withProvider.length,
      handoffWordingProviderUnavailable: providerUnavailable.length,
      handoffWordingBlockedByHandoffAuditGate: blocked.length,
      syntheticReplaysExcluded: syntheticExcluded,
    },
    handoffHits,
  };
}

export function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split(/\r?\n/).flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}

export function defaultLedgerDir(env = process.env) {
  return env.ORGIAST_HOME ? path.join(env.ORGIAST_HOME, '.claude') : path.join(os.homedir(), '.claude');
}

export function scanFiles(dir, opts = {}) {
  const names = opts.ledgers ?? LEDGERS;
  return names.map(name => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) return { file, name, missing: true, inWindow: 0, synthetic: 0, hits: [] };
    const { inWindow, synthetic, hits } = scanRows(readJsonl(file), opts);
    return { file, name, missing: false, inWindow, synthetic, hits };
  });
}

function parseArgs(argv) {
  const args = { since: null, until: null, dir: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--since') args.since = argv[++i];
    else if (a === '--until') args.until = argv[++i];
    else if (a === '--ledger-dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return args;
}

const HELP = `usage: node tools/handoff-audit-rescan.mjs [--since ISO] [--until ISO] [--ledger-dir DIR] [--json]
台帳を読み、窓内の手渡し文言行に provider 付き verdict があるかを判定する（読み取りのみ）。
verdict: no-handoff-wording-in-window / only-self-report-echoes /
         handoff-wording-judged-with-provider / handoff-wording-without-provider`;

export function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) { console.log(HELP); return 0; }
  const dir = args.dir ?? defaultLedgerDir(env);
  const opts = { since: args.since, until: args.until };
  const results = scanFiles(dir, opts);
  const summary = summarize(results, opts);
  const report = {
    ...summary,
    ledgerDir: dir,
    ledgers: results.map(r => ({ name: r.name, missing: r.missing, inWindow: r.inWindow, hits: r.hits.length, syntheticExcluded: r.synthetic ?? 0 })),
  };
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`ledger dir: ${dir}`);
    console.log(`window: ${opts.since ?? '-inf'} .. ${opts.until ?? 'now'}`);
    for (const l of report.ledgers) console.log(`  ${l.name}: inWindow=${l.inWindow} hits=${l.hits} syntheticExcluded=${l.syntheticExcluded ?? 0}${l.missing ? ' (missing)' : ''}`);
    console.log(`verdict: ${report.verdict}`);
    console.log(`totals: ${JSON.stringify(report.totals)}`);
    for (const h of report.handoffHits) {
      console.log(`  HANDOFF ${h.ts} session=${h.sessionId} provider=${h.provider} verdict=${h.verdict} blockedBy=${JSON.stringify(h.blockedBy)} quote="${h.hits[0].quote}"`);
    }
  }
  return 0;
}

if (isEntry(import.meta.url, process.argv[1])) process.exitCode = main();
