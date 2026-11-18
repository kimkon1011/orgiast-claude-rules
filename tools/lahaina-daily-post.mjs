import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, appendFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { prepareApproval } from './daily-beeper-approval.mjs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_DIR = join(process.env.ORGIAST_HOME || homedir(), '.claude', 'lahaina-daily-post');
export const CALENDAR_PATH = join(PROJECT_DIR, 'calendar.json');
export const SENT_PATH = join(PROJECT_DIR, 'sent.jsonl');
export const QUOTA_PATH = join(PROJECT_DIR, 'quota-wait.json');
export const RUN_LOG_PATH = join(PROJECT_DIR, 'runs.jsonl');
export const NIGHTLY_REPO = fileURLToPath(new URL('..', import.meta.url));
export const SEND_TOOL = join(NIGHTLY_REPO, 'tools', 'line-group-send.mjs');
export const GROUP_ID = 'C812a1d8216456feca9043b9f8d3bd35d';

export function tokyoToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function nextMonthFirst(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 1)); // m is 1-indexed → Date.UTC adds 1 month
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function weekdayJa(date) {
  const index = new Date(`${date}T00:00:00Z`).getUTCDay();
  return '日月火水木金土'[index];
}

export function retryUuid(date) {
  const hex = createHash('sha256').update(`lahaina-daily-${date}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[Number.parseInt(hex[16], 16) % 4];
  const raw = hex.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function findEntry(calendar, date) {
  return calendar.find((entry) => entry.date === date);
}

export function formatMessage(entry) {
  const [, month, day] = entry.date.split('-').map(Number);
  return `【今日のインスタ用 写真のお願い】${month}/${day}（${weekdayJa(entry.date)}）\n` +
    `テーマ：${entry.theme}\n` +
    `お願い：${entry.ask}\n\n` +
    'このグループに、写真1〜3枚と一言コメント（20字くらい）をお昼12時までに送ってください。\n' +
    '写真の明るさ調整と投稿文はこちらで作ります。お客様のお顔・車のナンバーは写さないでください。';
}

export function wasSent(sentText, date) {
  return sentText.split(/\r?\n/).filter(Boolean).some((line) => {
    try {
      const record = JSON.parse(line);
      return record.date === date && record.failed !== true;
    } catch { return false; }
  });
}

export function invokeSender({ text, date, dryRun }) {
  const tempPath = join(tmpdir(), `lahaina-daily-${process.pid}-${Date.now()}.txt`);
  writeFileSync(tempPath, text, 'utf8');
  try {
    const args = [SEND_TOOL, '--group', GROUP_ID, '--text-file', tempPath, '--retry-key', retryUuid(date), '--skip-context-check'];
    if (dryRun) args.push('--dry-run');
    return execFileSync(process.execPath, args, {
      cwd: NIGHTLY_REPO, encoding: 'utf8', timeout: 60000,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
  } finally {
    try { unlinkSync(tempPath); } catch {}
  }
}

export const beeperFallback = options => prepareApproval({ ...options, title: '株式会社ラハイナ' });

export async function run({
  date = tokyoToday(), dryRun = false, calendarPath = CALENDAR_PATH, sentPath = SENT_PATH,
  quotaPath = QUOTA_PATH, sender = invokeSender, fallback = beeperFallback, log = console.log,
  scheduled = false, now = new Date()
} = {}) {
  const hour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', hourCycle: 'h23'
  }).format(now));
  if (scheduled && hour < 9) { log('09:00前のため待機'); return 0; }
  const calendar = JSON.parse(readFileSync(calendarPath, 'utf8'));
  const entry = findEntry(calendar, date);
  if (!entry) { log(`本日分なし: ${date}`); return 0; }

  // 枠待ちチェック — quota-wait.json の until が date より後なら送信をスキップ
  let quota = null;
  try {
    quota = JSON.parse(readFileSync(quotaPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  let sentText = '';
  try { sentText = readFileSync(sentPath, 'utf8'); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (wasSent(sentText, date)) { log(`送信済み: ${date}`); return 0; }

  const text = formatMessage(entry);
  log(text);
  const requestBeeper = async () => {
    const result = await fallback({ text, date, dryRun });
    log(JSON.stringify(result));
    if (result.state === 'sent' && !dryRun) appendFileSync(sentPath, JSON.stringify({ date, route: 'beeper', queueID: result.queueID, sentAt: new Date().toISOString() }) + '\n', 'utf8');
    return 0;
  };
  if (quota && quota.until > date) return requestBeeper();
  try {
    const stdout = await sender({ text, date, dryRun });
    if (stdout) log(stdout.trimEnd());
    if (dryRun) return 0;
    if (!/^push 1\/1: HTTP 200 sentMessages=1 ids=\S+ retryKey=/m.test(stdout ?? '')) {
      throw new Error('LINE送信結果に HTTP 200 / sentMessages=1 がありません');
    }
    appendFileSync(sentPath, `${JSON.stringify({ date, sentAt: new Date().toISOString(), groupId: GROUP_ID, retryKey: retryUuid(date), stdout })}\n`, 'utf8');
    return 0;
  } catch (error) {
    const message = [error.stderr?.toString().trim(), error.message].filter(Boolean).join('\n');
    if (/429/.test(message) && /monthly limit/i.test(message)) {
      const until = nextMonthFirst(date);
      if (!dryRun) writeFileSync(quotaPath, JSON.stringify({ detectedAt: new Date().toISOString(), until, reason: 'LINE monthly limit' }, null, 2) + '\n', 'utf8');
      log('LINE月間上限: 無料のBeeper経路で当日分を承認待ちにします');
      return requestBeeper();
    }
    throw error;
  }
}

export function parseArgs(argv) {
  let date;
  let dryRun = false;
  let scheduled = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--date') date = argv[++index];
    else if (argv[index] === '--dry-run') dryRun = true;
    else if (argv[index] === '--scheduled') scheduled = true;
    else throw new Error(`不明な引数: ${argv[index]}`);
  }
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日付形式が不正です: ${date}`);
  return { date, dryRun, scheduled };
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = new Date().toISOString();
  const output = [];
  const log = (text) => { output.push(String(text)); console.log(text); };
  try { process.exitCode = await run({ ...parseArgs(argv), log }); }
  catch (error) {
    const message = error.stderr?.toString().trim() || error.message;
    output.push(message); console.error(message); process.exitCode = 1;
  }
  appendFileSync(RUN_LOG_PATH, `${JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), exitCode: process.exitCode, output })}\n`, 'utf8');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
