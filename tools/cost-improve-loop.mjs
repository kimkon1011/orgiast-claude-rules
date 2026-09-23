#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fetchFleetKPIs, getClaudeDir } from './fleet-kpi-fetch.mjs';
import { notifyKim } from './notify-kim.mjs';
import { appendImprovementTodos } from './nightly-kpi.mjs';

export const ALLOWED_LOCAL_COMMANDS = [
  'node tools/tool-adoption-check.mjs --force',
  'node tools/register-hooks.mjs --hooks-only'
];

// §1.18 の通常運用で利用を期待する主経路だけを監視し、障害時専用の fallback は除外する。
export const PRIMARY_PROVIDERS = ['codex', 'groq', 'gemini', 'deepseek', 'kimi'];

function isRosterOnlyRow(row) {
  return !String(row?.reportedAt ?? '').trim()
    && !String(row?.label ?? '').trim()
    && !String(row?.hostname ?? '').trim();
}

export function parseJstOrIsoDate(text) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return null;
  const jst = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(cleanText);
  if (jst) {
    const year = +jst[1];
    const month = +jst[2] - 1;
    const day = +jst[3];
    const hour = +(jst[4] || 0) - 9;
    const min = +(jst[5] || 0);
    const sec = +(jst[6] || 0);
    return Date.UTC(year, month, day, hour, min, sec);
  }
  const parsed = Date.parse(cleanText);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePercent(text) {
  const cleanText = String(text ?? '').trim();
  if (!cleanText) return null;
  const match = /^(\d+(?:\.\d+)?)\s*%$/.exec(cleanText);
  if (match) {
    return parseFloat(match[1]) / 100;
  }
  const floatVal = parseFloat(cleanText);
  return Number.isFinite(floatVal) ? floatVal : null;
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

export function evaluateFleet({ rows, ledgerCounts, localState, now, lastKpis = {} }) {
  const violations = [];
  const measuredAt = now.toISOString();

  let fleetTrusted = true;
  let selfLedgerTrusted = true;
  let selfStateTrusted = true;

  if (rows === null) {
    violations.push({
      kind: 'measurement_untrusted',
      pc: 'fleet',
      severity: 'error',
      evidence: 'Failed to fetch fleet rows',
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
    const cheapProviders = ['groq', 'deepseek', 'gemini', 'codex', 'grok', 'ollama', 'openrouter', 'kimi', 'moonshot'];
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

  return { pcs: nonStaleRows, fleet: fleetStats, violations };
}

export function sortViolationsBySeverity(violations) {
  const severityRank = { error: 2, warning: 1 };
  const kindRank = { measurement_untrusted: 0, low_delegation: 1, cost_spike: 2, no_cheap_ai: 3, opus_heavy: 4, stale_report: 5, unused_provider: 6 };
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

function humanTodoMessage(violation, now) {
  const pc = violation.pc;
  if (violation.kind === 'stale_report') {
    const reportedAt = /last reported:\s*([^)]*)/.exec(violation.evidence)?.[1] || '日時不明';
    const reportedMs = parseJstOrIsoDate(reportedAt);
    const days = reportedMs === null ? '不明' : Math.max(0, Math.floor((now.getTime() - reportedMs) / 86400000));
    return `【${pc}】から${reportedAt}以降 KPI の自己申告が届いていません（${days}日間）。そのPCで Claude Code を起動できているか確認し、起動していれば \`node tools/fleet-sheet-report.mjs\` が夜間に走っているかを見てください。`;
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
  return `【${pc}】自動対処を完了できませんでした（実測: ${violation.evidence}）。状況を確認してください。`;
}

export function decideActions({ violations, state, now, limits = { maxCodex: 2 } }) {
  const actions = [];
  const skipped = [];
  const nextActionsState = [...(state.actions || [])];
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
    }
  };

  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();

  // 計測が信用できない回は、コード修正の自動委譲を一切行わない。
  // 委譲率や Opus 比は「安いAIが何回呼ばれたか」の上に立つ数字なので、台帳が読めなかった回に
  // それを根拠として直しにいくと、存在しない問題を直すことになる(2026-09-06 の「使用0」誤報がまさにこれ)。
  // この回の仕事は、まず計測そのものを直すことに絞る。
  const measurementUntrusted = violations.some((violation) => violation.kind === 'measurement_untrusted');

  for (const violation of sortViolationsBySeverity(violations)) {
    const { kind, pc, evidence } = violation;
    const playbook = PLAYBOOK[kind];
    if (!playbook) continue;

    const isCooldown = nextActionsState.some(act => {
      if (act.kind === kind && act.pc === pc) {
        const dispatchedTime = new Date(act.dispatchedAt).getTime();
        return nowMs - dispatchedTime < 3 * 86400000;
      }
      return false;
    });
    if (isCooldown) continue;

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
    if (measurementUntrusted && mode === 'auto-codex') {
      skipped.push({ kind, pc, reason: 'measurement_untrusted', note: '計測不能のため自動委譲を見送り(次回再判定)' });
      continue;
    }
    if (hasThreeConsecutiveFailures && (mode === 'auto-local' || mode === 'auto-codex')) {
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

    if (mode === 'auto-local') {
      action.command = playbook.command;
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
      action.todoMessage = humanTodoMessage(violation, now);
      actions.push(action);
      nextActionsState.push(action);
    }
  }

  return { actions, skipped, nextActionsState };
}

export function verifyPreviousActions({ state, rows, localState, now, horizonDays = 3 }) {
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
  const verifiedState = verifyPreviousActions({ state, rows, localState, now });
  const effectiveness = analyzeEffectiveness(verifiedState.actions);

  // 3. Evaluate violations
  const evaluation = evaluateFleet({ rows, ledgerCounts, localState, now, lastKpis: verifiedState.lastKpis });

  // 4. Decide actions
  const decision = decideActions({ violations: evaluation.violations, state: verifiedState, now, limits: { maxCodex } });

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
      if (ALLOWED_LOCAL_COMMANDS.includes(act.command)) {
        console.log(`Executing auto-local command: ${act.command}`);
        if (dryRun) {
          console.log(`[dry-run] Would run: ${act.command}`);
          act.result = 'pending';
        } else {
          const parts = act.command.split(' ');
          const cmd = parts[0];
          const args = parts.slice(1);
          const res = runSpawnSync(cmd, args, { shell: true, encoding: 'utf8' });
          if (res.status === 0) {
            act.result = 'pending';
            act.note = 'Command executed successfully. Awaiting verification.';
          } else {
            act.result = 'failed';
            act.note = `Command failed with exit code ${res.status}: ${res.stderr || res.error?.message}`;
          }
        }
      } else {
        console.error(`Local command not allowed: ${act.command}`);
        act.result = 'failed';
        act.note = 'Command not in whitelist';
      }
    } else if (act.mode === 'auto-codex' && batchCodexActions.length > 1) {
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
        const codexCmd = `node tools/codex-do.mjs --prompt-file ${combinedSpecPath} --cwd ${repoPath} --timeout 1800`;
        console.log(`Running batched auto-codex command: ${codexCmd}`);

        if (dryRun) {
          console.log(`[dry-run] Would execute: ${codexCmd}`);
        } else {
          const res = runSpawnSync('node', ['tools/codex-do.mjs', '--prompt-file', combinedSpecFile, '--cwd', repoPath, '--timeout', '1800'], { encoding: 'utf8' });
          let testsGreen = false;
          if (res.status === 0) {
            console.log('Running project tests to validate batched codex fixes...');
            testsGreen = true;
            try {
              const testFiles = fs.readdirSync(path.join(repoPath, 'tools'))
                .filter(f => f.endsWith('.test.mjs'))
                .map(f => path.join('tools', f));
              for (const testFile of testFiles) {
                console.log(`Running test: ${testFile}`);
                const testRes = runSpawnSync('node', ['--test', testFile], { encoding: 'utf8' });
                if (testRes.status !== 0) {
                  console.error(`Test failed: ${testFile}\n${testRes.stderr}`);
                  testsGreen = false;
                  break;
                }
              }
            } catch (err) {
              console.error(`Error during test collection: ${err.message}`);
              testsGreen = false;
            }
          } else {
            console.error(`Codex command failed: ${res.stderr || res.error?.message}`);
          }

          if (res.status === 0 && testsGreen) {
            const dateStr = now.toISOString().slice(0, 10);
            const branchName = `auto/cost-improve-${dateStr}-batch`;
            runSpawnSync('git', ['checkout', '-b', branchName], { encoding: 'utf8' });
            for (const batchAct of batchCodexActions) {
              batchAct.pr = `Mock PR created on branch ${branchName}`;
              batchAct.note = `Successfully fixed via Codex batch. Created branch ${branchName}`;
              batchAct.result = 'pending';
            }
          } else {
            console.error('Batched Codex execution or tests failed! Discarding working tree changes...');
            runSpawnSync('git', ['reset', '--hard', 'HEAD'], { encoding: 'utf8' });
            runSpawnSync('git', ['clean', '-fd'], { encoding: 'utf8' });
            for (const batchAct of batchCodexActions) {
              batchAct.result = 'failed';
              batchAct.note = res.status === 0
                ? 'Codex changes failed verification tests'
                : `Codex execution failed: ${res.stderr || res.error?.message}`;
            }
          }
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
        const res = runSpawnSync('node', ['tools/codex-do.mjs', '--prompt-file', specFile, '--cwd', repoPath, '--timeout', '1800'], { encoding: 'utf8' });
        if (res.status === 0) {
          console.log(`Running project tests to validate codex fix...`);
          let testsGreen = true;
          try {
            const testFiles = fs.readdirSync(path.join(repoPath, 'tools'))
              .filter(f => f.endsWith('.test.mjs'))
              .map(f => path.join('tools', f));

            for (const testFile of testFiles) {
              console.log(`Running test: ${testFile}`);
              const testRes = runSpawnSync('node', ['--test', testFile], { encoding: 'utf8' });
              if (testRes.status !== 0) {
                console.error(`Test failed: ${testFile}\n${testRes.stderr}`);
                testsGreen = false;
                break;
              }
            }
          } catch (err) {
            console.error(`Error during test collection: ${err.message}`);
            testsGreen = false;
          }

          if (testsGreen) {
            console.log(`All tests are GREEN! Creating git branch...`);
            const dateStr = now.toISOString().slice(0, 10);
            const branchName = `auto/cost-improve-${dateStr}-${act.kind}`;
            runSpawnSync('git', ['checkout', '-b', branchName], { encoding: 'utf8' });
            act.pr = `Mock PR created on branch ${branchName}`;
            act.note = `Successfully fixed via Codex. Created branch ${branchName}`;
            act.result = 'pending';
          } else {
            console.error(`Tests failed! Discarding working tree changes...`);
            runSpawnSync('git', ['reset', '--hard', 'HEAD'], { encoding: 'utf8' });
            runSpawnSync('git', ['clean', '-fd'], { encoding: 'utf8' });
            act.result = 'failed';
            act.note = 'Codex changes failed verification tests';
          }
        } else {
          console.error(`Codex command failed: ${res.stderr || res.error?.message}`);
          act.result = 'failed';
          act.note = `Codex execution failed: ${res.stderr || res.error?.message}`;
        }
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
    lastKpis: updatedLastKpis
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
  reportText += `**📊 AIコスト自動改善ループ報告 (${now.toISOString().slice(0, 10)})**\n\n`;
  
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
        reportText += `- **${pcName}**: 計測不能\n`;
      } else {
        reportText += `- **${pcName}**: 委譲率 ${row.delegRatio || '不明'} / Claude $${row.claudeUsd || '0.00'} / 鮮度: ${row.reportedAt || 'なし'}\n`;
      }
    }
    if (unreportedCount > 0) reportText += `※ 未報告のPC ${unreportedCount}台は表から除外\n`;
  } else {
    reportText += `- フリートKPI取得失敗\n`;
  }

  reportText += `\n### ② 今回自動で行った対処\n`;
  const newlyDispatched = executedActions.filter(a => a.mode !== 'human');
  if (newlyDispatched.length > 0) {
    for (const act of newlyDispatched) {
      reportText += `- [${act.mode}] **${act.pc}** の ${act.kind} (状態: ${act.result})${act.pr ? ` -> ${act.pr}` : ''}\n`;
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
  const newlyHuman = executedActions.filter(a => a.mode === 'human');
  if (newlyHuman.length > 0) {
    for (const act of newlyHuman) {
      reportText += `- **${act.pc}**: ${act.todoMessage}\n`;
    }
  } else {
    reportText += `- なし\n`;
  }

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

  if (!dryRun) {
    const status = rows === null || evaluation.pcs.length === 0 ? 'NG' : 'OK';
    const reason = rows === null ? (fleetFetchReason || 'フリート取得失敗') : evaluation.pcs.length === 0 ? '集計対象PCが0台' : '';
    const metrics = `pcs=${evaluation.pcs.length} violations=${evaluation.violations.length} actions=${executedActions.length} escalated=${executedActions.filter(a => a.mode === 'human').length}`;
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
      fs.appendFileSync(path.join(claudeDir, 'logs', 'cost-improve-loop.log'), `${logLine}\n`, 'utf8');
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
