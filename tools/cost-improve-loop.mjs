#!/usr/bin/env node
import fs from 'node:fs';
import { appendLineWithRetry } from './lib/append-line.mjs';
import { isEntry } from './is-entry.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchFleetKPIs, getClaudeDir } from './fleet-kpi-fetch.mjs';
import { notifyKim } from './notify-kim.mjs';
import { appendImprovementTodos } from './nightly-kpi.mjs';
import { KNOWN_CHEAP_PROVIDERS } from './llm-fallback.mjs';
import { collectProviderHealth, collectClaudeStats } from './usage-stats.mjs';
import { collectBudgetStatus } from './budget-status.mjs';
import { shouldSendMonthlyReport, buildMonthlyReport, markMonthlyReportSent } from './cost-monthly-report.mjs';
import { collectProviderBalances, formatBalanceLine, CREDIT_LOW_THRESHOLD } from './provider-balance.mjs';
import { resolveReporterLabel } from './reporter-label.mjs';
import { main as sendFleetDirective } from './fleet-directive-send.mjs';

export const ALLOWED_LOCAL_COMMANDS = [
  'node tools/tool-adoption-check.mjs --force',
  // 備考: onboarding-sync は #303 で unused_provider を human 化したため許可リストから外した(自動実行しない)。
  'node tools/register-hooks.mjs --hooks-only',
  // eval_stale 対処: eval-harness の再実行を夜間バッチへ投入する固定コマンド。
  // batch-run が kind=eval-harness をローカル実行(node tools/eval-harness.mjs --all)に変換する。
  'node tools/batch-enqueue.mjs --provider groq --kind eval-harness "eval-harness --all"'
];

// 許可リストの固定コマンド文字列を argv 配列へ割る(二重引用内は1要素。shell は通さない)。
export function splitWhitelistedCommand(command) {
  const parts = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || '')))) parts.push(match[1] ?? match[2]);
  return parts;
}

// B4 シグナル系 kind → 効果検証(verifyEffects)で追う metric。
export const SIGNAL_METRICS = Object.freeze({
  provider_unhealthy: 'failRate',
  codex_saturated: 'codexLimit24h',
  headless_claude: 'headlessClaudeOut',
  budget_pace: 'pacePercent',
  eval_stale: 'evalAgeDays',
  spend_anomaly: 'todaySpendUsd'
});

export function evaluateBalanceSignals(rows, { directProviders = ['deepseek', 'kimi'] } = {}) {
  const violations = [];
  for (const row of rows || []) {
    if (row.status === 'anomaly') violations.push({ kind: 'spend_anomaly', pc: 'self', severity: 'error', provider: row.provider, evidence: `${row.provider} today $${row.todaySpendUsd.toFixed(4)} > 2x 7d avg $${row.avg7dSpendUsd.toFixed(4)}`, actualValue: row.todaySpendUsd, targetValue: row.avg7dSpendUsd * 2, trusted: true });
    if (row.status === 'low') {
      if (Number.isFinite(row.credits)) {
        violations.push({ kind: 'balance_low', pc: 'self', severity: 'warning', provider: row.provider, evidence: `${row.provider} の前払いクレジットが ${row.credits}（閾値 ${CREDIT_LOW_THRESHOLD}）`, actualValue: row.credits, targetValue: CREDIT_LOW_THRESHOLD, trusted: true });
      } else if (row.autoTopUp !== true) {
        violations.push({ kind: 'balance_low', pc: 'self', severity: 'warning', provider: row.provider, evidence: `${row.provider} balance $${row.balanceUsd.toFixed(2)} (< $3), auto top-up unavailable`, actualValue: row.balanceUsd, targetValue: 3, trusted: true });
      }
    }
    if (row.autoTopUp === false && directProviders.includes(row.provider)) violations.push({ kind: 'autotopup_missing', pc: 'self', severity: 'warning', provider: row.provider, evidence: `${row.provider} has no auto top-up and remains a direct lane`, trusted: true });
  }
  return violations;
}

// §1.18 の通常運用で利用を期待する主経路だけを監視し、障害時専用の fallback は除外する。
export const PRIMARY_PROVIDERS = KNOWN_CHEAP_PROVIDERS;

function isRosterOnlyRow(row) {
  return !String(row?.reportedAt ?? '').trim()
    && !String(row?.label ?? '').trim()
    && !String(row?.hostname ?? '').trim();
}

// ---- 仕様C5: フリート名簿の同一機体エイリアスを stale 扱いしない ----
// fleet-pc-map.json(ラベル→hostname/aliases)から「同じ物理機を指す別表記」の索引を作る。
export function buildAliasIndex(map) {
  const index = new Map();
  if (!map || typeof map !== 'object' || Array.isArray(map)) return index;
  for (const [key, entry] of Object.entries(map)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const host = String(entry.hostname || entry.sheetName || '').trim() || String(key);
    index.set(String(key).trim().toLowerCase(), host);
    if (Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) index.set(String(alias).trim().toLowerCase(), host);
    }
  }
  return index;
}

// 同じホスト名(または alias 解決で同一物理機)を持つ行は「最新の報告がある1行」だけを採用し、
// 他は alias_of として集計・違反対象から外す。ホストが特定できない行はそのまま残す。
export function dedupeAliasRows(rows, aliasIndex, now = new Date()) {
  const chosen = [];
  const excluded = [];
  if (!Array.isArray(rows)) return { rows: chosen, excluded };
  const hostOf = (row) => {
    const hostname = String(row?.hostname ?? '').trim();
    if (hostname) return hostname.toLowerCase();
    for (const key of [row?.label, row?.pcName]) {
      const host = aliasIndex?.get(String(key || '').trim().toLowerCase());
      if (host) return String(host).toLowerCase();
    }
    return null;
  };
  const tsOf = (row) => {
    const t = Date.parse(String(row?.reportedAt || row?.t || ''));
    return Number.isFinite(t) ? t : 0;
  };
  const groups = new Map();
  for (const row of rows) {
    const host = hostOf(row);
    if (!host) { chosen.push(row); continue; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(row);
  }
  for (const [host, list] of groups) {
    if (list.length === 1) { chosen.push(list[0]); continue; }
    const sorted = [...list].sort((a, b) => tsOf(b) - tsOf(a));
    const primary = sorted[0];
    chosen.push(primary);
    for (const row of sorted.slice(1)) {
      excluded.push({ pc: row?.pcName || row?.label || '(名称未設定)', aliasOf: primary?.pcName || primary?.label || host, host, reportedAt: row?.reportedAt || '' });
    }
  }
  return { rows: chosen, excluded };
}

export function parseJstOrIsoDate(text) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return null;
  const jst = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(cleanText);
  if (jst) {
    const year = +jst[1];
    const month = +jst[2] - 1;
    const day = +jst[3];
    const localHour = +(jst[4] || 0);
    const min = +(jst[5] || 0);
    const sec = +(jst[6] || 0);
    if (month < 0 || month > 11 || day < 1 || localHour > 23 || min > 59 || sec > 59) return null;
    const check = new Date(Date.UTC(year, month, day));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) return null;
    return Date.UTC(year, month, day, localHour - 9, min, sec);
  }
  const isoDay = /^(\d{4})-(\d{2})-(\d{2})T/.exec(cleanText);
  if (isoDay) {
    const check = new Date(Date.UTC(+isoDay[1], +isoDay[2] - 1, +isoDay[3]));
    if (check.getUTCFullYear() !== +isoDay[1] || check.getUTCMonth() !== +isoDay[2] - 1 || check.getUTCDate() !== +isoDay[3]) return null;
    if (/T24:|T\d{2}:6\d|T\d{2}:\d{2}:6\d/.test(cleanText)) return null;
  }
  const parsed = Date.parse(cleanText);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePercent(text) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return null;
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(cleanText);
  if (match) {
    const percent = Number(match[1]);
    return percent >= 0 && percent <= 100 ? percent / 100 : null;
  }
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(cleanText)) return null;
  const floatVal = Number(cleanText);
  return floatVal >= 0 && floatVal <= 1 ? floatVal : null;
}

export function isOpusHeavy(row, localState) {
  if (localState && typeof localState.opusRatio === 'number') {
    return localState.opusRatio > 0.5;
  }
  if (row && typeof row.mainModel === 'string') {
    const mainModel = row.mainModel.toLowerCase();
    if (mainModel.includes('opus')) {
      const match = mainModel.match(/(\d+(?:\.\d+)?)\s*%/);
      if (match) {
        return parseFloat(match[1]) > 50;
      }
      return true;
    }
  }
  return false;
}

export function parseCheapAiUseCount(text) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText || cleanText === 'なし') return 0;
  let total = 0;
  const parts = cleanText.split(',');
  for (const part of parts) {
    const match = /:\s*(\d+)/.exec(part);
    if (match) {
      total += parseInt(match[1], 10);
    }
  }
  return total;
}

