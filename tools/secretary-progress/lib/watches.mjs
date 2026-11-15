import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const OPEN = new Set(['open', 'stalled', 'resumed', 'waiting_user', 'scheduled', 'starting', 'start_overdue']);
const stamp = row => Date.parse(row.lastCheckedAt || row.resolvedAt || row.ts) || 0;
const text = value => typeof value === 'string' ? value : '';

// ki-<14桁日時>-<4桁hex>.json → ファイル作成日時を抽出
const KI_RE = /^ki-(\d{14})-[a-f0-9]{4}\.json$/;

/** ファイル名の日時から作成日をパース（ファイルI/O不要） */
function parseFileDate(name) {
  const m = name.match(KI_RE);
  if (!m) return null;
  const ds = m[1];
  return new Date(+ds.slice(0, 4), +ds.slice(4, 6) - 1, +ds.slice(6, 8),
    +ds.slice(8, 10) || 0, +ds.slice(10, 12) || 0, +ds.slice(12, 14) || 0);
}

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

/**
 * kim-inbox のファイルを日付順（最新優先）で読み込み、指定日数以内のファイルだけ処理する。
 * @param {string} home - ホームディレクトリ
 * @param {number} now - 基準日時（エポックミリ秒）
 * @param {number} maxAgeDays - この日数より古いファイルはスキップ
 */
export async function readWatches(home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(),
  maxAgeDays = 7) {
  const root = path.join(home, '.claude');
  const warnings = [];
  const rows = [];
  try {
    for (const line of (await fs.readFile(path.join(root, 'auto-progress-ledger.jsonl'), 'utf8')).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { warnings.push('見張り台帳に読み取れない行があります'); }
    }
  } catch { warnings.push('見張り台帳を読み取れません'); }
  const items = [];
  try {
    const inbox = path.join(root, 'kim-inbox');
    const names = (await fs.readdir(inbox))
      .filter(name => {
        const d = parseFileDate(name);
        // 日付がパースできない／古すぎるファイルはスキップ
        return d && (now - d.getTime()) < maxAgeDays * 86400000;
      })
      .sort((a, b) => b.localeCompare(a)); // 新しい順
    for (let i = 0; i < names.length; i += 16) {
      await Promise.all(names.slice(i, i + 16).map(async name => {
        try { items.push(JSON.parse(await fs.readFile(path.join(inbox, name), 'utf8'))); }
        catch { warnings.push('確認事項に読み取れないファイルがあります'); }
      }));
    }
  } catch { warnings.push('確認事項を読み取れません'); }
  const progress = summarizeLedger(rows, now);
  const inboxAsks = summarizeAsks(items);
  return { ...progress, inboxAsks, totalWatches: progress.watches.length, totalAsks: inboxAsks.length,
    warnings: [...new Set(warnings)], updatedAt: new Date(now).toISOString() };
}