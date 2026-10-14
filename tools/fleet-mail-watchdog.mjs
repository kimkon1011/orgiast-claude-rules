#!/usr/bin/env node
// Server-side sweep owns SLA detection; this is its Discord/DM fallback.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { parseEnvText } from './env-kv.mjs';
import { createClient, capabilityClient } from './fleet-mail.mjs';
import { redactSecrets } from './fleet-agent.mjs';
import { notifyKim, resolveDiscordBotToken } from './notify-kim.mjs';
import { CHANNEL, KIM_USER_ID, postToChannel } from './lib/fleet-mail-discord.mjs';
export { CHANNEL, postToChannel };
export function formatAlert(entry) {
  const clean = value => redactSecrets(String(value || '')).replace(/\s+/g, ' ');
  return `⚠ fleet-mail ${entry.kind === 'unseen' ? '未読 SLA 超過' : '未配達（受信タスク停止の疑い）'}: ${clean(entry.to)} 宛 / ${clean(entry.from)} / ${clean(entry.why).slice(0, 60)} / ${clean(entry.id)}`;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  const out = deps.stdout ?? console.log, err = deps.stderr ?? console.error;
  const dryRun = argv.includes('--dry-run');
  for (const arg of argv) if (!['--dry-run', '--json'].includes(arg)) throw new Error('unknown option');
  let config = {};
  try { config = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) { err('fleet-mail-watchdog: 未設定=1'); return 0; }
  const transport = deps.request ?? createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN, fetchImpl: deps.fetch });
  const request = capabilityClient(transport, { home, now: deps.now ?? Date.now, stderr: err, readOnly: dryRun });
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
        const message = formatAlert(entry);
        let channel = false, dm = false;
        try { if (token) { await (deps.postChannel ?? postToChannel)(token, CHANNEL, message, deps.fetch); channel = true; } }
        catch { err('fleet-mail-watchdog: チャンネル通知失敗=1'); }
        try {
          const result = await (deps.notifyKim ?? notifyKim)(message, { home, token, userId: KIM_USER_ID, fetchImpl: deps.fetch, webhookFallback: false });
          dm = result?.delivered === 'dm';
        } catch { err('fleet-mail-watchdog: DM通知失敗=1'); }
        // Only actual Discord delivery counts; notifyKim's {delivered:'none'} is not success.
        if (channel || dm) {
          const ack = await request('mail-alerts', { notifiedIds: [entry.id] });
          if (ack?.ok === false) throw new Error('fleet-mail-watchdog: 通知確認失敗=1');
          notified++;
        } else failed++;
      } catch { failed++; err('fleet-mail-watchdog: 通知確認失敗=1'); }
    }
  }
  const summary = { total: response.alerts.length, pending: pending.length, notified, failed };
  out(argv.includes('--json') ? JSON.stringify(summary) : `監視=${summary.total} / 未通知=${summary.pending} / 通知=${notified} / 失敗=${failed}`);
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error('fleet-mail-watchdog: 監視失敗=1'); process.exitCode = 1; }
}
