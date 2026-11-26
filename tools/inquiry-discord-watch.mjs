// Watch inquiry-sheet rows and send a second-path notification to Discord.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { INQUIRY_SHEET, INQUIRY_TAB, readSheet, excludedInquiry } from './lib/inquiry-sheet.mjs';

export const CHANNEL_ID = '1382885390138216549';
export const WEBHOOK_ID = '1514143367154630696';
const ROLE_ID = '1382575757997379596';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${INQUIRY_SHEET}/edit?gid=88076728#gid=88076728`;
const TEST_CONTENT = '【通知テスト】オージャストHP問い合わせ通知の疎通確認です。対応は不要です。（自動投稿・確認後に削除します）';

export function notificationContent(rowNumber) {
  return `<@&${ROLE_ID}>\nオージャストHPに新しい問い合わせが入りました。\nシートの${rowNumber}行目の対応をお願いします。\n対応後はM列を「完了」にしてください。\n${SHEET_URL}`;
}

export function selectTargetRows({ values, headers = values[0] || [], notifiedRows, lastNotifiedRow, limit = 30 }) {
  let finalRow = 1;
  for (let i = 1; i < values.length; i++) if (String(values[i]?.[0] ?? '').trim()) finalRow = i + 1;
  const targets = [];
  for (let rowNumber = lastNotifiedRow + 1; rowNumber <= finalRow && targets.length < limit; rowNumber++) {
    const row = values[rowNumber - 1] || [];
    if (!notifiedRows.has(rowNumber) && !excludedInquiry(row, headers)) targets.push({ rowNumber, row });
  }
  return targets;
}

function botToken() {
  return process.env.DISCORD_BOT_TOKEN?.trim() || fs.readFileSync(path.join(os.homedir(), '.claude', 'orgiast-discord-bot-token.txt'), 'utf8').trim();
}

async function jsonResponse(response, label) {
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok) throw new Error(`${label} HTTP ${response.status}: ${String(data.message || text).slice(0, 1000)}`);
  return data;
}

export async function readDiscordNotifications({ fetchImpl = globalThis.fetch, token = botToken() } = {}) {
  const notifiedRows = new Set();
  let lastNotifiedAt = null;
  let before = '';
  for (let page = 0; page < 3; page++) {
    const query = new URLSearchParams({ limit: '100', ...(before ? { before } : {}) });
    const response = await fetchImpl(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?${query}`, { headers: { Authorization: `Bot ${token}` } });
    const messages = await jsonResponse(response, 'Discord messages');
    if (!Array.isArray(messages)) throw new Error('Discord messages response is not an array');
    for (const message of messages) {
      const match = String(message.content || '').match(/シートの(\d+)行目/);
      if (!match) continue;
      notifiedRows.add(Number(match[1]));
      const time = Date.parse(message.timestamp || '');
      if (Number.isFinite(time) && (lastNotifiedAt === null || time > lastNotifiedAt)) lastNotifiedAt = time;
    }
    if (messages.length < 100) break;
    before = String(messages.at(-1)?.id || '');
    if (!before) break;
  }
  if (!notifiedRows.size) throw new Error('Discordから通知済み行番号を1件も取得できませんでした');
  return { notifiedRows, lastNotifiedRow: Math.max(...notifiedRows), lastNotifiedAt };
}

async function webhookToken({ fetchImpl, token }) {
  const response = await fetchImpl(`https://discord.com/api/v10/webhooks/${WEBHOOK_ID}`, { headers: { Authorization: `Bot ${token}` } });
  const data = await jsonResponse(response, 'Discord webhook lookup');
  if (!data.token) throw new Error('Discord webhook lookup returned no token');
  return data.token;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function postWebhook(content, { fetchImpl = globalThis.fetch, token = botToken(), webhookTokenValue, wait = false, sleepImpl = sleep } = {}) {
  const secret = webhookTokenValue || await webhookToken({ fetchImpl, token });
  const url = `https://discord.com/api/webhooks/${WEBHOOK_ID}/${secret}${wait ? '?wait=true' : ''}`;
  const request = () => fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content, allowed_mentions: { parse: ['roles'] } }) });
  let response = await request();
  if (response.status === 429) {
    const rateLimit = await response.json().catch(() => ({}));
    await sleepImpl(Math.max(0, Number(rateLimit.retry_after) || 0) * 1000);
    response = await request();
  }
  return jsonResponse(response, 'Discord webhook POST');
}

function statePath(home = os.homedir()) { return path.join(home, '.claude', 'inquiry-discord-watch.json'); }

