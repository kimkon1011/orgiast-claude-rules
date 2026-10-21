// executor-usage.jsonl のタイムアウト行から「捨てた秒数」を判定する。
//
// 背景: 2026-10-13 に fallback の 1 試行が 4953 秒動き、チェーン全体で 6153 秒を捨てた。
// #765 で killProcessTree（プロセス木ごと殺す）を入れ、#773 で 1 バックエンドの上限を
// 600→900 秒へ上げ、連鎖予算（chainBackendBudgetSecs）を入れた。修正が配備された後に
// タイムアウトが再発したとき、「捨てた秒数が 900 秒級に収まっているか」を台帳から機械判定する。
//
// 判定の述語は status === 'timeout' || timedOut === true。
// chain[].outcome だけを見ると、chain を持たない単一バックエンドの timeout 行
// （例: 2026-10-15T15:50:25Z / codex / 540.621 秒）を取り落とす。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const TIMEOUT_FIX_MERGED_AT = '2026-10-16T18:50:03Z'; // #773（600→900秒＋連鎖予算）
// フォールバック試行に与える既定予算。--cap で上書きできる。
// 主経路（chain 無し）はこれではなく、その実行に与えた --timeout（既定 1800 秒）で判定する。
export const DEFAULT_CAP_SECS = 900;
export const DEFAULT_PRIMARY_TIMEOUT_SECS = 1800; // codex-do の --timeout 既定
export const DEFAULT_TOLERANCE_SECS = 5;

export function isTimeoutRow(row) {
  return row?.status === 'timeout' || row?.timedOut === true;
}

function attemptBudgetSecs(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// timeout した試行ごとの秒数と、その試行に実際に与えた予算。
// chain があれば timeout した試行だけを返し、無い旧形式・単一バックエンドの行は
// 行そのもの（secs / timeoutSecs）を 1 試行として扱う。
// 予算は chain 試行なら budgetSecs（#773 以降の codex-do が記録）、無い旧行は --cap（900）。
// chain の無い主経路は timeoutSecs（--timeout 実値）、無い旧行は 1800 秒。
// 900 秒固定で主経路を見ると、既定 1800 秒を予定どおり使い切った行を上限破りと誤検出する
// （2026-10-20 実測: provider=codex / secs=1800.28 / chain 無し）。
export function timeoutAttempts(row, { fallbackBudgetSecs = DEFAULT_CAP_SECS } = {}) {
  const chain = Array.isArray(row?.chain) ? row.chain.filter((a) => a && a.outcome === 'timeout') : [];
  if (chain.length > 0) {
    return chain.map((a) => ({
      backend: a.backend ?? a.model ?? null,
      model: a.model ?? row?.model ?? null,
      secs: Number(a.secs),
      budgetSecs: attemptBudgetSecs(a.budgetSecs, fallbackBudgetSecs),
      path: 'fallback',
    }));
  }
  return [{
    backend: row?.provider ?? row?.model ?? null,
    model: row?.model ?? null,
    secs: Number(row?.secs),
    budgetSecs: attemptBudgetSecs(row?.timeoutSecs, DEFAULT_PRIMARY_TIMEOUT_SECS),
    path: 'primary',
  }];
}

export function judgeTimeoutRows(rows = [], {
  since = TIMEOUT_FIX_MERGED_AT,
  capSecs = DEFAULT_CAP_SECS,
  toleranceSecs = DEFAULT_TOLERANCE_SECS,
} = {}) {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) throw new Error(`--since は有効な ISO 日時を指定してください: ${since}`);
  if (!Number.isFinite(capSecs) || capSecs <= 0) throw new Error(`cap は正の秒数で指定してください: ${capSecs}`);
  if (!Number.isFinite(toleranceSecs) || toleranceSecs < 0) throw new Error(`tolerance は 0 以上の秒数で指定してください: ${toleranceSecs}`);

  const events = (Array.isArray(rows) ? rows : [])
    .filter(isTimeoutRow)
    .map((row) => {
      const at = Date.parse(row.t || row.timestamp || '');
      const attempts = timeoutAttempts(row, { fallbackBudgetSecs: capSecs });
      const known = attempts.filter((a) => Number.isFinite(a.secs));
      const wasteSecs = known.reduce((sum, a) => sum + a.secs, 0);
      const maxAttemptSecs = known.length ? Math.max(...known.map((a) => a.secs)) : null;
      const overCapAttempts = known
        .filter((a) => a.secs > a.budgetSecs + toleranceSecs)
        .map(({ backend, model, secs, budgetSecs, path }) => ({ backend, model, secs, budgetSecs, path }));
      return {
        t: Number.isFinite(at) ? new Date(at).toISOString() : null,
        provider: row.provider ?? null,
        model: row.model ?? null,
        origin: row.origin ?? null,
        postDeploy: Number.isFinite(at) && at >= sinceMs,
        attempts,
        wasteSecs,
        maxAttemptSecs,
        overCap: overCapAttempts.length > 0,
        overCapAttempts,
      };
    })
    .sort((a, b) => String(a.t).localeCompare(String(b.t)));

  const postDeploy = events.filter((e) => e.postDeploy);
  const overCapEvents = postDeploy.filter((e) => e.overCap);
  const verdict = postDeploy.length === 0
    ? 'unverified-no-recurrence'
    : overCapEvents.length > 0 ? 'waste-exceeds-cap' : 'waste-within-cap';

  return {
    since: new Date(sinceMs).toISOString(),
    capSecs,
    toleranceSecs,
    verdict,
    totalTimeoutRows: events.length,
    postDeployTimeoutRows: postDeploy.length,
    overCapRows: overCapEvents.length,
    maxAttemptSecs: postDeploy.length ? Math.max(...postDeploy.map((e) => e.maxAttemptSecs ?? 0)) : null,
    wasteSecs: postDeploy.reduce((sum, e) => sum + e.wasteSecs, 0),
    // 上限超過した試行のバックエンドと起動経路。翌晩の再発時に「どの経路が予算を守らなかったか」を
    // 証拠だけから特定できるようにする。
    overCapAttempts: overCapEvents.flatMap((e) => e.overCapAttempts.map((a) => ({ ...a, t: e.t, provider: e.provider }))),
    overCapBackends: [...new Set(overCapEvents.flatMap((e) => e.overCapAttempts.map((a) => a.backend)).filter(Boolean))],
    events,
  };
}

