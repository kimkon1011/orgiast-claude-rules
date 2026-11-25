#!/usr/bin/env node
import { discordAllowed } from './lib/kim-discord-allowlist.mjs';
// Server-side sweep owns SLA detection; this is its Discord/DM fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { createClient, acquireLock, capabilityClient, readInbox, syncMailState } from './fleet-mail.mjs';
import { parseLaneHealthMail } from './lib/lane-health.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { notifyKim, resolveDiscordBotToken } from './notify-kim.mjs';
import { CHANNEL, KIM_USER_ID, postToChannel } from './lib/fleet-mail-discord.mjs';
import { runLaneHealthWatch } from './fleet-lane-health-report.mjs';
import { loadLedger, ledgerPath, saveJson } from './lib/fleet-chase-ledger.mjs';
import { formatKimNotice } from './lib/kim-notice.mjs';
import { drainSpool } from './kim-inbox.mjs';
import { reapStalePolls } from './lib/fleet-poll-reaper.mjs';
export { CHANNEL, postToChannel };
export function formatAlert(entry) {
  const clean = value => redactSecrets(String(value || '')).replace(/\s+/g, ' ');
  return formatKimNotice({
    what: `別のパソコン（${clean(entry.to)}）へ送った連絡が${entry.kind === 'unseen' ? '読まれていません' : '届いていません'}。内容: ${clean(entry.why).slice(0, 40)}`,
    next: '受け取り役の再起動を自動で依頼し、48 時間届かなければもう一度お知らせします',
    kim: 'なし', detail: clean(entry.id),
  });
}
// [lane-health] note は集計に取り込んだ時点で既読にする（人が開く連絡ではないため、放置すると未読のまま残る）。
export async function markLaneHealthSeen({ home, request, readInboxImpl = readInbox, sync = syncMailState, stderr = console.error }) {
  let marked = 0;
  for (const mail of readInboxImpl(home, { unreadOnly: false })) {
    if (mail.seenAt || ['seen', 'done', 'expired', 'failed'].includes(mail.status) || !parseLaneHealthMail(mail)) continue;
    try { if (await sync({ home, id: mail.id, action: 'seen', request, seenBy: 'lane-health-watch', stderr })) marked++; }
    catch { stderr('fleet-mail-watchdog: lane-health 既読化失敗=1'); }
  }
  return marked;
}
export function recordDeliveryAlert(home, entry) {
  const release = acquireLock(path.join(home, '.claude/fleet-chase/.lock'));
  if (!release) throw new Error('fleet-chase ledger locked');
  try {
    const ledger = loadLedger(home);
    ledger.deliveryAlerts ||= {};
    ledger.deliveryAlerts[entry.id] = { ...entry, recordedAt: new Date().toISOString() };
    saveJson(ledgerPath(home), ledger);
  } finally { release(); }
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes('--dry-run')) return runOnce(argv, deps);
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  // Recover even when an older watchdog still owns its lock. Do this before
  // any network work; a blocked poll event loop cannot enforce its own timer.
  await (deps.reapStalePolls ?? reapStalePolls)({ home, stderr: deps.stderr ?? console.error });
  const release = acquireLock(path.join(home, '.claude/fleet-mail-watchdog.lock'));
  if (!release) { (deps.stderr ?? console.error)('fleet-mail-watchdog: already running=1'); return 0; }
  try { return await runOnce(argv, deps); } finally { release(); }
}
async function runOnce(argv, deps) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const out = deps.stdout ?? console.log, err = deps.stderr ?? console.error;
  const dryRun = argv.includes('--dry-run');
  for (const arg of argv) if (!['--dry-run', '--json'].includes(arg)) throw new Error('unknown option');
  if (!dryRun) await (deps.drainSpool ?? drainSpool)(home, { stderr: err });
  // 各PCの AI レーン健全性（[lane-health] note）の集計と新規 dead の DM。fleet-sheet 設定の有無とは独立（受信済み note を読むだけ）。
  try {
    const lane = await (deps.laneHealthWatch ?? runLaneHealthWatch)({ home, now: deps.now, dryRun, notify: (text, opts) => (deps.notifyKim ?? notifyKim)(text, { ...opts, token: deps.token ?? resolveDiscordBotToken(home), userId: KIM_USER_ID, fetchImpl: deps.fetch }), stderr: err });
    if (lane.rows.length) out(`レーン健全性: dead=${lane.rows.length} / 新規DM=${lane.notified.length}
${lane.table}`);
  } catch { err('fleet-mail-watchdog: レーン健全性集計失敗=1'); }
  let config = {};
  try { config = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail-watchdog: 未設定=1'); return 0; }
  const transport = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  const request = capabilityClient(transport, { home, now: deps.now ?? Date.now, stderr: err, readOnly: dryRun });
  if (!dryRun) await (deps.markLaneHealthSeen ?? markLaneHealthSeen)({ home, request: transport, stderr: err });
  let response;
  try { response = await request('mail-alerts', {}); }
  catch (error) {
    if (['CAPABILITY_BACKOFF', 'UNSUPPORTED_ACTION'].includes(error.code) || /unknown[_ -](?:action|kind)/i.test(error.message)) return 0;
    throw error;
  }
  if (response?.ok === false || !Array.isArray(response?.alerts)) throw new Error('fleet-mail-watchdog: alerts 取得失敗=1');
  const pending = response.alerts.filter(entry => !(Number(entry.notifiedCount) > 0));
  let notified = 0, failed = 0;
  if (!dryRun && pending.length) {
    const token = deps.token ?? resolveDiscordBotToken(home);
    for (const entry of pending) {
      try {
        // Delivery SLA is machine work. Persist evidence in the chase ledger; only
        // fleet-chase's decision classification may escalate to kim.
        await (deps.recordAlert ?? recordDeliveryAlert)(home, entry);
        const ack = await request('mail-alerts', { notifiedIds: [entry.id] });
        if (ack?.ok === false) throw new Error('fleet-mail-watchdog: 記録確認失敗=1');
        notified++;
      } catch { failed++; err('fleet-mail-watchdog: 通知確認失敗=1'); }
    }
  }
  const summary = { total: response.alerts.length, pending: pending.length, notified, failed };
  out(argv.includes('--json') ? JSON.stringify(summary) : `監視=${summary.total} / 未通知=${summary.pending} / 通知=${notified} / 失敗=${failed}`);
  return 0;
}
if (isEntry(import.meta.url)) {
  // The scheduler launches once per hour, not a daemon. Bound hung network work
  // even when the scheduler's PowerShell parent has already exited.
  const deadline = setTimeout(() => { console.error('fleet-mail-watchdog: 15 minute deadline exceeded=1'); process.exit(1); }, 15 * 60_000);
  deadline.unref();
  try { process.exitCode = await main(); }
  catch { console.error('fleet-mail-watchdog: 監視失敗=1'); process.exitCode = 1; }
  // Keep the unref'ed deadline armed: leaked handles after main returns must
  // also stop, while normal runs exit immediately without waiting for it.
}
