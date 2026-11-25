// This policy implements kim's 2026-11-19 instruction, only for the fixed calendar.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tokyoToday, formatMessage } from './lahaina-daily-message.mjs';

export const TITLE = '株式会社ラハイナ';
export const APPROVAL_ID = 'lahaina-daily-2026-11-19';
export const QUOTES = ['お題は自動送信して、なんども送ってっていってるのに、', 'ユーザーの手間がかかりすぎです'];
export const hash = text => createHash('sha256').update(text).digest('hex');
export const dailyDir = home => path.join(home, '.claude', 'lahaina-daily-post');
export const policyPath = home => path.join(dailyDir(home), 'standing-approval.json');
export const attemptPath = (home, date) => path.join(dailyDir(home), `beeper-attempt-${date}.json`);

export function assertStandingScope({ home, date, text, title = TITLE, now = new Date(), calendarPath = path.join(dailyDir(home), 'calendar.json'), sentPath = path.join(dailyDir(home), 'sent.jsonl') }) {
  const policy = JSON.parse(fs.readFileSync(policyPath(home), 'utf8'));
  const fail = reason => { throw new Error(reason); };
  if (policy.id !== APPROVAL_ID || policy.enabled !== true || policy.approvedBy !== 'kim' || policy.approvedOn !== '2026-11-19'
    || JSON.stringify(policy.quotes) !== JSON.stringify(QUOTES)) fail('常設承認が無効です');
  const scope = policy.scope;
  if (scope?.title !== TITLE || title !== TITLE || scope.channel !== 'beeper' || scope.exactChatCount !== 1
    || scope.body !== 'calendar.json:today' || scope.maxPerDay !== 1 || scope.timeZone !== 'Asia/Tokyo'
    || scope.start !== '09:00:00' || scope.end !== '11:30:00') fail('常設承認の宛先または範囲が一致しません');
  if (date !== tokyoToday(now)) fail('当日分以外は送信できません');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now);
  if (time < scope.start || time > scope.end) fail('送信時間帯外です（JST 09:00〜11:30）');
  const entries = JSON.parse(fs.readFileSync(calendarPath, 'utf8')).filter(entry => entry.date === date);
  if (entries.length !== 1 || text !== formatMessage(entries[0]) || policy.approvedBodyHashes?.[date] !== hash(text)) fail('本文が承認済みcalendar.jsonの当日分と一致しません');
  let records = '';
  try { records = fs.readFileSync(sentPath, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Malformed records fail closed: an unreadable delivery must not become permission to retry.
  if (records.split(/\r?\n/).filter(Boolean).map(JSON.parse).some(row => row.date === date && row.failed !== true)) fail('当日は送信済みです（1日1通）');
  if (fs.existsSync(attemptPath(home, date))) fail('当日の送信試行記録があります。自動再送禁止');
  return { policy, evidence: JSON.stringify({ type: 'standing-approval', id: policy.id, approvedBy: policy.approvedBy,
    approvedOn: policy.approvedOn, quotes: policy.quotes, policySha256: hash(JSON.stringify(policy)), date, bodySha256: hash(text) }) };
}

// An exclusive, durable claim is written immediately before transport. Never auto-expire it.
export function claimStandingAttempt(home, date, queueID, now = new Date()) {
  const fd = fs.openSync(attemptPath(home, date), 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ date, queueID, attemptedAt: now.toISOString() }) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

export async function findChat(title, read) {
  let cursor;
  const matches = new Map(), seen = new Set();
  for (let page = 0; page < 100; page++) {
    const result = await read({ limit: 200, cursor, direction: cursor ? 'before' : undefined });
    for (const chat of result.items || []) if (chat.title === title) matches.set(chat.id, chat);
    if (!result.hasMore) {
      if (matches.size !== 1 || ![...matches.keys()][0]) throw new Error(`Beeper title一致は1件必要です（${matches.size}件）`);
      return [...matches.values()][0];
    }
    if (!result.oldestCursor || seen.has(result.oldestCursor)) throw new Error('Beeper chat pagination stalled');
    seen.add(result.oldestCursor); cursor = result.oldestCursor;
  }
  throw new Error('Beeper chat pagination limit');
}
