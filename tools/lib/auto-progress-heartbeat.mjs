import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { addItem, listItems } from '../kim-inbox.mjs';
import { rowKey } from '../auto-progress-ledger.mjs';
import { checkLogPaths } from './auto-progress-artifact.mjs';
export const HEARTBEAT_MS = 6 * 3600000;
export async function reportCheckProgress(home, row, result, { now, patch, io = {} }) {
  if (now - (Date.parse(row.progressNotifiedAt || row.ts) || 0) < HEARTBEAT_MS) return;
  let tail = '';
  for (const file of checkLogPaths(row).slice(0, 1)) {
    let fd;
    try {
      fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
      const data = Buffer.alloc(Math.min(size, 4096)); fs.readSync(fd, data, 0, data.length, size - data.length);
      tail = data.toString('utf8').trim().split(/\r?\n/).slice(-3).join(' / ').slice(-600);
    } catch (error) { tail = `ログ参照不可: ${error.code || error.message}`; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  const verdict = result.code === 1 ? '未達' : result.code === 0 ? '開始条件達成' : '確認エラー';
  const evidence = `${verdict}\n${String(result.text || '').slice(-600)}\n${tail}`;
  const signature = createHash('sha256').update(evidence).digest('hex');
  const at = new Date(now).toISOString();
  const text = `途中経過: ${row.label || row.promise}\n最終確認: ${row.lastCheckedAt || at}\n判定: ${verdict}\n${signature === row.progressSignature ? '変化なし' : `確認結果: ${String(result.text || '').slice(-600)}\nログ末尾: ${tail || '参照先の指定なし'}`}\n作業ID: ${row.sessionId}`;
  const dedupeKey = 'auto-progress-heartbeat:' + createHash('sha256').update(rowKey(row)).digest('hex').match(/.{8}/g).join('-');
  const item = await (io.addKimInboxItem ?? addItem)(home, { kind: 'info', priority: 'high', source: 'auto-progress-heartbeat', dedupeKey, refresh: true, text });
  const stored = (io.listKimInboxItems ?? listItems)(home).find(i => i.id === item?.id);
  if (!stored || stored.text !== item.text || stored.forwardError) throw new Error('progress inbox read-back failed');
  const change = { progressNotifiedAt: at, progressSignature: signature };
  if (patch(rowKey(row), change) !== false) Object.assign(row, change);
}
