#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { buildRuleComplianceMail, COMPLIANCE_CONTROLLER, COMPLIANCE_DAYS } from './lib/rule-compliance-mail.mjs';

const ownRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const COMPLIANCE_TIMEOUT = 120_000;
export async function dailyRuleCompliance({ home = process.env.ORGIAST_HOME || os.homedir(),
  dir = path.join(home, '.claude'), label = resolveFleetLabel(home), request, now = Date.now,
  repo = ownRepo, spawnSyncImpl = spawnSync, spawnImpl = spawn, background = false,
  // fleet-mail.mjs からは import しない（fleet-mail → ここ → fleet-mail の循環 import は exit 13 の恐れ、import-cycle.test）。
  // ロックは呼び出し側（worker）が fleet-mail の acquireLock を渡す。
  acquireLock = null,
  env = process.env, stderr = console.error } = {}) {
  if (env.FLEET_NO_SELF_HEAL === '1') return { skipped: 'disabled' };
  const marker = path.join(dir, '.fleet-rule-compliance-day');
  const day = new Date(now()).toISOString().slice(0, 10);
  try {
    fs.mkdirSync(dir, { recursive: true });
    let last = '';
    try { last = fs.readFileSync(marker, 'utf8').trim(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (last === day) return { skipped: 'today' };
    if (background) {
      // The worker owns the lock and daily marker. No transcript scanning in the poll process.
      const child = spawnImpl(process.execPath, [path.join(repo, 'tools/fleet-rule-compliance-worker.mjs')], {
        ...backgroundSpawnOptions(), stdio: ['ignore', 'ignore', 'inherit'],
        env: { ...env, ORGIAST_HOME: home, ORGIAST_REPO: repo }
      });
      child.on('error', () => stderr('fleet-mail: ルール遵守ワーカー起動失敗（次回再試行）'));
      child.unref();
      return { launched: true };
    }
    if (typeof acquireLock !== 'function') throw new Error('acquireLock is required in foreground mode');
    const release = acquireLock(path.join(dir, '.fleet-rule-compliance.lock'), { now });
    if (!release) return { skipped: 'locked' };
    try {
      // Reserve the day before scanning: a failing audit must not run every two minutes.
      if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === day) return { skipped: 'today' };
      fs.writeFileSync(marker, day, { mode: 0o600 });
      const result = spawnSyncImpl(process.execPath, [path.join(repo, 'tools/rule-compliance-loop.mjs'), '--days', String(COMPLIANCE_DAYS), '--json'], {
        encoding: 'utf8', windowsHide: true, timeout: COMPLIANCE_TIMEOUT, maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ORGIAST_HOME: home }
      });
      if (result.error || result.status !== 0) throw new Error('audit failed');
      const audit = JSON.parse(result.stdout);
      if (!audit.results || typeof audit.results !== 'object') throw new Error('missing audit results');
      const head = spawnSyncImpl('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe']
      });
      if (head.error || head.status !== 0) throw new Error('git head failed');
      let enforcement = {};
      try { enforcement = JSON.parse(fs.readFileSync(path.join(dir, 'rule-enforcement.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // runAudit proposes enforcement; only the persisted configuration proves the current mode.
      const current = Object.fromEntries(Object.keys(audit.results).map(id => [id, enforcement[id]?.mode || 'off']));
      const at = new Date(now()).toISOString();
      const mail = buildRuleComplianceMail({ pc: label, at, days: COMPLIANCE_DAYS,
        rulesHead: head.stdout.trim(), rules: audit.results, enforcement: current });
      if (label === COMPLIANCE_CONTROLLER) {
        const file = path.join(dir, 'rule-compliance-fleet-self.json');
        const temp = `${file}.${process.pid}.tmp`;
        try {
          fs.writeFileSync(temp, mail.body + '\n', { mode: 0o600 });
          fs.renameSync(temp, file);
        } finally { fs.rmSync(temp, { force: true }); }
      } else {
        const suffix = createHash('sha256').update(label).digest('hex').slice(0, 16);
        const result = await request('mail-send', { id: `mail-compliance-${suffix}-${day.replaceAll('-', '')}`,
          from: label, to: COMPLIANCE_CONTROLLER, messageKind: 'note', auto: true, hop: 1,
          priority: 'normal', ...mail, expiresAt: new Date(now() + 72 * 3600_000).toISOString() });
        if (result?.ok !== true) throw new Error('mail-send failed');
      }
      return { reported: true };
    } finally { release(); }
  } catch {
    stderr('fleet-mail: ルール遵守報告失敗（次回の日次実行で再試行）');
    return { skipped: 'failed' };
  }
}