function parseArgs(argv) {
  const args = {
    ledger: process.env.EXECUTOR_USAGE_LEDGER || path.join(os.homedir(), '.claude', 'executor-usage.jsonl'),
    since: TIMEOUT_FIX_MERGED_AT,
    capSecs: DEFAULT_CAP_SECS,
    toleranceSecs: DEFAULT_TOLERANCE_SECS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ledger') args.ledger = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
    else if (argv[i] === '--cap') args.capSecs = Number(argv[++i]);
    else if (argv[i] === '--tolerance') args.toleranceSecs = Number(argv[++i]);
    else if (argv[i] === '--json') args.json = true;
    else throw new Error(`不明な引数: ${argv[i]}`);
  }
  return args;
}

function renderText(report) {
  const lines = ['## ⏱ タイムアウトで捨てた秒数の判定'];
  lines.push(`- 基準時刻(#773 マージ): ${report.since}`);
  lines.push(`- 上限: ${report.capSecs} 秒 + 許容 ${report.toleranceSecs} 秒`);
  if (report.verdict === 'unverified-no-recurrence') {
    lines.push(`- 判定: **未確認（再発なし）** — 基準時刻以降の timeout 行は 0 件（全期間 ${report.totalTimeoutRows} 件）`);
  } else {
    lines.push(`- 判定: **${report.verdict === 'waste-within-cap' ? '上限内' : '上限超過'}** — 再発 ${report.postDeployTimeoutRows} 件 / 上限超過 ${report.overCapRows} 件`);
    lines.push(`- 捨てた秒数 合計: ${Math.round(report.wasteSecs)} 秒 / 最大試行: ${report.maxAttemptSecs === null ? '不明' : Math.round(report.maxAttemptSecs)} 秒`);
  }
  for (const e of report.events) {
    const attempts = e.attempts.map((a) => `${a.backend ?? '不明'}=${Number.isFinite(a.secs) ? Math.round(a.secs) : '?'}秒${Number.isFinite(a.budgetSecs) ? `/予算${Math.round(a.budgetSecs)}秒` : ''}`).join(', ');
    lines.push(`- ${e.t ?? '日時不明'} / ${e.provider ?? '不明'} / ${e.postDeploy ? '配備後' : '配備前'} / ${attempts}${e.overCap ? ' / ⚠️ 上限超過' : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const text = fs.readFileSync(args.ledger, 'utf8');
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  const report = judgeTimeoutRows(rows, args);
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report));
  return report;
}

if (isEntry(import.meta.url)) main();