function writeState(state, home = os.homedir()) {
  const file = statePath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function warnKimInbox(text, dedupeKey, { spawnImpl = spawnSync } = {}) {
  const bodyFile = path.join(os.tmpdir(), `inquiry-discord-watch-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(bodyFile, text, 'utf8');
  try {
    const result = spawnImpl(process.execPath, [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--add', 'ask', '--body-file', bodyFile, '--dedupe-key', dedupeKey, '--source', 'inquiry-discord-watch'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    if (result.status !== 0) process.stderr.write(`kim-inbox warning failed: ${String(result.stderr || '').trim()}\n`);
  } finally { fs.rmSync(bodyFile, { force: true }); }
}

export async function runNormal({ fetchImpl = globalThis.fetch, readSheetImpl = readSheet, sleepImpl = sleep, token = botToken(), limit = 30, dryRun = false, now = new Date(), warnImpl = warnKimInbox, home = os.homedir() } = {}) {
  let history;
  try { history = await readDiscordNotifications({ fetchImpl, token }); }
  catch (error) {
    warnImpl(`問い合わせDiscord見張り: 通知済み行の取得失敗\n${error.message}`, `inquiry-discord-watch-no-history-${now.toISOString().slice(0, 10)}`);
    writeState({ lastNotifiedRow: null, lastRunAt: now.toISOString(), lastPostedAt: null, lastError: error.message }, home);
    return { exitCode: 1, posted: 0, error };
  }
  const values = await readSheetImpl(INQUIRY_SHEET, INQUIRY_TAB);
  const targets = selectTargetRows({ values, headers: values[0] || [], notifiedRows: history.notifiedRows, lastNotifiedRow: history.lastNotifiedRow, limit });
  if (dryRun) {
    for (const target of targets) console.log(`${target.rowNumber}\t${notificationContent(target.rowNumber).split('\n')[0]}`);
    return { exitCode: 0, posted: 0, targets };
  }
  let secret;
  let posted = 0;
  const postedRows = [];
  let lastPostedAt = null;
  let lastError = null;
  for (let index = 0; index < targets.length; index++) {
    const target = targets[index];
    try {
      secret ||= await webhookToken({ fetchImpl, token });
      if (index > 0) await sleepImpl(1500);
      await postWebhook(notificationContent(target.rowNumber), { fetchImpl, token, webhookTokenValue: secret, sleepImpl });
      posted++;
      postedRows.push(target.rowNumber);
      lastPostedAt = new Date().toISOString();
    } catch (error) {
      lastError = `行${target.rowNumber}: ${error.message}`;
      warnImpl(`問い合わせDiscord見張り: 投稿失敗\n${lastError}`, `inquiry-discord-watch-post-error-${now.toISOString().slice(0, 10)}`);
    }
  }
  if (posted > 0 && history.lastNotifiedAt !== null && now.getTime() - history.lastNotifiedAt >= 6 * 3600_000) {
    warnImpl(`問い合わせDiscord見張り: GAS停止の疑い\nDiscord上の最終通知から6時間以上空いた後、第2系統が${posted}件投稿しました。`, `inquiry-discord-watch-gas-down-${now.toISOString().slice(0, 10)}`);
  }
  writeState({ lastNotifiedRow: postedRows.length ? Math.max(history.lastNotifiedRow, ...postedRows) : history.lastNotifiedRow, lastRunAt: now.toISOString(), lastPostedAt, lastError }, home);
  return { exitCode: lastError ? 1 : 0, posted, targets };
}

export function parseArgs(args) {
  const options = { dryRun: false, limit: 30, test: false, deleteMessage: null, help: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') options.dryRun = true;
    else if (args[i] === '--test') options.test = true;
    else if (args[i] === '--help' || args[i] === '-h') options.help = true;
    else if (args[i] === '--limit') { options.limit = Number(args[++i]); if (!Number.isInteger(options.limit) || options.limit < 1) throw new Error('--limit は1以上の整数で指定してください'); }
    else if (args[i] === '--delete-message') { options.deleteMessage = args[++i]; if (!/^\d+$/.test(options.deleteMessage || '')) throw new Error('--delete-message にはメッセージIDが必要です'); }
    else throw new Error(`不明な引数: ${args[i]}`);
  }
  return options;
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(args);
  if (options.help) {
    console.log('Usage: node tools/inquiry-discord-watch.mjs [--dry-run] [--limit <n>] [--test] [--delete-message <id>]');
    return 0;
  }
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const token = dependencies.token || botToken();
  if (options.deleteMessage) {
    const response = await fetchImpl(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${options.deleteMessage}`, { method: 'DELETE', headers: { Authorization: `Bot ${token}` } });
    if (!response.ok) await jsonResponse(response, 'Discord message DELETE');
    return 0;
  }
  if (options.test) {
    const data = await postWebhook(TEST_CONTENT, { ...dependencies, fetchImpl, token, wait: true });
    if (!data.id) throw new Error('テスト投稿のメッセージIDを取得できませんでした');
    console.log(data.id);
    return 0;
  }
  const result = await runNormal({ ...dependencies, fetchImpl, token, limit: options.limit, dryRun: options.dryRun });
  return result.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
