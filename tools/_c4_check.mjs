#!/usr/bin/env node
/**
 * _c4_check.mjs — C4 criterion checker for quota-sweep loop
 *
 * C4: delegation-health.json generated after 03:25 JST Oct 30 2026 must have
 * no `fallback_chain_timeout` finding, AND executor-usage.jsonl 24h window
 * must have < 2 fallback+timeout rows.
 *
 * Usage: node tools/_c4_check.mjs [--json]
 *   --json  output machine-readable JSON (default: human-readable)
 *
 * Exit codes:
 *   0  all C4 checks pass
 *   1  any C4 check fails
 *   2  unrecoverable error (file not found, parse failure)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const C4_EPOCH = new Date('2026-10-30T03:25:00+09:00');  // JST
const DELEGATION_HEALTH = path.join(HOME, '.claude/delegation-health.json');
const EXECUTOR_USAGE = path.join(HOME, '.claude/executor-usage.jsonl');
const DAY_MS = 86_400_000;
const C4_TIMEOUT_THRESHOLD = 2;  // must be < 2

const errors = [];
const checks = {};

// ── 1. delegation-health.json ──────────────────────────────────────────
async function checkDelegationHealth() {
  try {
    const raw = fs.readFileSync(DELEGATION_HEALTH, 'utf8');
    const health = JSON.parse(raw);
    const generatedAt = new Date(health.generatedAt);
    const thresholdMet = generatedAt >= C4_EPOCH;

    const hasFallbackTimeout = health.findings?.some(
      f => f.id === 'fallback_chain_timeout'
    ) ?? false;

    checks.delegationHealth = {
      generatedAt: health.generatedAt,
      generatedAtEpoch: generatedAt.getTime(),
      thresholdEpoch: C4_EPOCH.getTime(),
      thresholdMet,
      hasFallbackTimeout,
      findingCount: health.findings?.length ?? 0,
      pass: thresholdMet && !hasFallbackTimeout
    };

    if (!thresholdMet) {
      errors.push(
        `delegation-health.json generatedAt (${health.generatedAt}) is before ` +
        `C4 threshold (${C4_EPOCH.toISOString()})`
      );
    }
    if (hasFallbackTimeout) {
      errors.push('delegation-health.json findings still contain fallback_chain_timeout');
    }
  } catch (e) {
    checks.delegationHealth = { error: e.message };
    errors.push(`Cannot read delegation-health.json: ${e.message}`);
  }
}

// ── 2. executor-usage.jsonl 24h fallback+timeout count ────────────────
async function checkExecutorUsage() {
  try {
    if (!fs.existsSync(EXECUTOR_USAGE)) {
      checks.executorUsage = { error: 'file not found' };
      errors.push('executor-usage.jsonl not found');
      return;
    }
    const raw = fs.readFileSync(EXECUTOR_USAGE, 'utf8');
    const lines = raw.trim().split('\n');
    const now = Date.now();
    const dayAgo = now - DAY_MS;
    let timeoutCount = 0;
    let totalLines = 0;

    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.provider !== 'fallback') continue;
        totalLines++;
        let hit = false;
        if (j.chain) {
          for (const c of j.chain) {
            if (c.outcome === 'timeout') {
              const ct = c.t ? new Date(c.t).getTime() : (j.t ? new Date(j.t).getTime() : 0);
              if (ct >= dayAgo && ct <= now) { hit = true; break; }
            }
          }
        } else if (j.outcome === 'timeout' && j.t) {
          const t = new Date(j.t).getTime();
          if (t >= dayAgo && t <= now) hit = true;
        }
        if (hit) timeoutCount++;
      } catch (e) { /* skip malformed lines */ }
    }

    checks.executorUsage = {
      totalFallbackLines: totalLines,
      timeoutCount24h: timeoutCount,
      threshold: `must be < ${C4_TIMEOUT_THRESHOLD}`,
      pass: timeoutCount < C4_TIMEOUT_THRESHOLD
    };

    if (timeoutCount >= C4_TIMEOUT_THRESHOLD) {
      errors.push(
        `executor-usage 24h fallback+timeout count (${timeoutCount}) ` +
        `exceeds threshold (< ${C4_TIMEOUT_THRESHOLD})`
      );
    }
  } catch (e) {
    checks.executorUsage = { error: e.message };
    errors.push(`Cannot process executor-usage.jsonl: ${e.message}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  await checkDelegationHealth();
  await checkExecutorUsage();

  const allPass = errors.length === 0;
  const result = {
    timestamp: new Date().toISOString(),
    c4Epoch: C4_EPOCH.toISOString(),
    allPass,
    checks,
    errors: allPass ? [] : errors,
    exitCode: allPass ? 0 : 1
  };

  const wantJson = process.argv.includes('--json');
  if (wantJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`C4 Check — ${allPass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`  delegation-health.json: generatedAt=${checks.delegationHealth?.generatedAt ?? 'ERROR'} ` +
      `thresholdMet=${checks.delegationHealth?.thresholdMet} ` +
      `hasFallbackTimeout=${checks.delegationHealth?.hasFallbackTimeout}`);
    console.log(`  executor-usage: 24h fallback+timeout=${checks.executorUsage?.timeoutCount24h ?? 'ERROR'} ` +
      `threshold=<${C4_TIMEOUT_THRESHOLD}`);
    if (errors.length > 0) {
      console.log(`  Errors (${errors.length}):`);
      errors.forEach(e => console.log(`    - ${e}`));
    }
  }

  process.exit(result.exitCode);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(2);
});