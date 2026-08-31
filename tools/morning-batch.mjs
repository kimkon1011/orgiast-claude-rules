#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { clipMessageBody, PER_MESSAGE_CHARS } from './discord-digest.mjs';
import { intake } from './discord-inbox-intake.mjs';
import { isEntry } from './is-entry.mjs';
import { listDecisions, markDecisions } from './pending-decisions.mjs';
import { redactSecrets } from './webhook-health.mjs';

const USER_AGENT = 'DiscordBot (https://orgiast.jp, 1.0) orgiast-morning-batch';
function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function localDate(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function datePart(value) {
  const date = new Date(value);
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
export function formatMorning(decisions) {
  return [`☀️ 朝バッチ: 夜間〜昨日中に ${decisions.length} 件たまっています`, ...decisions.map((item, index) => `${index + 1}. [${datePart(item.capturedAt)}] ${item.author || '不明'}: ${clipMessageBody(item.text, PER_MESSAGE_CHARS)}`), '→ 個別に返信不要。着手してほしいものだけ後でまとめて指示してください。'].join('\n');
}
export async function postWebhook(url, content, { fetchImpl = fetch, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), username = 'orgiast inbox' } = {}) {
  const request = () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT }, body: JSON.stringify({ username, content }) });
  let response = await request();
  let body = await response.text();
  if (response.status === 429 && !body.includes('1015')) { await sleepImpl(2_000); response = await request(); body = await response.text(); }
  if (!response.ok) throw new Error(`Webhook HTTP ${response.status}: ${redactSecrets(body).slice(0, 200)}`);
}
function appendNextSession(home, decisions, date) {
  const file = path.join(home, '.claude', 'next-session.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const heading = `## 朝バッチ取り込み (${date})`;
  let current = '';
  try { current = fs.readFileSync(file, 'utf8'); } catch {}
  const lines = decisions.map((item) => `- [ ] ${String(item.text).replace(/\r?\n/g, ' ')}（by ${item.author || '不明'}, ${item.source}, ${item.id}）`).join('\n');
  if (!current.includes(heading)) {
    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${prefix}${heading}\n${lines}\n`);
    return;
  }
  const headingAt = current.indexOf(heading);
  const nextHeading = current.indexOf('\n## ', headingAt + heading.length);
  const insertAt = nextHeading < 0 ? current.length : nextHeading + 1;
  const prefix = insertAt > 0 && current[insertAt - 1] !== '\n' ? '\n' : '';
  const updated = `${current.slice(0, insertAt)}${prefix}${lines}\n${current.slice(insertAt)}`;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, updated);
  fs.renameSync(tmp, file);
}

export async function runMorning({ home = userHome(), now = new Date(), dryRun = false, intakeImpl = intake, fetchMessagesImpl, fetchImpl = fetch, sleepImpl, channelId, token, webhookUrl } = {}) {
  const resolvedToken = token || process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
  if (!resolvedToken && intakeImpl === intake) throw new Error('Discord Bot トークンが見つかりません');
  const intakeResult = await intakeImpl({ home, now, dryRun, fetchMessagesImpl, channelId, token: resolvedToken });
  const pending = dryRun ? [...listDecisions({ home, status: 'pending' }), ...(intakeResult.decisions || [])] : listDecisions({ home, status: 'pending' });
  if (!pending.length) return { message: '朝バッチ: 取り込み対象なし', count: 0, sent: false };
  const message = formatMorning(pending);
  if (dryRun) return { message, count: pending.length, sent: false, dryRun: true };
  let warning = null;
  const resolvedWebhook = webhookUrl || process.env.ORGIAST_INBOX_WEBHOOK?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-webhook.txt'));
  try {
    if (!resolvedWebhook) throw new Error('Discord Webhook URLが見つかりません');
    await postWebhook(resolvedWebhook, message, { fetchImpl, sleepImpl });
  } catch (error) { warning = redactSecrets(error?.message ?? error); }
  const date = localDate(now);
  appendNextSession(home, pending, date);
  markDecisions(pending.map((item) => item.id), { home, status: 'batched', batchDate: date });
  return { message, count: pending.length, sent: !warning, warning };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const result = await runMorning({ dryRun: args.includes('--dry-run') });
    console.log(result.message);
    if (result.warning) console.warn(`警告: ${result.warning}`);
    return 0;
  } catch (error) { console.error(`morning-batch: ${redactSecrets(error?.message ?? error)}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