export function evaluateFleet({ rows, ledgerCounts, localState, now, lastKpis = {}, signals = null, aliasIndex = null }) {
  const violations = [];
  const measuredAt = now.toISOString();
  // 同一機体の別表記行は最新報告の1行だけを採用し、古い別表記行を stale 誤検知しない(仕様C5)。
  // hostname 列が同じ行は index が無くてもまとめる。fleet-pc-map.json の aliases は index で補う。
  if (Array.isArray(rows)) {
    rows = dedupeAliasRows(rows, aliasIndex, now).rows;
  }

  let fleetTrusted = true;
  let selfLedgerTrusted = true;
  let selfStateTrusted = true;

  if (!Array.isArray(rows) || rows.length === 0) {
    violations.push({
      kind: 'measurement_untrusted',
      pc: 'fleet',
      severity: 'error',
      evidence: Array.isArray(rows) ? 'fleet_empty: fleet returned no rows' : 'Failed to fetch fleet rows',
      measuredAt,
      trusted: false
    });
    fleetTrusted = false;
  }

  if (ledgerCounts === null) {
    violations.push({
      kind: 'measurement_untrusted',
      pc: 'self',
      severity: 'error',
      evidence: 'Failed to read local ledger',
      measuredAt,
      trusted: false
    });
    selfLedgerTrusted = false;
  }

  if (localState === null) {
    violations.push({
      kind: 'measurement_untrusted',
      pc: 'self',
      severity: 'error',
      evidence: 'Failed to read local cost-loop-state.json',
      measuredAt,
      trusted: false
    });
    selfStateTrusted = false;
  }

  const nonStaleRows = [];
  let totalDelegRatio = 0;
  let totalClaudeUsd = 0;
  let nonStaleCount = 0;

  if (fleetTrusted) {
    const fortyEightHoursAgo = now.getTime() - 48 * 3600 * 1000;

    for (const row of rows) {
      if (isRosterOnlyRow(row)) continue;
      const pcName = row.pcName || row.label || 'unknown';
      let stale = false;

      if (row.reportedAt && (row.livenessState === '生存' || row.livenessState === 'alive' || row.reportedAt.trim() !== '')) {
        const reportTime = parseJstOrIsoDate(row.reportedAt);
        if (reportTime && reportTime < fortyEightHoursAgo) {
          violations.push({
            kind: 'stale_report',
            pc: pcName,
            label: row.label,
            severity: 'warning',
            evidence: `Report is stale (last reported: ${row.reportedAt})`,
            measuredAt,
            trusted: true
          });
          stale = true;
        }
      } else {
        stale = true;
      }

      if (!stale) {
        nonStaleRows.push(row);
        const delegValue = parsePercent(row.delegRatio);
        const usdValue = String(row.claudeUsd ?? '').trim() === '' ? null : Number(row.claudeUsd);
        if (delegValue === null || !Number.isFinite(usdValue)) {
          violations.push({
            kind: 'measurement_untrusted',
            pc: pcName,
            severity: 'error',
            evidence: `Reported at ${row.reportedAt}, but delegation ratio or Claude USD is missing`,
            measuredAt,
            trusted: false
          });
        }
        if (delegValue !== null) {
          totalDelegRatio += delegValue;
          nonStaleCount++;
        }
        if (Number.isFinite(usdValue)) {
          totalClaudeUsd += usdValue;
        }
      }
    }
  }

  const avgDelegRatio = nonStaleCount ? totalDelegRatio / nonStaleCount : 0;
  const fleetStats = {
    avgDelegRatio,
    totalClaudeUsd,
    nonStaleCount
  };

  if (fleetTrusted) {
    for (const row of nonStaleRows) {
      const pcName = row.pcName || row.label || 'unknown';
      const isSelf = pcName.toLowerCase().includes('self') || pcName.toLowerCase().includes('local') || pcName === (localState?.pcName ?? '');

      const delegValue = parsePercent(row.delegRatio);
      if (delegValue !== null && delegValue < 0.5) {
        violations.push({
          kind: 'low_delegation',
          pc: pcName,
          severity: 'error',
          evidence: `Delegation ratio is ${row.delegRatio} (< 50%)`,
          measuredAt,
          actualValue: delegValue,
          targetValue: 0.5,
          trusted: true
        });
      }

      const hasOpusHeavy = isOpusHeavy(row, isSelf ? localState : null);
      if (hasOpusHeavy) {
        violations.push({
          kind: 'opus_heavy',
          pc: pcName,
          severity: 'warning',
          evidence: `Main model contains Opus (> 50% ratio)`,
          measuredAt,
          actualValue: isSelf && typeof localState?.opusRatio === 'number' ? localState.opusRatio : 1,
          targetValue: 0.5,
          trusted: true
        });
      }

      const prevKpi = lastKpis[pcName];
      if (prevKpi && typeof prevKpi.claudeUsd === 'number') {
        const currentUsd = parseFloat(row.claudeUsd);
        if (Number.isFinite(currentUsd) && currentUsd > prevKpi.claudeUsd * 1.3) {
          let workIncrease = false;
          if (isSelf && selfStateTrusted && typeof localState.work === 'number' && typeof prevKpi.work === 'number') {
            if (localState.work > prevKpi.work) {
              workIncrease = true;
            }
          }
          if (!workIncrease) {
            const increasePercent = (currentUsd / prevKpi.claudeUsd - 1) * 100;
            violations.push({
              kind: 'cost_spike',
              pc: pcName,
              severity: 'error',
              evidence: `Claude USD spiked by +30% (from $${prevKpi.claudeUsd} to $${currentUsd}) without work increase`,
              measuredAt,
              previousValue: prevKpi.claudeUsd,
              actualValue: currentUsd,
              increasePercent,
              trusted: true
            });
          }
        }
      }
    }
  }

  if (selfLedgerTrusted) {
    const cheapProviders = KNOWN_CHEAP_PROVIDERS;
    let cheapCount = 0;
    for (const [provider, count] of Object.entries(ledgerCounts)) {
      if (cheapProviders.includes(provider)) {
        cheapCount += count;
      }
    }
    if (cheapCount === 0) {
      violations.push({
        kind: 'no_cheap_ai',
        pc: 'self',
        severity: 'error',
        evidence: '0 cheap AI calls in last 7 days',
        measuredAt,
        trusted: true
      });
    }

    const configured = localState?.configuredProviders || [];
    for (const prov of configured) {
      if (PRIMARY_PROVIDERS.includes(prov) && (!ledgerCounts[prov] || ledgerCounts[prov] === 0)) {
        violations.push({
          kind: 'unused_provider',
          pc: 'self',
          severity: 'warning',
          evidence: `Provider '${prov}' is configured but has 0 calls in last 7 days`,
          measuredAt,
          trusted: true
        });
      }
    }
  }

  if (signals) {
    violations.push(...evaluateBalanceSignals(signals.providerBalances));
    // provider_unhealthy: 直近7日で failRate>=0.2 か http429>=50 の provider(codex=定額なので除外)。
    for (const [name, stats] of Object.entries(signals.providerHealth?.providers || {})) {
      if (String(name).toLowerCase() === 'codex') continue;
      const failRate = Number(stats?.failRate) || 0;
      const http429 = Number(stats?.http429) || 0;
      if (failRate >= 0.2 || http429 >= 50) {
        violations.push({
          kind: 'provider_unhealthy', pc: 'self', severity: 'warning',
          evidence: `Provider '${name}' unhealthy: failRate ${failRate.toFixed(2)} (threshold 0.20), http429 ${http429} (threshold 50) in last 7 days`,
          measuredAt, actualValue: failRate, targetValue: 0.2, provider: String(name).toLowerCase(), trusted: true
        });
      }
    }
    // codex_saturated: 直近24h の usage_limit 検出が2回以上。
    const codexLimit24h = Number(signals.codexLimit24h) || 0;
    if (codexLimit24h >= 2) {
      violations.push({
        kind: 'codex_saturated', pc: 'self', severity: 'warning',
        evidence: `Codex usage_limit detected ${codexLimit24h} times in last 24h (threshold 2)`,
        measuredAt, actualValue: codexLimit24h, targetValue: 1, trusted: true
      });
    }
    // headless_claude: 無人ジョブが Claude 課金 tier を直接使っている出力 > 0 (cheap-code経由は除外)。
    const headlessClaudeOut = Number(signals.headlessClaudeOut) || 0;
    if (headlessClaudeOut > 0) {
      violations.push({
        kind: 'headless_claude', pc: 'self', severity: 'warning',
        evidence: `Headless jobs used Claude-tier output ${headlessClaudeOut} tok in last 7 days (auto-session/next-session should run on cheap-code)`,
        measuredAt, actualValue: headlessClaudeOut, targetValue: 0, trusted: true
      });
    }
    // budget_pace: 月次予算の日割りペースが 100% 超(月末見込みで予算超え)。
    const budgetPacePct = Number(signals.budgetPacePct);
    if (Number.isFinite(budgetPacePct) && budgetPacePct > 100) {
      violations.push({
        kind: 'budget_pace', pc: 'self', severity: 'error',
        evidence: `Monthly budget pace is ${budgetPacePct.toFixed(1)}% (> 100%)`,
        measuredAt, actualValue: budgetPacePct, targetValue: 100, trusted: true
      });
    }
    // eval_stale: eval結果が7日超、または一度も無い。
    if (signals.evalAgeDays === null) {
      violations.push({
        kind: 'eval_stale', pc: 'self', severity: 'warning',
        evidence: 'eval-results.jsonl has no results (never run)',
        measuredAt, actualValue: null, targetValue: 7, trusted: true
      });
    } else {
      const evalAgeDays = Number(signals.evalAgeDays);
      if (Number.isFinite(evalAgeDays) && evalAgeDays > 7) {
        violations.push({
          kind: 'eval_stale', pc: 'self', severity: 'warning',
          evidence: `eval-harness results are ${Math.floor(evalAgeDays)} days old (threshold 7)`,
          measuredAt, actualValue: evalAgeDays, targetValue: 7, trusted: true
        });
      }
    }
  }

  return { pcs: nonStaleRows, fleet: fleetStats, violations };
}

export function sortViolationsBySeverity(violations) {
  const severityRank = { error: 2, warning: 1 };
  const kindRank = { measurement_untrusted: 0, low_delegation: 1, cost_spike: 2, no_cheap_ai: 3, opus_heavy: 4, stale_report: 5, unused_provider: 6, spend_anomaly: 7, balance_low: 8, autotopup_missing: 9, provider_unhealthy: 10, codex_saturated: 11, headless_claude: 12, budget_pace: 13, eval_stale: 14 };
  return [...violations].sort((a, b) => {
    const rankDifference = (severityRank[b.severity] ?? 0) - (severityRank[a.severity] ?? 0);
    if (rankDifference !== 0) return rankDifference;
    if (a.kind !== b.kind) return (kindRank[a.kind] ?? 99) - (kindRank[b.kind] ?? 99);
    if (a.kind === 'low_delegation') return (a.actualValue ?? Infinity) - (b.actualValue ?? Infinity);
    if (a.kind === 'opus_heavy') return (b.actualValue ?? -Infinity) - (a.actualValue ?? -Infinity);
    if (a.kind === 'cost_spike') return (b.actualValue ?? -Infinity) - (a.actualValue ?? -Infinity);
    return 0;
  });
}

