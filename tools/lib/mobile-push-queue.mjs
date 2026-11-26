// スマホの Claude アプリへの通知要求キュー（cr 2026-11-06 指示）。
// PushNotification ツールは対話中の Claude Code セッションからしか送れないため、
// notify-owner は Discord DM の代わりにここへ要求を積み、auto-progress-inbox-hook が
// 対話セッションに送信指示を出し、セッションが送信後に markSent で落とす。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const ATTEMPT_LIMIT = 3;
/** 再掲回数がこの値以上の未送信は届かない席の滞留とみなし削除する */
export const DEFAULT_OCCURRENCE_EXPIRE_THRESHOLD = 10;
export const mobilePushQueueFile = home => path.join(home, '.claude', 'mobile-push-queue.jsonl');

function rowActivityTime(row) {
  return Date.parse(row.lastQueuedAt || row.queuedAt || row.ts) || 0;
}

export function appendMobilePush(home, { owner, title, body }, { now = Date.now(), id = randomUUID() } = {}) {
  const file = mobilePushQueueFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = { id, queuedAt: new Date(now).toISOString(), ts: new Date(now).toISOString(), owner: String(owner || ''), title: String(title || '').slice(0, 100), body: String(body || ''), sent: false };
  fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
  return row;
}

export function sweepMobilePushQueue(home, {
  dryRun = false,
  now = Date.now(),
  collapseByTitle = true,
  occurrenceExpireThreshold = DEFAULT_OCCURRENCE_EXPIRE_THRESHOLD,
} = {}) {
  const file = mobilePushQueueFile(home);
  const ttlHours = parseInt(process.env.MOBILE_PUSH_TTL_HOURS, 10) || 72;
  const ttlMs = ttlHours * 60 * 60 * 1000;

  // ロック取得
  const lock = `${file}.lock`;
  let fd;
  for (let retry = 0; retry < 100; retry++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (retry === 99) throw new Error('mobile-push queue is locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  try {
    const queue = readMobilePushQueue(home);
    const deduplicated = {};
    const sweepResult = { deduplicated: 0, expired: 0 };

    // 重複圧縮（本文まで同一）
    let processedQueue = queue.map(row => {
      if (row.status === 'expired' || row.sent === true) return row;

      const key = `${row.title}||${row.body}`;
      if (deduplicated[key]) {
        const existing = deduplicated[key];
        existing.occurrences = (existing.occurrences || 1) + 1;
        // lastQueuedAt を更新 (新しい方を使う)
        const currentQueuedAt = row.queuedAt || row.ts;
        if (currentQueuedAt && (!existing.lastQueuedAt || Date.parse(currentQueuedAt) > Date.parse(existing.lastQueuedAt))) {
          existing.lastQueuedAt = currentQueuedAt;
        }
        sweepResult.deduplicated++;
        return null; // マージ済みのため削除対象
      } else {
        deduplicated[key] = row;
        if (!row.queuedAt) {
          // 古いエントリには queuedAt を追加
          row.queuedAt = row.ts;
        }
        if (!row.occurrences) {
          row.occurrences = 1;
        }
        // lastQueuedAt がない場合は queuedAt または ts を使う
        if (!row.lastQueuedAt) {
          row.lastQueuedAt = row.queuedAt;
        }
        return row;
      }
    }).filter(row => row !== null);

    // スナップショット型圧縮: 同じ owner+title の未送信は最新1件だけ残す
    if (collapseByTitle) {
      const winners = new Map();
      for (const row of processedQueue) {
        if (row.status === 'expired' || row.sent === true) continue;
        const key = `${String(row.owner)}||${String(row.title)}`;
        const existing = winners.get(key);
        if (!existing || rowActivityTime(row) >= rowActivityTime(existing)) {
          winners.set(key, row);
        }
      }
      const next = [];
      for (const row of processedQueue) {
        if (row.status === 'expired' || row.sent === true) {
          next.push(row);
          continue;
        }
        const key = `${String(row.owner)}||${String(row.title)}`;
        if (winners.get(key) === row) {
          next.push(row);
        } else {
          sweepResult.deduplicated++;
        }
      }
      processedQueue = next;
    }

    // 再掲回数上限: 届かない席で積み上がった未送信を削除
    processedQueue = processedQueue.filter(row => {
      if (row.status === 'expired' || row.sent === true) return true;
      if ((Number(row.occurrences) || 1) >= occurrenceExpireThreshold) {
        sweepResult.expired++;
        return false;
      }
      return true;
    });

    // TTL expire（削除せず status: expired を付ける）
    const finalQueue = processedQueue.map(row => {
      if (row.status === 'expired' || row.sent === true) return row;

      const queuedTime = row.queuedAt ? Date.parse(row.queuedAt) : Date.parse(row.ts);
      if (isNaN(queuedTime)) return row;

      if ((now - queuedTime) > ttlMs) {
        if (row.status !== 'expired') {
          row.status = 'expired';
          row.expiredAt = new Date(now).toISOString();
          sweepResult.expired++;
        }
      }
      return row;
    });

    if (!dryRun) {
      const temporary = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, finalQueue.map(JSON.stringify).join('\n') + (finalQueue.length ? '\n' : ''), { mode: 0o600 });
      fs.renameSync(temporary, file);
    }

    return sweepResult;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already removed */ }
  }
}

