#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../is-entry.mjs';
export const DEFAULT_SINCE = '2026-10-18T12:30:00Z';
export function checkArrivals({ home = process.env.ORGIAST_HOME || os.homedir(), since = DEFAULT_SINCE, now = new Date() } = {}) {
  const start = Date.parse(since); if (!Number.isFinite(start)) throw new Error('--since が不正です');
  let count = 0, last = 0;
  for (const offset of [0, -1]) {
    const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const name = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}.jsonl`;
    let text; try { text = fs.readFileSync(path.join(home, '.claude', 'line-openchat', name), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of text.split(/\r?\n/)) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      const at = Date.parse(row?.receivedAt);
      if (typeof row?.chat === 'string' && row.chat.startsWith('WeChat') && at >= start && typeof row.text === 'string' && row.text.trim()) { count++; last = Math.max(last, at); }
    }
  }
  return { code: count ? 0 : 1, text: count ? `WeChat 着信 ${count}件・最終 ${new Date(last).toISOString()}` : `WeChat 着信0件（${since} 以降）` };
}
if (isEntry(import.meta.url)) {
  try { const { values } = parseArgs({ options: { since: { type: 'string' } } }); const result = checkArrivals(values); console.log(result.text); process.exitCode = result.code; }
  catch (error) { console.log(`WeChat 確認エラー: ${String(error.message).split(/\r?\n/)[0]}`); process.exitCode = 2; }
}