const COMBINED_CODEX_INSTRUCTION = '以下は独立したN件の修正タスクです。それぞれ独立に原因調査・修正し、他のタスクの変更ファイルに触れないこと。1件でも原因を特定できなければ、そのタスクだけ見送り、残りは実施すること。';

export function buildCombinedCodexSpec(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return '';
  const total = actions.length;
  const instruction = COMBINED_CODEX_INSTRUCTION.replace('N件', `${total}件`);
  const tasks = actions.map((action, index) =>
    `## タスク ${index + 1}/${total}: ${action.kind} (${action.pc})\n\n${action.specContent ?? ''}`
  );
  return `${instruction}\n\n${tasks.join('\n\n')}\n`;
}

function humanTodoMessage(violation, now, retryCount = 0, retryMode = 'directive') {
  const pc = violation.pc;
  if (violation.kind === 'balance_low') {
    if (violation.provider === 'genspark') return `【このPC】Genspark の前払いクレジットが ${Math.round(Number(violation.actualValue))} です（閾値 ${CREDIT_LOW_THRESHOLD}）。Genspark にチャージするか、画像生成を止めるかの判断が必要です。`;
    const switched = ['deepseek', 'kimi'].includes(violation.provider) ? '切替済み' : '未切替';
    return `【このPC】${violation.provider} の残高が $${Number(violation.actualValue).toFixed(2)} です。自動チャージが無いプロバイダです。OpenRouter 経由へ${switched}。`;
  }
  if (violation.kind === 'stale_report') {
    const reportedAt = /last reported:\s*([^)]*)/.exec(violation.evidence)?.[1] || '日時不明';
    const reportedMs = parseJstOrIsoDate(reportedAt);
    const days = reportedMs === null ? '不明' : Math.max(0, Math.floor((now.getTime() - reportedMs) / 86400000));
    if (!retryCount) return `【${pc}】から${reportedAt}以降 KPI の自己申告が届いていません（${days}日間）。そのPCで Claude Code を起動できているか確認し、起動していれば ` + '`node tools/fleet-sheet-report.mjs`' + ' が夜間に走っているかを見てください。';
    return `【${pc}】から${reportedAt}以降 KPI の自己申告が届いていません（${days}日間）。自動再送（${retryMode}）を ${retryCount} 回試みたが復帰しないため、そのPCで Claude Code を1回起動してください。`;
  }
  if (violation.kind === 'cost_spike') {
    const previous = violation.previousValue ?? /from \$(\d+(?:\.\d+)?)/.exec(violation.evidence)?.[1] ?? '不明';
    const actual = violation.actualValue ?? /to \$(\d+(?:\.\d+)?)/.exec(violation.evidence)?.[1] ?? '不明';
    const increase = violation.increasePercent ?? (Number.isFinite(Number(previous)) && Number(previous) > 0 && Number.isFinite(Number(actual)) ? (Number(actual) / Number(previous) - 1) * 100 : null);
    return `【${pc}】の Claude 概算が $${previous} → $${actual} に増えています（${increase === null ? '増加率不明' : `+${increase.toFixed(1)}%`}）。作業量は増えていません。誤ルーティング、やり直し、Claude の呼びすぎがないか直近の作業を確認してください。`;
  }
  if (violation.kind === 'measurement_untrusted') {
    const reportedAt = /Reported at\s*([^,]+)/.exec(violation.evidence)?.[1];
    const situation = reportedAt
      ? `${reportedAt} に報告は来ていますが、委譲率またはコストの値が空です`
      : violation.pc === 'fleet'
        ? 'フリートの KPI を取得できていません'
        : 'このPCの計測ファイルまたは実行台帳を読み取れません';
    return `【${pc}】${situation}。計測できていないため、この値を根拠にした自動修正は見送りました。\`node tools/fleet-sheet-report.mjs\` を実行し、委譲率と Claude 概算が記録されるか確認してください。`;
  }
  if (violation.kind === 'budget_pace') {
    const pace = Number.isFinite(Number(violation.actualValue)) ? Number(violation.actualValue).toFixed(1) : '不明';
    return `【このPC】の月次AI予算ペースが ${pace}% に達しています（日割りで月末を見込むと予算超過。しきい値 100%）。cost-enforce.json に budgetPressure を立てて量産系ルーティングを夜間バッチへ寄せる自動対処は済ませました。急ぎでない分類・生成・一括処理は \`node tools/batch-enqueue.mjs --provider <groq|deepseek> "指示"\` で夜間(03:00・半額)へ回してください。`;
  }
  return `【${pc}】自動対処を完了できませんでした（実測: ${violation.evidence}）。状況を確認してください。`;
}

