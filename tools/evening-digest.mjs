#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { fetchMessages } from './discord-digest.mjs';
import { resolveChannelId } from './discord-inbox-intake.mjs';
import { isEntry } from './is-entry.mjs';
import { postWebhook } from './morning-batch.mjs';
import { notifyKim } from './notify-kim.mjs';
import { listDecisions } from './pending-decisions.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { reportHeartbeat } from './lib/heartbeat.mjs';

const TYPES = new Set(['results-daily-digest', 'auto-session-digest', 'executor-usage-digest', 'next-session-todo-triage']);
const TITLES = { 'results-daily-digest': '今日の結果', 'auto-session-digest': '今日の自動セッション', 'executor-usage-digest': '今日の委譲実績', 'next-session-todo-triage': '次回TODO整理' };
function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function localDate(value) { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function readResults(home, date) {
  const file = path.join(home, '.claude', 'batch-queue', `results-${date}.jsonl`);
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line); return TYPES.has(item.jobType) ? [item] : []; } catch { return []; } }); } catch { return []; }
}
export function formatEvening(date, results, unresolved, alerts = null) {
  const lines = results.length
    ? [`🌙 夕方ダイジェスト (${date})`]
    : [`🌙 夕方ダイジェスト (${date}): 今日は特筆事項なし`];
  for (const item of results) lines.push(`### ${TITLES[item.jobType]}`, String(item.text || '').slice(0, 300));
  if (alerts) {
    lines.push(alerts.count ? `🚨 今日のアラート: ${alerts.count}件` : '🚨 今日のアラート: なし');
    for (const summary of alerts.summaries) lines.push(`- ${summary}`);
  }
  lines.push(`未処理の判断: ${unresolved}件`);
  return lines.join('\n');
}
async function readTodayAlerts({ home, now, token, channelId, fetchMessagesImpl }) {
  if (!token) return null;
  const resolvedChannelId = resolveChannelId({ home, channelId });
  if (!resolvedChannelId) return null;
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const result = await fetchMessagesImpl({ channelId: resolvedChannelId, limit: 100, since: start.getTime(), token });
  const messages = Array.isArray(result) ? result : result?.messages;
  if (!Array.isArray(messages)) throw new Error('Discord API の応答が配列ではありません');
  const alerts = messages.filter((message) => {
    const timestamp = Date.parse(message?.timestamp || '');
    return message?.author?.bot === true && String(message?.content || '').includes('🚨')
      && (!Number.isFinite(timestamp) || timestamp >= start.getTime());
  });
  return { count: alerts.length, summaries: alerts.slice(0, 3).map((message) => String(message.content).split(/\r?\n/, 1)[0]) };
}
export async function runEvening({ home = userHome(), now = new Date(), force = false, dryRun = false, fetchImpl = fetch, fetchMessagesImpl = fetchMessages, sleepImpl, webhookUrl, channelId, token, notifyKimImpl = notifyKim, reportHeartbeatImpl = reportHeartbeat } = {}) {
  const date = localDate(now);
  const stateFile = path.join(home, '.claude', 'evening-digest-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (!force && state.lastSentDate === date) return { skipped: true, message: `夕方ダイジェスト: ${date} は送信済み` };
  const results = readResults(home, date);
  const unresolved = listDecisions({ home }).filter((item) => item.status !== 'resolved').length;
  const resolvedToken = token || process.env.DISCORD_BOT_TOKEN?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-bot-token.txt'));
  let alerts = null;
  try { alerts = await readTodayAlerts({ home, now, token: resolvedToken, channelId, fetchMessagesImpl }); } catch {}
  const message = formatEvening(date, results, unresolved, alerts);
  if (dryRun) return { skipped: false, sent: false, dryRun: true, message };
  const resolvedWebhook = webhookUrl || process.env.ORGIAST_INBOX_WEBHOOK?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-webhook.txt'));
  const delivery = await notifyKimImpl(message, { home, token: resolvedToken, fetchImpl });
  if (delivery?.delivered === 'none') {
    if (!resolvedWebhook) throw new Error('Discord Webhook URLが見つかりません');
    await postWebhook(resolvedWebhook, message, { fetchImpl, sleepImpl, username: 'orgiast evening digest' });
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ lastSentDate: date })}\n`);
  fs.renameSync(tmp, stateFile);
  try {
    await reportHeartbeatImpl({ job: 'evening-digest', startedAt: now.toISOString(), finishedAt: new Date().toISOString(), ok: true, summary: message.slice(0, 200) }, { homeDir: home });
  } catch (error) {
    console.warn(`evening-digest: heartbeat送信失敗（本体には影響しません）: ${error?.message ?? error}`);
  }
  return { skipped: false, sent: true, message };
}
export async function main(args = process.argv.slice(2)) {
  try { const result = await runEvening({ force: args.includes('--force'), dryRun: args.includes('--dry-run') }); console.log(result.message); return 0; }
  catch (error) { console.error(`evening-digest: ${redactSecrets(error?.message ?? error)}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
