import { createHash } from 'node:crypto';
import { addItem } from '../kim-inbox.mjs';
import { rowKey } from '../auto-progress-ledger.mjs';
import { redactSecrets } from '../redact-secrets.mjs';

export const jstDay = now => new Date(now + 9 * 3600000).toISOString().slice(0, 10);
export const jstHour = now => new Date(now + 9 * 3600000).getUTCHours();
export const checkOutput = value => Array.from(redactSecrets(String(value || '').trim())).slice(0, 2000).join('');
const lines = text => [...new Set(String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean))];
export const outputFingerprint = text => createHash('sha256').update(lines(text).sort().join('\n')).digest('hex');

// Receipt follows delivery: a failed send is retried even if the check is unchanged.
export async function pushDailyProgress(home, row, { now, patch, io = {} }) {
  const output = checkOutput(row.lastCheckOutput || row.checkText || row.reason);
  const fingerprint = outputFingerprint(output);
  const changed = Boolean(row.progressFingerprint && row.progressFingerprint !== fingerprint);
  const morning = jstHour(now) === 9 && row.progressDay !== jstDay(now);
  if (!changed && !morning && !row.progressPending) {
    if (!row.progressFingerprint) {
      const baseline = { progressFingerprint: fingerprint, progressOutput: output };
      if (patch(rowKey(row), baseline) === false) throw new Error('進捗の比較基準を保存できません');
      Object.assign(row, baseline);
    }
    return null;
  }
  const remaining = new Set(lines(output));
  const resolved = lines(row.progressOutput).filter(line => !remaining.has(line));
  const text = `【進捗・毎朝】${String(row.label || row.promise || '進行中の作業').slice(0, 120)}\n作業ID: ${row.sessionId || rowKey(row)}\n未達一覧:\n${output || 'check の出力なし'}\n前回からの変化（解消した項目）:\n${resolved.length ? resolved.join('\n').slice(0, 700) : 'なし'}\n次に自動でやること: ${String(row.nextClaude || 'check を再実行し、進捗を確認する').slice(0, 700)}`;
  // 9時台の配達に失敗しても、時刻をまたいだ次の巡回で再試行する。
  const pending = { progressPending: row.progressPending || (morning ? jstDay(now) : true) };
  if (patch(rowKey(row), pending) === false) throw new Error('進捗通知の再試行予定を保存できません');
  Object.assign(row, pending);
  const item = await (io.addKimInboxItem ?? addItem)(home, {
    kind: 'info', source: 'auto-progress-daily', text,
    dedupeKey: `auto-progress-daily:${row.sessionId || rowKey(row)}`,
    replaceExisting: true, dailyProgress: true, progressDay: jstDay(now),
  });
  if (!item?.id || item.forwardError) throw new Error(item?.forwardError || '毎朝の進捗通知を保存できません');
  const receipt = { progressFingerprint: fingerprint, progressOutput: output,
    progressDay: morning ? jstDay(now) : typeof row.progressPending === 'string' ? row.progressPending : row.progressDay || '', progressInboxId: item.id, progressPending: false };
  if (patch(rowKey(row), receipt) === false) throw new Error('毎朝の進捗通知の配達記録を保存できません');
  Object.assign(row, receipt);
  return item;
}