export function decideActions({ violations, state, now, limits = { maxCodex: 2 }, directiveSend = null, spawnSync = defaultSpawnSync, ownLabel = '', dryRun = false, repo = path.resolve(import.meta.dirname, '..') }) {
  const actions = [];
  const skipped = [];
  const nextActionsState = [...(state.actions || [])];
  const nextStaleRetry = { ...(state.staleRetry || {}) };
  let codexCount = 0;

  const PLAYBOOK = {
    no_cheap_ai: {
      mode: 'auto-local',
      command: 'node tools/tool-adoption-check.mjs --force'
    },
    unused_provider: {
      mode: 'human'
    },
    low_delegation: {
      mode: 'auto-codex',
      specTemplate: 'low_delegation'
    },
    opus_heavy: {
      mode: 'auto-codex',
      specTemplate: 'opus_heavy'
    },
    cost_spike: {
      mode: 'human'
    },
    stale_report: {
      mode: 'human'
    },
    measurement_untrusted: {
      mode: 'human'
    },
    // B4 (2026-09-07): ローカル信号由来の違反。auto-local は固定コマンド配列(shell無し)か
    // effect 関数(シート由来文字列を実行しない)のどちらかでだけ対処する。
    provider_unhealthy: {
      mode: 'auto-local',
      effect: 'writeRoutingOverride'
    },
    spend_anomaly: { mode: 'auto-local', effect: 'writeRoutingOverride' },
    balance_low: { mode: 'human' },
    autotopup_missing: { mode: 'auto-local', effect: 'writeGatewayOverride' },
    codex_saturated: {
      mode: 'auto-local',
      effect: 'writeCodexFallbackOrder'
    },
    headless_claude: {
      mode: 'auto-local',
      effect: 'writeAutoSessionExecutor'
    },
    budget_pace: {
      mode: 'human',
      localEffect: 'budgetPressure'
    },
    eval_stale: {
      mode: 'auto-local',
      command: 'node tools/batch-enqueue.mjs --provider groq --kind eval-harness "eval-harness --all"'
    }
  };

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // 計測が信用できない回は、コード修正の自動委譲を一切行わない。
  // 委譲率や Opus 比は「安いAIが何回呼ばれたか」の上に立つ数字なので、台帳が読めなかった回に
  // それを根拠として直しにいくと、存在しない問題を直すことになる(2026-09-06 の「使用0」誤報がまさにこれ)。
  // この回の仕事は、まず計測そのものを直すことに絞る。
  for (const violation of sortViolationsBySeverity(violations)) {
    const { kind, pc, evidence } = violation;
    const playbook = PLAYBOOK[kind];
    if (!playbook) continue;
    let retryFailed = false;
    if (kind === 'stale_report' && !nextStaleRetry[pc]) {
      const mode = (violation.label || pc) === ownLabel ? 'local' : 'directive';
      if (dryRun) {
        skipped.push({ kind, pc, reason: 'dry_run', note: `fleet-sheet-report 再送予定 (${mode})` });
        continue;
      }
      try {
        if (mode === 'local') {
          const result = spawnSync(process.execPath, ['tools/fleet-sheet-report.mjs', '--specs', '--cloud', '--no-jitter'], {
            cwd: repo, timeout: 300_000, windowsHide: true, shell: false, encoding: 'utf8'
          });
          if (result.error || result.status !== 0) throw new Error('local report failed');
        } else {
          if (typeof directiveSend !== 'function') throw new Error('fleet directive unavailable');
          directiveSend(['--kind', 'run', '--task', 'fleet-sheet-report', '--targets', violation.label || pc, '--why', 'stale_report 自動復旧', '--push', '--expires-hours', '48'], { repo });
        }
        nextStaleRetry[pc] = { sentAt: now.toISOString(), count: 1, mode };
        actions.push({ id: `action-${nowMs}-stale_report-${pc}`, kind, pc, mode, dispatchedAt: now.toISOString(), baseline: { metric: 'reportAge', value: 0 }, result: 'sent', verifiedAt: null, note: `fleet-sheet-report 再送 (${mode})` });
        continue;
      } catch {
        // 外部例外には認証情報を含む git 出力があり得るので、固定の理由だけを記録する。
        console.error(`stale_report: ${mode === 'local' ? 'ローカル再送に失敗（終了異常またはタイムアウト）' : '再送指令の送信に失敗（利用不可または push 失敗）'}。人へエスカレーションします。`);
        retryFailed = true;
      }
    }
    if (kind === 'stale_report' && nextStaleRetry[pc] && nowMs - Date.parse(nextStaleRetry[pc].sentAt) < 86400000) continue;

    const isCooldown = nextActionsState.some(act => {
      if (act.kind === kind && act.pc === pc) {
        const dispatchedTime = new Date(act.dispatchedAt).getTime();
        return nowMs - dispatchedTime < 3 * 86400000;
      }
      return false;
    });
    if (isCooldown && !retryFailed) continue;

    const sameCompletedActs = nextActionsState
      .filter(act => act.kind === kind && act.pc === pc && act.result !== 'pending')
      .sort((a, b) => new Date(b.dispatchedAt).getTime() - new Date(a.dispatchedAt).getTime());

    let hasThreeConsecutiveFailures = false;
    if (sameCompletedActs.length >= 3) {
      const top3 = sameCompletedActs.slice(0, 3);
      const allFailed = top3.every(act => ['no_effect', 'failed', 'worse'].includes(act.result));
      if (allFailed) {
        hasThreeConsecutiveFailures = true;
      }
    }

    let mode = playbook.mode;
    let note = '';
    const selfLike = (value) => /^(?:self|local)(?:-|$)/i.test(String(value));
    const measurementUntrusted = violations.some((item) => item.kind === 'measurement_untrusted'
      && (item.pc === pc || item.pc === 'fleet' || (selfLike(item.pc) && selfLike(pc))));
    if (measurementUntrusted && mode === 'auto-codex') {
      skipped.push({ kind, pc, reason: 'measurement_untrusted', note: '計測不能のため自動委譲を見送り(次回再判定)' });
      continue;
    }
    const latestHuman = sameCompletedActs.find((item) => item.humanSince || item.mode === 'human');
    const humanSince = Date.parse(latestHuman?.humanSince || latestHuman?.dispatchedAt || '');
    const recovered = Number.isFinite(violation.actualValue) && Number.isFinite(violation.targetValue)
      && (kind === 'opus_heavy' ? violation.actualValue <= violation.targetValue : violation.actualValue >= violation.targetValue);
    const humanExpired = Number.isFinite(humanSince) && nowMs - humanSince >= 14 * 86400000;
    if (hasThreeConsecutiveFailures && !humanExpired && !recovered && (mode === 'auto-local' || mode === 'auto-codex')) {
      mode = 'human';
      note = 'Downgraded to human due to 3 consecutive failures';
    }

    let metric = 'unknown';
    let value = 0;
    if (kind === 'low_delegation' || kind === 'opus_heavy') {
      metric = kind === 'low_delegation' ? 'delegRatio' : 'opusRatio';
      const match = evidence.match(/(\d+(?:\.\d+)?)/);
      value = match ? parseFloat(match[1]) / (evidence.includes('%') ? 100 : 1) : 0;
    } else if (kind === 'no_cheap_ai' || kind === 'unused_provider') {
      metric = 'cheapAiCalls';
      value = 0;
    } else if (kind === 'cost_spike') {
      metric = 'claudeUsd';
      const match = evidence.match(/\$(\d+(?:\.\d+)?)/);
      value = match ? parseFloat(match[1]) : 0;
    } else if (SIGNAL_METRICS[kind]) {
      metric = SIGNAL_METRICS[kind];
      value = Number.isFinite(Number(violation.actualValue)) ? Number(violation.actualValue) : 0;
    }

    const actionId = `action-${nowMs}-${kind}-${pc}`;
    const action = {
      id: actionId,
      kind,
      pc,
      mode,
      dispatchedAt: now.toISOString(),
      baseline: { metric, value },
      result: 'pending',
      verifiedAt: null,
      note: note || `Dispatched via ${mode}`,
      pr: null
    };
    if (violation.provider) action.provider = violation.provider;
    if (mode === 'human' && hasThreeConsecutiveFailures) action.humanSince = now.toISOString();
    if (kind === 'provider_unhealthy') {
      // DM 本文の1行: 無料枠の上限が原因なら有料枠で即解消できることを示す。
      action.reportNote = '有料枠で解消可(例: Groq Dev tier)';
    }
    if (kind === 'spend_anomaly') action.durationHours = 24;
    if (kind === 'balance_low') action.reportNote = action.provider === 'genspark' ? '前払い枠が残り少。チャージまたは画像生成レーンの停止を判断' : `自動チャージが無いプロバイダです。OpenRouter 経由へ切替${['deepseek', 'kimi'].includes(action.provider) ? '済み' : '未'}`;

    if (mode === 'auto-local') {
      if (playbook.command) action.command = playbook.command;
      if (playbook.effect) action.effect = playbook.effect;
      actions.push(action);
      nextActionsState.push(action);
    } else if (mode === 'auto-codex') {
      if (codexCount < (limits.maxCodex ?? 2)) {
        codexCount++;
        action.specPath = `cost-improve/specs/${actionId}.md`;
        const targetValue = violation.targetValue ?? 0.5;
        const actualValue = violation.actualValue ?? value;
        const metricLabel = kind === 'low_delegation' ? '委譲率' : 'Opus比率';
        const investigation = kind === 'low_delegation'
          ? '`node tools/usage-stats.mjs deleg` で監督の出力の出どころ（tool_use/thinking/text の内訳と Bash/Write/Edit の内訳）を実測し、最大の漏れ口を1つだけ特定して、そこに対処すること。推測で新しい層を足さないこと。'
          : 'モデル利用実績とルーティング規則を実測し、Opusを選んだ最大の経路を1つだけ特定して、品質要件を維持できる安価な主経路へ修正すること。推測で新しい層を足さないこと。';
        action.specContent = `# AIコスト改善仕様: ${kind} / ${pc}\n\n## 計測事実\n- PC名: ${pc}\n- 指標: ${metricLabel}\n- 実測値: ${(actualValue * 100).toFixed(1)}%\n- 目標値: ${(targetValue * 100).toFixed(1)}%\n- 計測日時: ${violation.measuredAt || now.toISOString()}\n- 根拠: ${evidence}\n\n## 調査と修正\n${investigation}\n\n## 作業範囲と禁止事項\n- **この指標は ${pc} のものであり、いま動いているこのPCのものではない**。ローカルの統計を ${pc} の根拠として使わないこと。直すのは全PCへ配布される共有の仕組み(ルーティング・フック・しきい値)であって、このPC固有の設定ではない。\n- 対象リポジトリ内の、特定した原因に直接関係するファイルだけを変更すること。\n- 既存テストを壊さず、変更対象に対応する \`node --test tools/<file>.test.mjs\` を緑にすること。\n- main へ直接 push しないこと。秘密情報を出力しないこと。\n- 原因を特定できなければ、変更を入れずに「特定できなかった」と報告して終わること。`;
        actions.push(action);
        nextActionsState.push(action);
      }
    } else if (mode === 'human') {
      action.result = 'escalated';
      action.todoMessage = humanTodoMessage(violation, now, nextStaleRetry[pc]?.count || 0, nextStaleRetry[pc]?.mode || 'directive');
      if (playbook.localEffect) action.localEffect = playbook.localEffect;
      actions.push(action);
      nextActionsState.push(action);
    }
  }

  const stalePcs = new Set(violations.filter(v => v.kind === 'stale_report').map(v => v.pc));
  for (const pc of Object.keys(nextStaleRetry)) if (!stalePcs.has(pc)) delete nextStaleRetry[pc];
  return { actions, skipped, nextActionsState, nextStaleRetry };
}

export function verifyPreviousActions({ state, rows, localState, now, horizonDays = 3, signals = null }) {
  const nextActionsState = [...(state.actions || [])];
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  for (let i = 0; i < nextActionsState.length; i++) {
    const act = { ...nextActionsState[i] };
    if (act.result !== 'pending' || act.mode === 'human') continue;

    const dispatchedTime = new Date(act.dispatchedAt).getTime();
    if (nowMs - dispatchedTime < horizonDays * 86400000) continue;

    const isSelf = act.pc === 'self' || act.pc.toLowerCase().includes('local') || act.pc === (localState?.pcName ?? '');
    let currentVal = null;

    if (isSelf) {
      if (act.baseline.metric === 'delegRatio') {
        currentVal = localState?.delegRatio ?? null;
      } else if (act.baseline.metric === 'cheapAiCalls') {
        const row = rows?.find(r => (r.pcName || r.label || '').toLowerCase().includes('self') || (r.pcName || r.label || '').toLowerCase().includes('local'));
        if (row) {
          currentVal = parseCheapAiUseCount(row.cheapAiUse);
        } else {
          currentVal = 0;
        }
      } else if (act.baseline.metric === 'opusRatio') {
        currentVal = localState?.opusRatio ?? null;
      } else if (act.baseline.metric === 'claudeUsd') {
        currentVal = localState?.claudeUSD ?? null;
      } else if (act.baseline.metric === 'failRate') {
        const stats = signals?.providerHealth?.providers?.[act.provider];
        currentVal = Number.isFinite(Number(stats?.failRate)) ? Number(stats.failRate) : null;
      } else if (act.baseline.metric === 'codexLimit24h') {
        currentVal = Number.isFinite(Number(signals?.codexLimit24h)) ? Number(signals.codexLimit24h) : null;
      } else if (act.baseline.metric === 'headlessClaudeOut') {
        currentVal = Number.isFinite(Number(signals?.headlessClaudeOut)) ? Number(signals.headlessClaudeOut) : null;
      } else if (act.baseline.metric === 'pacePercent') {
        currentVal = Number.isFinite(Number(signals?.budgetPacePct)) ? Number(signals.budgetPacePct) : null;
      } else if (act.baseline.metric === 'evalAgeDays') {
        // null(結果ファイルがまだ無い)は計測不能として pending 継続。
        currentVal = Number.isFinite(Number(signals?.evalAgeDays)) ? Number(signals.evalAgeDays) : null;
      }
    } else {
      const row = rows?.find(r => r.pcName === act.pc || r.label === act.pc);
      if (row) {
        if (act.baseline.metric === 'delegRatio') {
          currentVal = parsePercent(row.delegRatio);
        } else if (act.baseline.metric === 'cheapAiCalls') {
          currentVal = parseCheapAiUseCount(row.cheapAiUse);
        } else if (act.baseline.metric === 'opusRatio') {
          currentVal = isOpusHeavy(row, null) ? 1.0 : 0.0;
        } else if (act.baseline.metric === 'claudeUsd') {
          currentVal = parseFloat(row.claudeUsd);
        }
      }
    }

    if (currentVal === null) {
      continue;
    }

    let result = 'no_effect';
    const baselineVal = act.baseline.value;

    if (act.baseline.metric === 'delegRatio') {
      if (currentVal >= 0.5 || currentVal > baselineVal + 0.05) {
        result = 'worked';
      } else if (currentVal < baselineVal - 0.01) {
        result = 'worse';
      } else {
        result = 'no_effect';
      }
    } else if (act.baseline.metric === 'cheapAiCalls') {
      if (currentVal > baselineVal) {
        result = 'worked';
      } else {
        result = 'no_effect';
      }
    } else if (act.baseline.metric === 'opusRatio') {
      if (currentVal <= 0.5 || currentVal < baselineVal - 0.05) {
        result = 'worked';
      } else if (currentVal > baselineVal + 0.05) {
        result = 'worse';
      } else {
        result = 'no_effect';
      }
    } else if (act.baseline.metric === 'claudeUsd') {
      if (currentVal < baselineVal * 0.9) {
        result = 'worked';
      } else if (currentVal > baselineVal * 1.1) {
        result = 'worse';
      } else {
        result = 'no_effect';
      }
    } else if (act.baseline.metric === 'failRate') {
      if (currentVal <= 0.2 || currentVal < baselineVal - 0.05) result = 'worked';
      else if (currentVal > baselineVal + 0.05) result = 'worse';
      else result = 'no_effect';
    } else if (act.baseline.metric === 'pacePercent') {
      if (currentVal <= 100 || currentVal < baselineVal - 5) result = 'worked';
      else if (currentVal > baselineVal + 5) result = 'worse';
      else result = 'no_effect';
    } else if (act.baseline.metric === 'evalAgeDays') {
      if (currentVal <= 7 || currentVal < baselineVal - 1) result = 'worked';
      else if (currentVal > baselineVal + 1) result = 'worse';
      else result = 'no_effect';
    } else if (act.baseline.metric === 'codexLimit24h' || act.baseline.metric === 'headlessClaudeOut') {
      // カウント系: 1でも下がれば効いた、上がれば悪化。
      if (currentVal <= (act.baseline.metric === 'codexLimit24h' ? 1 : 0) || currentVal < baselineVal) result = 'worked';
      else if (currentVal > baselineVal) result = 'worse';
      else result = 'no_effect';
    }

    act.result = result;
    act.verifiedAt = now.toISOString();
    nextActionsState[i] = act;
  }

  return { ...state, actions: nextActionsState };
}

