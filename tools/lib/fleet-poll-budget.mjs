import fs from 'node:fs/promises';
import path from 'node:path';

export const MAIL_POLL_BUDGET_MS = 90_000;
export const MAIL_POLL_REQUEST_MS = 60_000;
export const RECEIPT_SCAN_BUDGET_MS = 15_000;

export function timeoutError() {
  return Object.assign(new Error('fleet-mail: poll time budget exhausted'), { name: 'TimeoutError' });
}
// Abort alone cannot bound a transport/body reader that does not settle on abort.
export async function withTimeout(run, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(timeoutError()); }, Math.max(1, Math.ceil(timeoutMs)));
      }),
    ]);
  } finally { clearTimeout(timer); }
}

// Missing receipts cause safe broadcast replay, never an acknowledgement of unsaved mail.
// Async I/O lets the deadline run even at Windows Task Scheduler's low I/O priority.
export async function scanBroadcastReceipts(home, { now = Date.now, budgetMs = RECEIPT_SCAN_BUDGET_MS, io = fs, startAfter = '' } = {}) {
  const ids = [], mails = [], startedAt = now();
  let nextCursor = startAfter;
  let scanned = 0, total = 0, partial = false;
  const dir = path.join(home, '.claude', 'fleet-inbox');
  try {
    await withTimeout(async signal => {
      let names;
      try { names = await io.readdir(dir); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      const sorted = names.filter(name => /^mail-[A-Za-z0-9-]+\.json$/.test(name)).sort();
      const files = [...sorted.filter(name => name > startAfter), ...sorted.filter(name => name <= startAfter)];
      total = files.length;
      for (const name of files) {
        if (signal.aborted || now() - startedAt >= budgetMs) { partial = true; break; }
        try {
          const mail = JSON.parse(await io.readFile(path.join(dir, name), { encoding: 'utf8', signal }));
          if (signal.aborted) return;
          scanned++; nextCursor = name;
          if (mail && /^mail-[A-Za-z0-9-]{1,180}$/.test(mail.id)) mails.push(mail);
          if (mail?.id === name.slice(0, -5) && mail.to === 'all' && Date.parse(mail.expiresAt) > now()) ids.push(mail.id);
        } catch (error) { if (signal.aborted) return; scanned++; nextCursor = name; }
      }
    }, budgetMs);
  } catch (error) { if (error.name !== 'TimeoutError') throw error; partial = true; }
  return { ids: [...ids], mails: [...mails], nextCursor: partial ? nextCursor : '', scanned, total, partial, elapsedMs: now() - startedAt };
}
