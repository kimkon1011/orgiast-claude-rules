#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, acquireLock, describeTargetFreshness, resolveFleetLabel } from './fleet-mail.mjs';
import { parseEnvText } from './env-kv.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { notifyKim } from './notify-kim.mjs';
import { sendDiscordDm } from './discord-dm.mjs';
import { isEntry } from './is-entry.mjs';
import { DAY, active, oldest, millis, readJson, loadLedger, ledgerPath, saveJson, ingest, checkLedger, control, safe } from './lib/fleet-chase-ledger.mjs';
import { chase, digest } from './lib/fleet-chase-actions.mjs';
import { work } from './lib/fleet-chase-work.mjs';
import { collectRollout, reconcileRollout, complianceTable, rolloutSummary } from './lib/fleet-chase-rollout.mjs';
export * from './lib/fleet-chase-rollout.mjs';
export * from './lib/fleet-chase-ledger.mjs';
export { chase, digest, digestText, resendBody } from './lib/fleet-chase-actions.mjs';
export { work, workHeader } from './lib/fleet-chase-work.mjs';

import { registerExpectation, checkExpectations } from './lib/fleet-chase-expect.mjs';
export const ownRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function parseArgs(argv) {
  const flags = new Set(['--ingest', '--check', '--chase', '--digest', '--work', '--status', '--compliance', '--json', '--dry-run']);
  const values = new Set(['--cancel', '--defer', '--until', '--reason', '--revive', '--expect', '--match-why', '--from']);
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(options, arg)) throw new Error(`duplicate option ${arg}`);
    if (flags.has(arg)) options[arg] = true;
    else if (values.has(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[arg] = argv[++i];
    else throw new Error(`invalid option ${arg}`);
  }
  const controls = ['cancel', 'defer', 'revive', 'expect'].filter(k => options[`--${k}`]);
  if (controls.length > 1) throw new Error('one control operation at a time');
  if (controls.length && ['ingest', 'check', 'chase', 'work', 'digest'].some(k => options[`--${k}`])) throw new Error('control and automation cannot be combined');
  if (options['--until'] && !options['--defer'] && !options['--expect'] || options['--reason'] && !controls.length) throw new Error('orphan control option');
  if ((options['--match-why'] || options['--from']) && !options['--expect']) throw new Error('orphan expectation option');
  if (options['--expect'] && (!options['--match-why'] || !options['--until'] || !options['--reason'])) throw new Error('--expect requires --match-why, --until, --reason');
  return options;
}
export function counts(ledger) {
  const items = Object.values(ledger.items);
  return { outbound: items.filter(i => i.kind === 'outbound').length, inbound: items.filter(i => i.kind === 'inbound').length,
    expect: items.filter(i => i.kind === 'expect-inbound').length,
    rollout: items.filter(i => i.kind === 'rollout').length,
    stale: items.filter(i => i.status === 'stale').length, pending: items.filter(active).length };
}
export function statusTable(ledger, now, plans = []) {
  const summary = counts(ledger);
  const lines = [`取り込み: outbound=${summary.outbound} inbound=${summary.inbound} rollout=${summary.rollout} 受信待ち=${summary.expect} stale=${summary.stale} 未完了=${summary.pending}`,
    rolloutSummary(ledger),
    'kind / level / 経過日数 / 相手 / why / 次アクション時刻 / 状態 (itemId)'];
  for (const item of Object.values(ledger.items).sort(oldest)) {
    lines.push(`${item.kind} / L${item.level} / ${Math.floor((now - millis(item.createdAt)) / DAY)}日 / ${item.target} / ${item.title.slice(0, 60)} / ${item.nextActionAt || '-'} / ${item.status} (${item.id})${item.diagnosis ? ` 原因=${item.diagnosis.cause} 修復=${item.repairs.length}/2 ${item.humanReason || ''}` : ''}`);
  }
  if (plans.length) {
    lines.push('エスカレーション予定: action / 相手 / 時刻 / itemId');
    for (const plan of plans) lines.push(`${plan.action} / ${plan.target} / ${plan.at} / ${plan.id}`);
  }
  return redactSecrets(lines.join('\n'));
}
export async function runChase(options = {}, deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  if (resolveFleetLabel(home) !== 'kim-PC') return { skipped: 'not-controller' };
  const now = (deps.now ?? Date.now)();
  const dryRun = !!options['--dry-run'];
  const repo = deps.repo ?? ownRepo;
  const release = dryRun || (options['--status'] || options['--compliance']) && !Object.keys(options).some(k => ['--expect', '--cancel', '--defer', '--revive', '--ingest', '--check', '--chase', '--work', '--digest'].includes(k))
    ? () => {} : acquireLock(path.join(home, '.claude', 'fleet-chase', '.lock'));
  if (!release) return { skipped: 'locked' };
  try {
    const ledger = loadLedger(home);
    const persist = () => { if (!dryRun) saveJson(ledgerPath(home), ledger); };
    const operation = ['cancel', 'defer', 'revive', 'expect'].find(k => options[`--${k}`]);
    if (operation) {
      const env = deps.env ?? process.env;
      if (operation === 'cancel' && (env.CLAUDE_HEADLESS === '1' || env.ORGIAST_HEADLESS_JOB)) {
        throw new Error('取り下げはkimの明示操作のみ。ヘッドレスでは実行できません');
      }
      if (operation === 'expect') registerExpectation(ledger, options, now);
      else control(ledger, operation, options[`--${operation}`], { now, reason: options['--reason'], until: options['--until'] });
      persist();
      return { ledger, counts: counts(ledger), plans: [], now };
    }
    const phases = ['ingest', 'check', 'chase', 'work', 'digest'].filter(k => options[`--${k}`]);
    const preview = dryRun && options['--status'];
    const all = !phases.length && (!options['--status'] && !options['--compliance'] || preview);
    const should = phase => all || phases.includes(phase);
    const stderr = deps.stderr ?? console.error;
    let client;
    const request = deps.request ?? (async (...args) => {
      if (!client) {
        const config = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8'));
        if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) throw new Error('fleet-sheet configuration missing');
        client = createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetchImpl });
      }
      return client(...args);
    });
    const pcMap = deps.pcMap ?? readJson(path.join(repo, 'fleet-pc-map.json'), {});
    let beacons;
    const fetchBeacons = () => beacons ||= Promise.resolve().then(() => deps.fetchBeacons
      ? deps.fetchBeacons() : import('./fleet-beacon.mjs').then(m => m.fetchBeacons({ home, fetchImpl: deps.fetchImpl })));
    const freshnessCache = new Map();
    const freshness = deps.freshness ?? (to => {
      if (!freshnessCache.has(to)) freshnessCache.set(to, describeTargetFreshness({ to, home, now: () => now, pcMap, fetchBeacons }));
      return freshnessCache.get(to);
    });
    const ctx = { ...deps, home, repo, now, dryRun, persist, request, freshness, pcMap, stderr, fetchBeacons,
      // notifyKim's default plain-Japanese rewrite uses an LLM; this loop must not.
      notify: deps.notify ?? (text => notifyKim(text, { home, webhookFallback: false, plainJa: false })),
      sendDm: deps.sendDm ?? ((person, text) => sendDiscordDm(person, text, { home })) };
    const rollout = should('ingest') || should('check') || options['--compliance'] ? await collectRollout(ctx) : null;
    if (should('ingest')) {
      ingest(ledger, ctx);
      reconcileRollout(ledger, rollout, ctx);
      persist();
    }
    if (should('check')) {
      await checkLedger(ledger, ctx);
      reconcileRollout(ledger, rollout, ctx);
      persist();
    }
    const expectPlans = should('check') || should('chase') ? await checkExpectations(ledger, ctx, { repair: should('chase') }) : [];
    const plans = [...expectPlans, ...(should('chase') ? await chase(ledger, ctx) : [])];
    const workResult = should('work') ? await work(ledger, ctx) : null;
    let digestResult;
    if (should('digest')) {
      try { digestResult = await digest(ledger, ctx); }
      catch { stderr('fleet-chase: ダイジェスト送信失敗（次回再試行）'); }
    }
    if (all || phases.length) persist();
    return { ledger, counts: counts(ledger), plans, work: workResult, digest: digestResult, now, compliance: rollout ? complianceTable(rollout) : undefined };
  } finally { release(); }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parseArgs(argv);
  const result = await runChase(options, deps);
  if (result.skipped === 'not-controller') return 0;
  const stdout = deps.stdout ?? console.log;
  if (options['--json'] || result.skipped) stdout(JSON.stringify(safe(result)));
  else if (options['--compliance']) stdout(result.compliance);
  else stdout(statusTable(result.ledger, result.now, result.plans));
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(`fleet-chase: ${redactSecrets(error.message)}`); process.exitCode = 1; }
}
