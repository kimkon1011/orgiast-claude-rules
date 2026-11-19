import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const OPEN = new Set(['open', 'stalled', 'resumed', 'waiting_user', 'scheduled', 'starting', 'start_overdue']);
const stamp = row => Date.parse(row.lastCheckedAt || row.resolvedAt || row.ts) || 0;
const text = value => typeof value === 'string' ? value : '';

export function summarizeLedger(rows, now = Date.now()) {
  const latest = new Map();
  for (const row of rows) {
    if (!row?.sessionId) continue;
    const key = `${row.sessionId}\0${row.check ? text(row.label) : ''}`;
    const previous = latest.get(key);
    if (!previous || (Date.parse(row.ts) || 0) >= (Date.parse(previous.ts) || 0)) latest.set(key, row);
  }
  const view = row => ({
    id: `${row.sessionId}:${text(row.label)}`, sessionId: row.sessionId,
    label: text(row.label) || text(row.promise) || row.sessionId,
    deadline: row.deadlineAt || null, status: row.status,
    verdict: text(row.verdict) || text(row.checkResult) || '未判定',
    lastCheck: row.lastCheckedAt || null,
    detail: text(row.lastCheckOutput) || text(row.checkText),
  });
  const values = [...latest.values()];
  return {
    watches: values.filter(row => OPEN.has(row.status)).sort((a, b) => stamp(b) - stamp(a)).map(view),
    recentCompleted: values.filter(row => row.status === 'done' && stamp(row) >= now - 7 * 86400000)
      .sort((a, b) => stamp(b) - stamp(a)).map(view),
  };
}

export function summarizeAsks(items) {
  return items.filter(item => item?.kind === 'ask' && item.status === 'open' && !item.answeredAt && !item.answer)
    .sort((a, b) => text(b.createdAt).localeCompare(text(a.createdAt)))
    .map(({ id, text: body, createdAt, from }) => ({ id, text: text(body), createdAt, from }));
}

async function readLedger(root, io) {
  const warnings = [];
  const rows = [];
  try {
    for (const line of (await io.readFile(path.join(root, 'auto-progress-ledger.jsonl'), 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { warnings.push('見張り台帳に読み取れない行があります'); }
    }
  } catch { warnings.push('見張り台帳を読み取れません'); }
  return { rows, warnings };
}

async function readInbox(root, io) {
  const warnings = [];
  const items = [];
  try {
    const inbox = path.join(root, 'kim-inbox');
    const names = (await io.readdir(inbox)).filter(name => /^ki-\d{14}-[a-f0-9]{4}\.json$/.test(name));
    for (let i = 0; i < names.length; i += 16) {
      await Promise.all(names.slice(i, i + 16).map(async name => {
        try { items.push(JSON.parse(await io.readFile(path.join(inbox, name), 'utf8'))); }
        catch { warnings.push('確認事項に読み取れないファイルがあります'); }
      }));
    }
  } catch { warnings.push('確認事項を読み取れません'); }
  return { items, warnings };
}

// Files on the Windows profile can be slow (thousands of inbox JSON files).
// Keep each source independent and single-flight. A slow refresh continues in the
// background while HTTP returns the last snapshot or an explicit loading state.
// Never discard an unanswered ask just because its file name is old.
export function createWatchesReader({ io = fs, budgetMs = 3000, ttlMs = 30000, clock = Date.now } = {}) {
  const homes = new Map();
  function refresh(slot, load) {
    if (slot.pending || clock() < slot.expires) return slot.pending;
    slot.pending = Promise.resolve().then(load).then(value => {
      // Do not replace a good snapshot with a partial or failed read.
      slot.warnings = value.warnings;
      if (!value.warnings.length || !slot.value) {
        slot.value = value;
        slot.updatedAt = new Date(clock()).toISOString();
      }
    }).catch(() => { slot.warnings = ['進捗情報の更新に失敗しました']; }).finally(() => {
      slot.pending = undefined;
      slot.expires = clock() + ttlMs;
    });
    return slot.pending;
  }
  return async function read(home = process.env.ORGIAST_HOME || os.homedir(), now = clock()) {
    const root = path.join(home, '.claude');
    if (!homes.has(root)) homes.set(root, { ledger: { expires: 0 }, inbox: { expires: 0 } });
    const { ledger, inbox } = homes.get(root);
    const pending = [refresh(ledger, () => readLedger(root, io)), refresh(inbox, () => readInbox(root, io))];
    let timer;
    try {
      if (!ledger.value || !inbox.value) await Promise.race([Promise.all(pending), new Promise(resolve => { timer = setTimeout(resolve, budgetMs); })]);
    } finally { clearTimeout(timer); }
    const progress = summarizeLedger(ledger.value?.rows || [], now);
    const inboxAsks = summarizeAsks(inbox.value?.items || []);
    const status = slot => slot.warnings?.length ? 'error' : slot.pending ? 'refreshing' : 'ready';
    return { ...progress, inboxAsks,
      totalWatches: ledger.value ? progress.watches.length : null,
      totalAsks: inbox.value ? inboxAsks.length : null,
      ledgerStatus: status(ledger), inboxStatus: status(inbox),
      ledgerUpdatedAt: ledger.updatedAt || null, inboxUpdatedAt: inbox.updatedAt || null,
      warnings: [...new Set([...(ledger.warnings || []), ...(inbox.warnings || [])])],
      updatedAt: new Date(now).toISOString() };
  };
}

export const readWatches = createWatchesReader();