function defaultSleepSync(milliseconds) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, milliseconds);
}

export function atomicWrite(file, content, options = {}) {
  const renameSync = options.renameSync || fs.renameSync;
  const sleepSync = options.sleepSync || defaultSleepSync;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf8');
    let lastError;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 9) sleepSync(50 + attempt * 25);
      }
    }
    throw lastError;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch {}
  }
}

function formatJst(date) {
  const jst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  const two = (value) => String(value).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${two(jst.getUTCMonth() + 1)}-${two(jst.getUTCDate())} ${two(jst.getUTCHours())}:${two(jst.getUTCMinutes())}:${two(jst.getUTCSeconds())}`;
}

function parseEnvFile(file) {
  try {
    return Object.fromEntries(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
      return match ? [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')] : null;
    }).filter(Boolean));
  } catch { return {}; }
}

// auto-local アクションの実行。コマンドは「許可リストの固定文字列→argv 配列」だけ(shell 無し)。
// effect はシート由来文字列を実行しないローカルファイル書き込み(writeXxx 純関数)のみ。
// 戻り値は act を差し替えた新しいオブジェクト(呼び出し側で Object.assign して使う)。
export function executeLocalAction({ act, dryRun = false, claudeDir, home, now = new Date(), repoRoot = process.cwd(), spawnSync = defaultSpawnSync, writeImpl = null, hasZaiEnvImpl = null }) {
  if (act.effect) {
    if (dryRun) {
      console.log(`[dry-run] Would apply effect: ${act.effect}`);
      return { ...act, result: 'pending', note: `[dry-run] Would apply effect: ${act.effect}` };
    }
    const zaiCheck = hasZaiEnvImpl ?? hasZaiEnv;
    try {
      if (act.effect === 'writeRoutingOverride') {
        const applied = writeRoutingOverride({ claudeDir, provider: act.provider, now, writeImpl, durationHours: act.durationHours });
        return { ...act, result: 'pending', note: `routing-overrides.json に ${applied.provider} の demote(${applied.until}まで)を記録。llm-fallback が連鎖末尾へ回します。` };
      }
      if (act.effect === 'writeGatewayOverride') {
        const applied = writeGatewayOverride({ claudeDir, provider: act.provider, writeImpl });
        return { ...act, result: 'pending', note: `routing-overrides.json: ${applied.provider} は OpenRouter ${applied.model} の後ろへ移動。` };
      }
      if (act.effect === 'writeCodexFallbackOrder') {
        const applied = writeCodexFallbackOrder({ claudeDir, zaiAvailable: zaiCheck(home), writeImpl });
        return { ...act, result: 'pending', note: applied.changed ? `codex-fallback-order.json を ${applied.order.join(' → ')} に更新。` : `no_change (${applied.order.join(' → ')} が既に設定済み)` };
      }
      if (act.effect === 'writeAutoSessionExecutor') {
        const provider = zaiCheck(home) ? 'glm' : 'deepseek';
        const applied = writeAutoSessionExecutorEnv({ claudeDir, provider, writeImpl });
        return { ...act, result: 'pending', note: applied.changed ? `auto-session.env に executor=cheap-code provider=${provider} を設定。` : applied.note };
      }
      console.error(`Unknown local effect: ${act.effect}`);
      return { ...act, result: 'failed', note: `Unknown effect: ${act.effect}` };
    } catch (error) {
      return { ...act, result: 'failed', note: `Effect ${act.effect} failed: ${String(error?.message ?? error)}` };
    }
  }
  if (!ALLOWED_LOCAL_COMMANDS.includes(act.command)) {
    console.error(`Local command not allowed: ${act.command}`);
    return { ...act, result: 'failed', note: 'Command not in whitelist' };
  }
  if (dryRun) {
    console.log(`[dry-run] Would run: ${act.command}`);
    return { ...act, result: 'pending', note: `[dry-run] Would run: ${act.command}` };
  }
  console.log(`Executing auto-local command: ${act.command}`);
  const parts = splitWhitelistedCommand(act.command);
  const res = spawnSync(parts[0], parts.slice(1), { shell: false, cwd: repoRoot, encoding: 'utf8' });
  if (res.status === 0) {
    return { ...act, result: 'pending', note: 'Command executed successfully. Awaiting verification.' };
  }
  return { ...act, result: 'failed', note: `Command failed with exit code ${res.status}: ${res.stderr || res.error?.message}` };
}

// auto-codex アクションの実実行。複数件(acts)でも1本の spec に対する1回の codex-do 呼び出しで処理する(#300)。
// 実行は必ず一時 worktree(git worktree add --detach origin/main)の中で行い、共有ツリーには
// reset/clean/checkout -b を投げない(#294)。検証テストが通れば gh pr create で実PRを作り、
// 成功した acts 全件の state に PR URL を記録する。空 diff・検証失敗・実行失敗時は変更を捨てて
// worktree を破棄し、acts 全件を failed にする。
export function runAutoCodexIsolated({ acts, specFile, dryRun = false, repoPath, now = new Date(), spawnSync = defaultSpawnSync }) {
  const list = Array.isArray(acts) ? acts : [acts];
  if (list.length === 0) return;
  const first = list[0];
  const label = list.length > 1 ? 'batch' : first.kind;
  const fail = (stage, res) => {
    const detail = String(res?.stderr || res?.stdout || res?.error?.message || `exit ${res?.status}`).trim();
    for (const act of list) { act.result = 'failed'; act.note = `${stage}: ${detail}`; }
  };
  if (dryRun) {
    console.log(`[dry-run] Would execute codex in temp worktree: ${specFile}`);
    for (const act of list) act.result = 'pending';
    return;
  }
  const tempTree = path.join(os.tmpdir(), `orgiast-cost-improve-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    let res = spawnSync('git', ['-C', repoPath, 'worktree', 'add', '--detach', tempTree, 'origin/main'], { encoding: 'utf8' });
    if (res.status !== 0) { fail('worktree add failed', res); return; }
    res = spawnSync('node', [path.join(tempTree, 'tools/codex-do.mjs'), '--prompt-file', specFile, '--cwd', tempTree, '--timeout', '1800'], { cwd: tempTree, encoding: 'utf8' });
    if (res.status !== 0) { fail('Codex execution failed', res); return; }
    const diff = spawnSync('git', ['-C', tempTree, 'diff', '--stat'], { encoding: 'utf8' });
    if (diff.status !== 0 || !String(diff.stdout || '').trim()) { fail('変更なし', diff); return; }
    const tests = spawnSync('node', ['--test', 'tools/*.test.mjs'], { cwd: tempTree, shell: true, encoding: 'utf8' });
    if (tests.status !== 0) { fail('verification tests failed', tests); return; }
    const dateStr = now.toISOString().slice(0, 10).replaceAll('-', '');
    const branchName = `auto/cost-improve-${dateStr}-${label}`;
    const commitMsg = `fix(cost): auto improve ${label}`;
    for (const [program, args, stage] of [
      ['git', ['-C', tempTree, 'checkout', '-b', branchName], 'branch creation failed'],
      ['git', ['-C', tempTree, 'add', '-A'], 'git add failed'],
      ['git', ['-C', tempTree, 'commit', '-m', commitMsg], 'commit failed'],
      ['git', ['-C', tempTree, 'push', '-u', 'origin', branchName], 'push failed']
    ]) {
      res = spawnSync(program, args, { encoding: 'utf8' });
      if (res.status !== 0) { fail(stage, res); return; }
    }
    const body = `Evidence: ${first.specContent?.match(/- 根拠: (.*)/)?.[1] || label}\n\nSpec summary: ${label} on ${first.pc}; verify with node --test tools/*.test.mjs.`;
    res = spawnSync('gh', ['pr', 'create', '--title', commitMsg, '--body', body, '--head', branchName], { cwd: tempTree, encoding: 'utf8' });
    const url = `${res.stdout || ''}\n${res.stderr || ''}`.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/)?.[0];
    if (res.status !== 0 || !url) { fail('PR creation failed', res); return; }
    for (const act of list) {
      act.pr = url;
      act.note = `Successfully fixed via Codex: ${url}`;
      act.result = 'pending';
    }
  } finally {
    spawnSync('git', ['-C', repoPath, 'worktree', 'remove', '--force', tempTree], { encoding: 'utf8' });
  }
}

