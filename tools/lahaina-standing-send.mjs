import { registerDailyPhotoTema } from './lahaina-daily-message.mjs';
import fs from 'node:fs';
import os from 'node:os';
import { enqueueItems, getItem, saveDraft, decide } from './reply-queue.mjs';
import { sendApproved } from './daily-beeper-approval.mjs';
import { listChats } from './beeper-api.mjs';
import { addItem } from './kim-inbox.mjs';
import { TITLE, assertStandingScope, findChat, hash, dailyDir } from './lahaina-standing-policy.mjs';
import path from 'node:path';

export async function notifyStandingInfo(home, date, reason, inbox = addItem) {
  await inbox(home, { kind: 'info', text: `【${date} ラハイナ日次お題】自動送信を停止しました。${reason}`,
    source: 'lahaina-standing-approval', dedupeKey: `lahaina-standing:${date}:${hash(reason).slice(0, 16)}` }, { drain: false });
}

export async function sendStandingDaily({ date, text, dryRun = false, home = process.env.ORGIAST_HOME || os.homedir(),
  now, calendarPath, sentPath, title = TITLE, readChats = listChats, inbox = addItem, readMessages, exec } = {}) {
  const clock = () => now || new Date();
  let queueID;
  let lock;
  const lockPath = path.join(dailyDir(home), 'standing-send.lock');
  try {
    if (!dryRun) lock = fs.openSync(lockPath, 'wx', 0o600);
    const scope = () => assertStandingScope({ home, date, text, title, now: clock(), calendarPath, sentPath });
    const { evidence } = scope();
    await registerDailyPhotoTema(text, date, { home, dryRun, addItemImpl: inbox });
    const chat = await findChat(title, readChats);
    if (dryRun) return { dryRun: true, route: 'beeper-standing-approval', date, chatID: chat.id, eligible: true };
    const queued = enqueueItems(home, [{ channel: 'line', thread: chat.id, message: `daily-post:${date}`,
      from: { name: title, external: true }, body: text, category: 'daily-post' }], { now: clock() });
    queueID = queued.added[0] || queued.duplicates[0];
    let item = getItem(home, queueID);
    if (item.body !== text || (item.draft && item.draft.text !== text)) throw new Error('キューの本文が承認範囲と一致しません');
    if (item.state === 'sent') throw new Error('当日はキューで送信済みです（1日1通）');
    if (item.state === 'queued' && item.history.some(row => row.note?.startsWith('context_changed'))) throw new Error('文脈変更のため自動再承認しません');
    if (item.state === 'queued') { saveDraft(home, queueID, { text, now: clock() }); item = getItem(home, queueID); }
    scope();
    if (['drafted', 'presented'].includes(item.state)) {
      // Real standing authorization is recorded through the existing decision API.
      item = await decide(home, queueID, { verdict: 'approved', reason: evidence, now: clock() });
    }
    if (item.state !== 'approved' || item.decision?.reason !== evidence) throw new Error(`再送または承認範囲外のキュー状態です: ${item.state}`);
    const result = await sendApproved(queueID, { home, now: clock(), readMessages, exec });
    return { ...result, state: 'sent', queueID };
  } catch (error) {
    // Do not expose child stdout/stderr (history or secrets) in the inbox.
    const reason = error.code === 'EEXIST' ? '同時実行または未解決の実行記録があります。自動再送禁止'
      : error.stdout !== undefined || error.stderr !== undefined ? '送信前チェックまたは送信処理が失敗・不確定です。キューの確認が必要です' : error.message;
    if (!dryRun) await notifyStandingInfo(home, date, reason, inbox);
    return { dryRun, state: 'blocked', queueID, reason, eligible: false };
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(lockPath); }
  }
}
