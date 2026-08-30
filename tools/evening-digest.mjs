#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { userHome } from './batch-enqueue.mjs';
import { isEntry } from './is-entry.mjs';
import { postWebhook } from './morning-batch.mjs';
import { listDecisions } from './pending-decisions.mjs';
import { redactSecrets } from './webhook-health.mjs';

const TYPES = new Set(['results-daily-digest', 'auto-session-digest', 'executor-usage-digest', 'next-session-todo-triage']);
const TITLES = { 'results-daily-digest': '今日の結果', 'auto-session-digest': '今日の自動セッション', 'executor-usage-digest': '今日の委譲実績', 'next-session-todo-triage': '次回TODO整理' };
function readTrimmed(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function localDate(value) { const date = new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function readResults(home, date) {
  const file = path.join(home, '.claude', 'batch-queue', `results-${date}.jsonl`);
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line); return TYPES.has(item.jobType) ? [item] : []; } catch { return []; } }); } catch { return []; }
}
export function formatEvening(date, results, unresolved) {
  if (!results.length) return `🌙 夕方ダイジェスト (${date}): 今日は特筆事項なし / 未処理の判断: ${unresolved}件`;
  const lines = [`🌙 夕方ダイジェスト (${date})`];
  for (const item of results) lines.push(`### ${TITLES[item.jobType]}`, String(item.text || '').slice(0, 300));
  lines.push(`未処理の判断: ${unresolved}件`);
  return lines.join('\n');
}
export async function runEvening({ home = userHome(), now = new Date(), force = false, dryRun = false, fetchImpl = fetch, sleepImpl, webhookUrl } = {}) {
  const date = localDate(now);
  const stateFile = path.join(home, '.claude', 'evening-digest-state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  if (!force && state.lastSentDate === date) return { skipped: true, message: `夕方ダイジェスト: ${date} は送信済み` };
  const results = readResults(home, date);
  const unresolved = listDecisions({ home }).filter((item) => item.status !== 'resolved').length;
  const message = formatEvening(date, results, unresolved);
  if (dryRun) return { skipped: false, sent: false, dryRun: true, message };
  const resolvedWebhook = webhookUrl || process.env.ORGIAST_INBOX_WEBHOOK?.trim() || readTrimmed(path.join(home, '.claude', 'orgiast-discord-webhook.txt'));
  if (!resolvedWebhook) throw new Error('Discord Webhook URLが見つかりません');
  await postWebhook(resolvedWebhook, message, { fetchImpl, sleepImpl, username: 'orgiast evening digest' });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ lastSentDate: date })}\n`);
  fs.renameSync(tmp, stateFile);
  return { skipped: false, sent: true, message };
}
export async function main(args = process.argv.slice(2)) {
  try { const result = await runEvening({ force: args.includes('--force'), dryRun: args.includes('--dry-run') }); console.log(result.message); return 0; }
  catch (error) { console.error(`evening-digest: ${redactSecrets(error?.message ?? error)}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