export function analyzeEffectiveness(actions, limit = 10) {
  const verified = (Array.isArray(actions) ? actions : [])
    .filter((action) => ['worked', 'no_effect', 'worse'].includes(action.result))
    .sort((a, b) => Date.parse(b.verifiedAt || b.dispatchedAt || 0) - Date.parse(a.verifiedAt || a.dispatchedAt || 0))
    .slice(0, limit);
  const ineffective = verified.filter((action) => ['no_effect', 'worse'].includes(action.result)).length;
  return { total: verified.length, ineffective, warning: verified.length > 0 && ineffective / verified.length >= 0.7 };
}

export async function sendCostImproveHeartbeat({ claudeDir, label, ranAt, status, summary, fetchImpl = globalThis.fetch }) {
  const env = { ...parseEnvFile(path.join(claudeDir, 'fleet-sheet.env')), ...process.env };
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) throw new Error('FLEET_SHEET_URL/TOKEN 未設定');
  const response = await fetchImpl(env.FLEET_SHEET_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: env.FLEET_SHEET_TOKEN, kind: 'cost-improve-heartbeat', label, ranAt, status, summary }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`heartbeat HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload?.ok) throw new Error(`heartbeat rejected: ${payload?.error || 'unknown'}`);
}

export function readLedgerCounts(filePath, now) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const counts = {};
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const sevenDaysAgoMs = nowMs - 7 * 86400000;

  for (const line of text.split(/\r?\n/)) {
    const cleanLine = line.trim();
    if (!cleanLine) continue;
    let row;
    try {
      row = JSON.parse(cleanLine);
    } catch {
      continue;
    }
    if (!row.t || !row.provider) continue;
    const tMs = parseJstOrIsoDate(row.t);
    if (!tMs || tMs < sevenDaysAgoMs || tMs > nowMs) continue;

    const prov = String(row.provider).trim().toLowerCase();
    counts[prov] = (counts[prov] || 0) + 1;
  }
  return counts;
}

export function localProviderEnv(homeDir) {
  const providers = [
    { name: 'groq', envKey: 'GROQ_API_KEY', envFile: 'groq.env' },
    { name: 'deepseek', envKey: 'DEEPSEEK_API_KEY', envFile: 'deepseek.env' },
    { name: 'gemini', envKey: 'GEMINI_API_KEY', envFile: 'gemini.env' },
    { name: 'openrouter', envKey: 'OPENROUTER_API_KEY', envFile: 'openrouter.env' },
    { name: 'grok', envKey: 'XAI_API_KEY', envFile: 'xai.env' }
  ];
  const configured = [];
  const parseEnv = (file) => {
    try {
      return Object.fromEntries(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => {
        const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) return null;
        return [match[1], match[2].replace(/^(['"])(.*)\1$/, '$2')];
      }).filter(Boolean));
    } catch { return {}; }
  };
  const envMap = {};
  for (const prov of providers) {
    const envVal = process.env[prov.envKey];
    if (envVal) {
      configured.push(prov.name);
      envMap[prov.name] = envVal;
    } else {
      const fileContent = parseEnv(path.join(homeDir, '.claude', prov.envFile));
      if (fileContent[prov.envKey]) {
        configured.push(prov.name);
        envMap[prov.name] = fileContent[prov.envKey];
      }
    }
  }
  return { configured, envMap };
}

// ---- B4: ローカル信号の収集と対処(PLAYBOOK provider_unhealthy/codex_saturated/headless_claude/budget_pace/eval_stale) ----

export function countCodexLimitDetections(claudeDir, now) {
  let text = '';
  try { text = fs.readFileSync(path.join(claudeDir, 'codex-limit-history.jsonl'), 'utf8'); } catch { return 0; }
  const cutoff = now.getTime() - 24 * 3600 * 1000;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      const t = Date.parse(row.t || '');
      if (Number.isFinite(t) && t >= cutoff && t <= now.getTime()) count++;
    } catch {}
  }
  return count;
}

// eval-results.jsonl の最新 t の経過日数。ファイル/行が無い場合は null(=「無い」も発火対象)。
export function evalLatestAgeDays(claudeDir, now) {
  let text = '';
  try { text = fs.readFileSync(path.join(claudeDir, 'eval-results.jsonl'), 'utf8'); } catch { return null; }
  let latest = NaN;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const t = Date.parse(JSON.parse(line).t || '');
      if (Number.isFinite(t) && (Number.isNaN(latest) || t > latest)) latest = t;
    } catch {}
  }
  if (Number.isNaN(latest)) return null;
  return (now.getTime() - latest) / 86400000;
}

export function hasZaiEnv(home) {
  if (process.env.ZAI_API_KEY) return true;
  try {
    return /^ZAI_API_KEY\s*=/m.test(fs.readFileSync(path.join(home, '.claude', 'zai.env'), 'utf8').replace(/^﻿/, ''));
  } catch { return false; }
}

// provider_unhealthy 対処: demote 有効期限(+3日)を ~/.claude/routing-overrides.json に書く純関数。
// 既存の他 provider/他キーは保持する。llm-fallback.mjs が demote 中の provider を連鎖末尾へ回す。
export function writeRoutingOverride({ claudeDir, provider, now, writeImpl = null, durationHours = 72 }) {
  const file = path.join(claudeDir, 'routing-overrides.json');
  const name = String(provider || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(name)) throw new Error(`不正なprovider名: ${provider}`);
  const until = new Date(now.getTime() + durationHours * 3600000).toISOString();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (!state.demote || typeof state.demote !== 'object' || Array.isArray(state.demote)) state.demote = {};
  const changed = state.demote[name] !== until;
  state.demote[name] = until;
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (writeImpl) writeImpl(file, content);
  else atomicWrite(file, content);
  return { file, provider: name, until, changed };
}

export function writeGatewayOverride({ claudeDir, provider, writeImpl = null }) {
  const models = { deepseek: 'deepseek/deepseek-v4-flash', kimi: 'moonshotai/kimi-k3' };
  const name = String(provider || '').trim().toLowerCase();
  const model = models[name];
  if (!model) throw new Error(`gateway mapping unavailable: ${provider}`);
  const file = path.join(claudeDir, 'routing-overrides.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  state.gatewayBeforeDirect = { ...(state.gatewayBeforeDirect || {}), [name]: model };
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (writeImpl) writeImpl(file, content); else atomicWrite(file, content);
  return { file, provider: name, model };
}

// codex_saturated 対処: ~/.claude/codex-fallback-order.json に fallback 順を書く。
// 2026-09-08 実測で cheap-code:glm 1544s/277tok・gemini-cli 2234s/0tok と低成果
// (delegation-health fallback_low_yield)。救済レーンは速度と成功率を最優先し、
// fail 4.2% / 平均36秒と最良の qwen(deepseek-chat) を先頭、glm(定額)を2番目、
// 平均509秒かつハング実績のある gemini-cli を最後にする。
export function writeCodexFallbackOrder({ claudeDir, zaiAvailable, writeImpl = null }) {
  const file = path.join(claudeDir, 'codex-fallback-order.json');
  const order = zaiAvailable ? ['qwen', 'cheap-code:glm', 'gemini-cli'] : ['qwen', 'cheap-code:deepseek', 'gemini-cli'];
  const content = `${JSON.stringify(order, null, 2)}\n`;
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const changed = JSON.stringify(previous) !== JSON.stringify(order);
  if (changed) {
    if (writeImpl) writeImpl(file, content);
    else atomicWrite(file, content);
  }
  return { file, order, changed };
}

// headless_claude 対処: ~/.claude/auto-session.env に executor=cheap-code を固定する。
// 既に同値なら何も書かない(no_change)。他の行は保持する。
export function writeAutoSessionExecutorEnv({ claudeDir, provider, writeImpl = null }) {
  const file = path.join(claudeDir, 'auto-session.env');
  const wanted = { ORGIAST_AUTO_SESSION_EXECUTOR: 'cheap-code', ORGIAST_AUTO_SESSION_PROVIDER: String(provider) };
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').replace(/^﻿/, ''); } catch {}
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line));
  const kept = new Map();
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) kept.set(match[1], match[2].replace(/^(['"])(.*)\1$/, '$2'));
  }
  const noChange = Object.entries(wanted).every(([key, value]) => kept.get(key) === value);
  if (noChange) return { file, ...wanted, changed: false, note: 'no_change (既に同値)' };
  for (const [key, value] of Object.entries(wanted)) kept.set(key, value);
  const content = [...kept.entries()].map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  if (writeImpl) writeImpl(file, content);
  else atomicWrite(file, content);
  return { file, ...wanted, changed: true };
}

// budget_pace 対処: ~/.claude/cost-enforce.json に budgetPressure をマージする(mode等は保持)。
export function writeBudgetPressure({ claudeDir, writeImpl = null }) {
  const file = path.join(claudeDir, 'cost-enforce.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  if (state.budgetPressure === true) return { file, changed: false };
  state.budgetPressure = true;
  const content = `${JSON.stringify(state, null, 2)}\n`;
  if (writeImpl) writeImpl(file, content);
  else atomicWrite(file, content);
  return { file, changed: true };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const dryRun = argv.includes('--dry-run');
  const jsonOutput = argv.includes('--json');
  const noNotify = argv.includes('--no-notify');
  // --max-codex <n>: この回の auto-codex 委譲件数の上限。0 なら委譲せず計測と通知だけ行う
  // (本番の通知経路を、リポジトリに変更を入れずに確かめるために使う)。
  const maxCodexArgIndex = argv.indexOf('--max-codex');
  const maxCodexArg = maxCodexArgIndex >= 0 ? Number(argv[maxCodexArgIndex + 1]) : NaN;
  const maxCodex = Number.isFinite(maxCodexArg) && maxCodexArg >= 0 ? maxCodexArg : 2;
  
  const claudeDir = getClaudeDir(argv);
  const home = path.dirname(claudeDir);
  const now = io.now || new Date();
  const writeAtomic = io.atomicWrite || atomicWrite;
  let stateWriteFailed = false;

  // 1. Collect
  let rows = null;
  let fleetFetchReason = '';
  if (io.fetchFleetSheetRows) {
    try { rows = await io.fetchFleetSheetRows(); }
    catch (error) { fleetFetchReason = String(error?.message ?? error); }
  } else {
    const result = await mainFetch(argv);
    if (result.ok) {
      rows = result.rows;
    } else fleetFetchReason = result.reason || 'フリート取得失敗';
  }

  const ledgerCounts = (io.readLedger ?? readLedgerCounts)(path.join(claudeDir, 'executor-usage.jsonl'), now);
  
  const readJson = (file, fallback = null) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
  };
  const localState = io.localState !== undefined ? io.localState : readJson(path.join(claudeDir, 'cost-loop-state.json'));
  
  // Inject configured providers into localState to keep evaluateFleet pure
  const provEnv = localProviderEnv(home);
  if (localState && typeof localState === 'object') {
    localState.configuredProviders = provEnv.configured;
  }

  // 仕様C5: 同一機体の別表記行(alias)は最新報告の1行だけを採用。古い別表記行を stale 誤検知しない。
  let excludedAliasRows = [];
  if (rows) {
    try {
      const aliasIndex = buildAliasIndex(JSON.parse(fs.readFileSync(path.join(path.resolve(import.meta.dirname, '..'), 'fleet-pc-map.json'), 'utf8')));
      const dedup = dedupeAliasRows(rows, aliasIndex, now);
      rows = dedup.rows;
      excludedAliasRows = dedup.excluded;
    } catch { /* fleet-pc-map.json が読めない機体は従来どおり全行を対象にする */ }
  }

  // 1.5 ローカル信号(B4): provider健全性 / codex上限回数 / headless Claude出力 / 予算ペース / eval鮮度。
  // 各収集器は io で差し替え可能(テスト・dry-run で実データに触れないように)。
  const collectSignals = async () => {
    if (io.signals !== undefined) return io.signals;
    let budgetPacePct = null;
    try {
      const budget = await (io.collectBudgetStatus ?? collectBudgetStatus)({ home, now });
      budgetPacePct = Number.isFinite(Number(budget?.budgetPacePct)) ? Number(budget.budgetPacePct) : null;
    } catch (error) {
      console.error(`予算ペース取得失敗(信号から除外): ${String(error?.message ?? error)}`);
    }
    let headlessClaudeOut = 0;
    try {
      headlessClaudeOut = Number((io.collectClaudeStats ?? collectClaudeStats)({ home, days: 7, now: now.getTime() }).headlessClaudeOut) || 0;
    } catch (error) {
      console.error(`headless出力計測失敗(信号から除外): ${String(error?.message ?? error)}`);
    }
    return {
      providerHealth: (io.collectProviderHealth ?? collectProviderHealth)({ home, days: 7, now: now.getTime() }),
      codexLimit24h: (io.countCodexLimitDetections ?? countCodexLimitDetections)(claudeDir, now),
      headlessClaudeOut,
      budgetPacePct,
      evalAgeDays: (io.evalLatestAgeDays ?? evalLatestAgeDays)(claudeDir, now),
      providerBalances: await (io.collectProviderBalances ?? collectProviderBalances)({ home, now, appendHistory: !dryRun })
    };
  };
  let signals = null;
  try {
    signals = await collectSignals();
  } catch (error) {
    console.error(`ローカル信号の収集に失敗(B4判定をスキップ): ${String(error?.message ?? error)}`);
  }
  // heartbeat metrics(headlessOut / budgetPace)は常に実測を載せる。
  if (localState && typeof localState === 'object' && signals) {
    if (Number.isFinite(Number(signals.headlessClaudeOut))) localState.headlessClaudeOut = Number(signals.headlessClaudeOut);
    if (Number.isFinite(Number(signals.budgetPacePct))) localState.budgetPacePct = Number(signals.budgetPacePct);
  }

  const stateFile = path.join(claudeDir, 'cost-improve-state.json');
  let state = { version: 1, lastRun: '', actions: [], lastKpis: {} };
  try {
    if (fs.existsSync(stateFile)) {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    }
  } catch {
    state = { version: 1, lastRun: '', actions: [], lastKpis: {} };
  }
  if (!state.lastKpis) state.lastKpis = {};

  // 2. Verify previous actions (completed actions state update)
  const verifiedState = verifyPreviousActions({ state, rows, localState, now, signals });
  const effectiveness = analyzeEffectiveness(verifiedState.actions);

  // 3. Evaluate violations
  const evaluation = evaluateFleet({ rows, ledgerCounts, localState, now, lastKpis: verifiedState.lastKpis, signals });

  // 4. Decide actions
  let envText = '';
  try { envText = fs.readFileSync(path.join(claudeDir, 'cost-reporter.env'), 'utf8'); } catch {}
  const ownLabel = io.ownLabel ?? resolveReporterLabel({ envText, hostname: os.hostname() }).label;
  const decision = decideActions({ violations: evaluation.violations, state: verifiedState, now, limits: { maxCodex },
    ownLabel, spawnSync: io.spawnSync || defaultSpawnSync, dryRun,
    directiveSend: io.directiveSend || (io.fetchFleetSheetRows ? null : sendFleetDirective) });

  // Execute actions
  const executedActions = [];
  const runSpawnSync = io.spawnSync || defaultSpawnSync;
  const batchCodexActions = decision.actions.filter(act => act.mode === 'auto-codex' && act.result === 'pending');
  let batchCodexHandled = false;

  for (const act of decision.actions) {
    if (act.result !== 'pending' && act.mode !== 'auto-codex' && act.mode !== 'auto-local') {
      // Already verified/completed (e.g. human) or failed
      executedActions.push(act);
      continue;
    }

    if (act.mode === 'auto-local') {
      const repoRoot = path.resolve(import.meta.dirname, '..');
      Object.assign(act, executeLocalAction({ act, dryRun, claudeDir, home, now, repoRoot, spawnSync: runSpawnSync }));
    } else if (act.mode === 'auto-codex' && batchCodexActions.length > 1) {
      // 複数 auto-codex 違反は buildCombinedCodexSpec() で1本の spec にまとめ、Codex 呼び出しを1回に減らす(#300)。
      // 実行・検証・実PR作成・失敗時の破棄は単独実行と同じ runAutoCodexIsolated()(一時 worktree / #294)に任せる。
      if (!batchCodexHandled) {
        batchCodexHandled = true;
        const combinedSpec = buildCombinedCodexSpec(batchCodexActions);
        const timestamp = now.toISOString().replace(/[:.]/g, '-');
        const combinedSpecPath = `cost-improve/specs/combined-${timestamp}.md`;
        const combinedSpecFile = path.join(claudeDir, combinedSpecPath);
        console.log(`Writing combined spec file: ${combinedSpecFile}`);
        if (!dryRun) {
          fs.mkdirSync(path.dirname(combinedSpecFile), { recursive: true });
          fs.writeFileSync(combinedSpecFile, combinedSpec, 'utf8');
        }
        const repoPath = path.resolve(import.meta.dirname, '..');
        console.log(`Running batched auto-codex command in a temporary worktree (${batchCodexActions.length} actions, 1 Codex call)`);
        if (dryRun) {
          console.log(`[dry-run] Would execute combined spec in temp worktree: ${combinedSpecFile}`);
          for (const batchAct of batchCodexActions) batchAct.result = 'pending';
        } else {
          runAutoCodexIsolated({ acts: batchCodexActions, specFile: combinedSpecFile, dryRun, repoPath, now, spawnSync: runSpawnSync });
        }
      }
    } else if (act.mode === 'auto-codex') {
      const specFile = path.join(claudeDir, act.specPath);
      console.log(`Writing spec file: ${specFile}`);
      if (!dryRun) {
        fs.mkdirSync(path.dirname(specFile), { recursive: true });
        fs.writeFileSync(specFile, act.specContent, 'utf8');
      }

      const repoPath = path.resolve(import.meta.dirname, '..');
      const codexCmd = `node tools/codex-do.mjs --prompt-file ${act.specPath} --cwd ${repoPath} --timeout 1800`;
      console.log(`Running auto-codex command: ${codexCmd}`);

      if (dryRun) {
        console.log(`[dry-run] Would execute: ${codexCmd}`);
        act.result = 'pending';
      } else {
        // 一時 worktree 内での実行・検証・実PR作成・失敗時の破棄は runAutoCodexIsolated() に集約(#294)。
        runAutoCodexIsolated({ acts: [act], specFile, dryRun, repoPath, now, spawnSync: runSpawnSync });
      }
    } else if (act.mode === 'human') {
      console.log(`Logging human todo: ${act.todoMessage}`);
      if (!dryRun) {
        const nextSessionFile = path.join(claudeDir, 'next-session.md');
        let content = '';
        if (fs.existsSync(nextSessionFile)) {
          content = fs.readFileSync(nextSessionFile, 'utf8');
        } else {
          content = `## 対象\n\n## 残TODO\n`;
        }
        const res = appendImprovementTodos(content, [act.todoMessage]);
        if (res.added.length > 0) {
          try {
            writeAtomic(nextSessionFile, res.markdown);
            console.log(`Added todo to next-session.md: ${act.todoMessage}`);
          } catch (error) {
            console.error(`next-session.md 書き込み失敗: ${String(error?.message ?? error)}`);
          }
        }
        // budget_pace の自動対処: cost-routing-gate が文言を強めるための budgetPressure フラグ。
        if (act.localEffect === 'budgetPressure') {
          try {
            const applied = writeBudgetPressure({ claudeDir });
            console.log(applied.changed ? 'cost-enforce.json に budgetPressure:true を設定しました' : 'cost-enforce.json の budgetPressure は既に true です');
          } catch (error) {
            console.error(`budgetPressure 書き込み失敗: ${String(error?.message ?? error)}`);
          }
        }
      }
    }
    executedActions.push(act);
  }

  // Update lastKpis state for next run
  const updatedLastKpis = { ...verifiedState.lastKpis };
  if (rows) {
    for (const row of rows) {
      if (isRosterOnlyRow(row)) continue;
      const pcName = row.pcName || row.label || 'unknown';
      const isSelf = pcName.toLowerCase().includes('self') || pcName.toLowerCase().includes('local') || pcName === (localState?.pcName ?? '');
      const claudeUsd = String(row.claudeUsd ?? '').trim() === '' ? null : Number(row.claudeUsd);
      updatedLastKpis[pcName] = {
        claudeUsd: Number.isFinite(claudeUsd) ? claudeUsd : null,
        work: isSelf ? (localState?.work ?? 0) : 0,
        t: now.toISOString()
      };
    }
  }

  // Merge back state actions
  const finalActions = [...decision.nextActionsState];
  for (const execAct of executedActions) {
    const idx = finalActions.findIndex(a => a.id === execAct.id);
    if (idx !== -1) {
      finalActions[idx] = execAct;
    }
  }

  const finalState = {
    version: 1,
    lastRun: now.toISOString(),
    actions: finalActions,
    lastKpis: updatedLastKpis,
    staleRetry: decision.nextStaleRetry
  };

  const ineffectiveWarning = effectiveness.warning
    ? `⚠️ このループは効いていません(直近${effectiveness.total}件中${effectiveness.ineffective}件が効果なし)。playbook の見直しが要ります`
    : '';
  if (ineffectiveWarning && !dryRun) {
    const nextSessionFile = path.join(claudeDir, 'next-session.md');
    const content = fs.existsSync(nextSessionFile) ? fs.readFileSync(nextSessionFile, 'utf8') : '## 対象\n\n## 残TODO\n';
    const todo = appendImprovementTodos(content, [ineffectiveWarning]);
    if (todo.added.length) atomicWrite(nextSessionFile, todo.markdown);
  }

  if (!dryRun) {
    try { writeAtomic(stateFile, JSON.stringify(finalState, null, 2)); }
    catch (error) {
      stateWriteFailed = true;
      console.error(`cost-improve 状態書き込み失敗: ${String(error?.message ?? error)}`);
    }
  }

  // 5. Discord Notification
  const stalePcs = new Set(evaluation.violations.filter(v => v.kind === 'stale_report').map(v => v.pc));
  let reportText = ineffectiveWarning ? `${ineffectiveWarning}\n\n` : '';
  reportText += state.lastNotifyError ? `※ 前回の通知は送信に失敗しています(${state.lastNotifyError})\n\n` : '';
  reportText += `${formatBalanceLine(signals?.providerBalances || [])}\n`;
  reportText += `**📊 AIコスト自動改善ループ報告 (${now.toISOString().slice(0, 10)})**\n\n`;
  
  const unmeasurableRows = [];
  reportText += `### ① フリートKPI状況\n`;
  if (rows) {
    let unreportedCount = 0;
    for (const row of rows) {
      if (isRosterOnlyRow(row)) {
        unreportedCount++;
        continue;
      }
      const pcName = row.pcName || row.label || 'unknown';
      if (stalePcs.has(pcName)) {
        reportText += `- **${pcName}**: 最終報告が古い (${row.reportedAt}) - 集計除外\n`;
      } else if (parsePercent(row.delegRatio) === null || String(row.claudeUsd ?? '').trim() === '' || !Number.isFinite(Number(row.claudeUsd))) {
        unmeasurableRows.push(row);
        reportText += `- **${pcName}**: 報告実績なし（最終報告 ${row.reportedAt || '不明'}）— そのPCで Claude Code を1回起動すれば復帰\n`;
      } else {
        reportText += `- **${pcName}**: 委譲率 ${row.delegRatio || '不明'} / Claude $${row.claudeUsd || '0.00'} / 鮮度: ${row.reportedAt || 'なし'}\n`;
      }
    }
    if (unreportedCount > 0) reportText += `※ 未報告のPC ${unreportedCount}台は表から除外\n`;
    if (excludedAliasRows.length > 0) reportText += `※ 同一機体の旧行 ${excludedAliasRows.length}行を除外 (${excludedAliasRows.map((x) => `${x.pc}→${x.aliasOf}`).join(', ')})\n`;
  } else {
    reportText += `- フリートKPI取得失敗\n`;
  }

  reportText += `\n### ② 今回自動で行った対処\n`;
  const newlyDispatched = executedActions.filter(a => a.mode !== 'human');
  if (newlyDispatched.length > 0) {
    for (const act of newlyDispatched) {
      reportText += `- [${act.mode}] **${act.pc}** の ${act.kind} (状態: ${act.result})${act.pr ? ` -> ${act.pr}` : ''}${act.provider ? ` [${act.provider}]` : ''}${act.reportNote ? ` — ${act.reportNote}` : ''}\n`;
    }
  } else {
    reportText += `- なし\n`;
  }

  reportText += `\n### ③ 前回までの対処の効果判定\n`;
  const recentVerified = finalState.actions.filter(a => !['pending', 'escalated'].includes(a.result) && a.verifiedAt && (now.getTime() - new Date(a.verifiedAt).getTime() < 24 * 3600 * 1000));
  if (recentVerified.length > 0) {
    for (const act of recentVerified) {
      reportText += `- **${act.pc}** の ${act.kind}: **${act.result}** (基準: ${act.baseline.value} -> 検証時)\n`;
    }
  } else {
    reportText += `- なし\n`;
  }

  reportText += `\n### ④ 自動で直せず人に上げた項目\n`;
  const unmeasurablePcs = new Set(unmeasurableRows.map(row => row.pcName || row.label || 'unknown'));
  const newlyHuman = executedActions.filter(a => a.mode === 'human' && !(a.kind === 'measurement_untrusted' && unmeasurablePcs.has(a.pc)));
  if (newlyHuman.length > 0 || unmeasurableRows.length > 0) {
    for (const act of newlyHuman) {
      reportText += `- **${act.pc}**: ${act.todoMessage}\n`;
    }
  } else {
    reportText += `- なし\n`;
  }
  for (const row of unmeasurableRows) reportText += `- **${row.pcName || row.label || 'unknown'}**: 自動では復旧不可 — そのPCで Claude Code を1回起動してください\n`;

  if (jsonOutput) {
    process.stdout.write(JSON.stringify({
      ok: true,
      evaluation,
      decision,
      finalState,
      reportText
    }, null, 2) + '\n');
  } else {
    console.log(reportText);
  }

  if (!dryRun && !noNotify && !io.noNotify) {
    try {
      const notifyResult = await (io.notifyKim ?? notifyKim)(reportText, { home, webhookFallback: false });
      if (!notifyResult || notifyResult.delivered !== 'dm') {
        throw new Error(notifyResult?.reason || 'kim の DM に配信されませんでした');
      }
      delete finalState.lastNotifyError;
    } catch (error) {
      finalState.lastNotifyError = String(error?.message ?? error);
      console.error(`AIコスト自動改善ループ通知失敗: ${finalState.lastNotifyError}`);
    }
    try { writeAtomic(stateFile, JSON.stringify(finalState, null, 2)); }
    catch (error) {
      stateWriteFailed = true;
      console.error(`cost-improve 状態書き込み失敗: ${String(error?.message ?? error)}`);
    }
  }

  // 5.5 毎月1日だけ前月の月次レポートを1通 DM する(仕様C4)。失敗しても日次ループは続行。
  if (!dryRun && !noNotify && !io.noNotify) {
    try {
      if (await (io.shouldSendMonthlyReport || shouldSendMonthlyReport)({ home, now, claudeDir })) {
        const reportText = buildMonthlyReport({ home, now });
        const monthlyResult = await (io.notifyKim ?? notifyKim)(reportText, { home, webhookFallback: false });
        if (monthlyResult?.delivered === 'dm') await (io.markMonthlyReportSent || markMonthlyReportSent)({ home, now, claudeDir });
        console.log('月次レポートを kim へ DM 送信しました');
      }
    } catch (error) {
      console.error(`月次レポートDM送信失敗: ${String(error?.message ?? error)}`);
    }
  }

  if (!dryRun) {
    const status = rows === null || evaluation.pcs.length === 0 ? 'NG' : 'OK';
    const reason = rows === null ? (fleetFetchReason || 'フリート取得失敗') : evaluation.pcs.length === 0 ? '集計対象PCが0台' : '';
    const nonClaudeDeleg = Number(localState?.nonClaudeDelegRatio ?? evaluation.fleet.avgDelegRatio ?? 0);
    const headlessOut = Number(localState?.headlessClaudeOut ?? 0);
    const budgetPace = Number(localState?.budgetPacePct ?? 0);
    const metrics = `pcs=${evaluation.pcs.length} violations=${evaluation.violations.length} actions=${executedActions.length} escalated=${executedActions.filter(a => a.mode === 'human').length} nonClaudeDeleg=${nonClaudeDeleg.toFixed(3)} headlessOut=${headlessOut}tok budgetPace=${budgetPace.toFixed(1)}%`;
    let heartbeat = 'ok';
    const provisional = `${formatJst(now)} / ${status} / ${metrics} notify=ok${reason ? ` reason=${reason}` : ''}`;
    try {
      await (io.sendHeartbeat ?? sendCostImproveHeartbeat)({ claudeDir, label: io.hostname || os.hostname(), ranAt: now.toISOString(), status, summary: provisional, fetchImpl: io.fetchImpl });
    } catch (error) {
      heartbeat = 'failed';
      console.error(`cost-improve heartbeat 送信失敗: ${String(error?.message ?? error)}`);
    }
    const logLine = `${formatJst(now)} / ${status} / ${metrics} notify=${heartbeat} state=${stateWriteFailed ? 'failed' : 'ok'}${reason ? ` reason=${reason}` : ''}`;
    try {
      fs.mkdirSync(path.join(claudeDir, 'logs'), { recursive: true });
      await appendLineWithRetry(path.join(claudeDir, 'logs', 'cost-improve-loop.log'), logLine);
    } catch (error) { console.error(`cost-improve-loop ログ書き込み失敗: ${String(error?.message ?? error)}`); }
  }

  return { ok: true, evaluation, decision, finalState, reportText, effectiveness };
}

async function mainFetch(argv) {
  const claudeDir = getClaudeDir(argv);
  const fleetEnv = {
    ...parseEnvFile(path.join(claudeDir, 'fleet-sheet.env')),
    ...process.env
  };
  return await fetchFleetKPIs({ sheetUrl: fleetEnv.FLEET_SHEET_URL, token: fleetEnv.FLEET_SHEET_TOKEN });
}

if (isEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