export function readMobilePushQueue(home) {
  try {
    return fs.readFileSync(mobilePushQueueFile(home), 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

export function pendingMobilePush(home, { owners } = {}) {
  const wanted = owners?.map(owner => String(owner).trim().toLowerCase());
  return readMobilePushQueue(home)
    .filter(row => row && row.id && row.sent !== true && row.status !== 'expired')
    .filter(row => !wanted || wanted.includes(String(row.owner || '').trim().toLowerCase()))
    .sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0));
}

export function markMobilePushSent(home, ids, { now = Date.now() } = {}) {
  const file = mobilePushQueueFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // append（notify-owner）との書き込み競合を避けるため、読み直しと書き換えはロック内で行う。
  const lock = `${file}.lock`;
  let fd;
  for (let retry = 0; retry < 100; retry++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (retry === 99) throw new Error('mobile-push queue is locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const wanted = new Set((ids || []).map(String));
    const sentAt = new Date(now).toISOString();
    const marked = [];
    const merged = readMobilePushQueue(home).map(row => {
      if (!wanted.has(String(row.id)) || row.sent === true) return row;
      wanted.delete(String(row.id));
      marked.push(String(row.id));
      return { ...row, sent: true, sentAt };
    });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, merged.map(JSON.stringify).join('\n') + (merged.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { marked, unknown: [...wanted] };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already removed */ }
  }
}

export function markMobilePushAttempt(home, ids, { now = Date.now() } = {}) {
  const file = mobilePushQueueFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // append（notify-owner）との書き込み競合を避けるため、読み直しと書き換えはロック内で行う。
  const lock = `${file}.lock`;
  let fd;
  for (let retry = 0; retry < 100; retry++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (retry === 99) throw new Error('mobile-push queue is locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    const wanted = new Set((ids || []).map(String));
    const lastAttemptAt = new Date(now).toISOString();
    const bumped = [];
    const merged = readMobilePushQueue(home).map(row => {
      if (!wanted.has(String(row.id)) || row.sent === true) return row;
      wanted.delete(String(row.id));
      bumped.push(String(row.id));
      return { ...row, attempts: (Number(row.attempts) || 0) + 1, lastAttemptAt };
    });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, merged.map(JSON.stringify).join('\n') + (merged.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { bumped, unknown: [...wanted] };
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* already removed */ }
  }
}

const oneLine = (text, limit) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const dayMs = 24 * 60 * 60 * 1000;

// 個別表示は最新10件まで。それより古い未送信（24時間超を含む）は1件にまとめる。
export function mobilePushInstruction(home, { now = Date.now(), owner, cliPath, individualLimit = 10 } = {}) {
  const pending = pendingMobilePush(home, owner ? { owners: [owner] } : {});
  if (!pending.length) return '';
  const staleCutoff = now - dayMs;
  const fresh = pending.filter(row => (Date.parse(row.ts) || 0) >= staleCutoff && (Number(row.attempts) || 0) < ATTEMPT_LIMIT);
  // 個別表示は新しい順（最新の進捗を上に）。上限外の古い分は1件にまとめる。
  const individuals = fresh.slice(-individualLimit).reverse();
  const overflow = pending.filter(row => !individuals.includes(row));
  const command = (option, ids) => `node "${cliPath}" ${ids.map(id => `${option} ${id}`).join(' ')}`;
  const items = individuals.map(row => [
    `・${oneLine(row.title, 80) || '(無題)'}`,
    `  本文: ${oneLine(row.body, 300)}`,
    `  → PushNotification ツールで送信後、${command('--mark-sent', [row.id])} を実行`,
    `  → 送れなかった場合は ${command('--mark-attempt', [row.id])} を実行`,
  ].join('\n'));
  if (overflow.length) {
    const oldest = overflow[0];
    items.push([
      `・【古い未送信 ${overflow.length} 件（最古 ${oneLine(oldest.title, 40) || oldest.ts}）】は1回の通知にまとめる（「未送信の進捗通知が${overflow.length}件溜まっています（最古 ${oneLine(oldest.title, 40) || oldest.ts}）」等）`,
      `  → PushNotification ツールで送信後、${command('--mark-sent', overflow.map(row => row.id))} を実行`,
      `  → 送れなかった場合は ${command('--mark-attempt', overflow.map(row => row.id))} を実行`,
    ].join('\n'));
  }
  return [
    `【必須】スマホ通知の送信（未送信 ${pending.length} 件）: 以下の各項目を PushNotification ツールで ${owner || 'user'} のスマホへ送り、各送信直後に示す mark-sent コマンドでキューから消すこと（送信前に実行すると再送される）。PushNotification の戻り値が "not sent" だったら mark-sent は実行せず、代わりに各項目の mark-attempt コマンドを実行すること（本文は残したまま再掲回数だけ減る）。`,
    ...items,
  ].join('\n');
}
