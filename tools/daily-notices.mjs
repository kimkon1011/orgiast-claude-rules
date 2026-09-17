import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readAiNews } from './ai-news-inject.mjs';
import { runPendingNotice } from './gtasks-pending-notice.mjs';
import { notifyKim } from './notify-kim.mjs';

// 夜間バッチが既存 evening-digest の --daily-notices 経路から呼ぶ。
export async function runDailyNotices({ home = process.env.ORGIAST_HOME || os.homedir(), now = new Date(), dryRun = false,
  readNews = readAiNews, readTasks = runPendingNotice, notify = notifyKim } = {}) {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const file = path.join(home, '.claude', 'daily-notices-state.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // 夜間バッチの二重起動で同じDMを送らない。異常終了のlockは10分後に失効。
  const lock = `${file}.lock`;
  let locked = false;
  if (!dryRun) {
    try {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 600_000) fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.closeSync(fs.openSync(lock, 'wx'));
      locked = true;
    } catch (error) {
      if (error.code === 'EEXIST') return { message: 'skip:日次通知は実行中' };
      throw error;
    }
  }
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.date === date && state.complete) return { message: 'skip:日次通知は送信済み' };
    const [news, tasks] = await Promise.all([
      readNews({ home }),
      readTasks({ cacheFile: path.join(home, '.claude', 'gtasks-pending-cache.json'), now: () => now, stdout: () => {} }),
    ]);
    const body = [`日次通知 (${date})`, news, tasks].filter(Boolean).join('\n\n');
    if (!news && !tasks) return { message: 'skip:日次通知なし' };
    // notify-kim の2000文字切り詰めでタスクが消えないよう、全出力を分割して送る。
    const chunks = [''];
    for (const character of body) {
      if (chunks.at(-1).length + character.length > 1800) chunks.push('');
      chunks[chunks.length - 1] += character;
    }
    if (dryRun) return { message: body, dryRun: true };
    let sent = state.date === date && state.body === body ? state.sent || 0 : 0;
    const save = complete => {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ date, body, sent, complete }));
      fs.renameSync(tmp, file);
    };
    for (; sent < chunks.length;) {
      const result = await notify(chunks[sent], { home, webhookFallback: false });
      if (result?.delivered !== 'dm') throw new Error('日次通知のDiscord DM送信に失敗');
      sent++;
      save(sent === chunks.length);
    }
    return { message: `ok:日次通知 ${chunks.length}通をDM送信` };
  } finally {
    if (locked) fs.unlinkSync(lock);
  }
}
