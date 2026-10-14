import fs from 'node:fs';
import path from 'node:path';
import { resolveDiscordBotToken } from '../notify-kim.mjs';
import { readEnvValue } from '../env-kv.mjs';
import { redactSecrets } from '../fleet-agent.mjs';

export const ARRIVAL_TIMEOUT_MS = 5_000;
export const ARRIVAL_BUDGET_MS = 20_000;
export const CHANNEL = '1508437329247862794';
export const KIM_USER_ID = '715210673642012733';
export async function postToChannel(token, channelId, content, fetchImpl = globalThis.fetch, signal = AbortSignal.timeout(20_000)) {
  const response = await fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'orgiast-fleet-mail' },
    body: JSON.stringify({ content: redactSecrets(content).slice(0, 2000), allowed_mentions: { parse: [] } }), signal,
  });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
}
export async function notifyArrival(mail, { home, label, category, fetchImpl = globalThis.fetch, stderr = console.error, token = resolveDiscordBotToken(home), signal = AbortSignal.timeout(ARRIVAL_TIMEOUT_MS) } = {}) {
  const kind = category === 0 ? '[判断依頼]' : /\[作業依頼\]/.test(mail.why || '') || /^\s*\[作業依頼\]/.test(mail.body || '') ? '[作業依頼]' : 'urgent';
  const oneLine = value => redactSecrets(String(value || '')).replace(/\s+/g, ' ');
  const content = `${oneLine(label)} 宛 ${kind} 到着: ${oneLine(mail.why).slice(0, 60)} / ${oneLine(mail.id)}`;
  if (token) { await postToChannel(token, CHANNEL, content, fetchImpl, signal); return true; }
  let webhook = process.env.FLEET_MAIL_DISCORD_WEBHOOK || readEnvValue(path.join(home, '.claude', 'fleet-sheet.env'), 'FLEET_MAIL_DISCORD_WEBHOOK');
  if (!webhook) { try { webhook = fs.readFileSync(path.join(home, '.claude', 'orgiast-discord-webhook.txt'), 'utf8').trim(); } catch { /* Optional existing route. */ } }
  if (!webhook) { stderr('fleet-mail: 到着通知経路未設定=1'); return false; }
  const response = await fetchImpl(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: [] } }), signal });
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
  return true;
}
