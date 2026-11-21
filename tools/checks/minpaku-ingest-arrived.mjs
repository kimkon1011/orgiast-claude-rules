#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from '../is-entry.mjs';

export const CHAT_PREFIX = '民泊オーナー雑談ルーム';
export const DEFAULT_SINCE = '2026-11-10T23:54:08Z';

// Run on the ingestion PC (or with ORGIAST_HOME pointing to its data).
// A fleet-mail reply alone is not evidence of ingestion.
export function checkArrivals({ home = process.env.ORGIAST_HOME || os.homedir(), since = DEFAULT_SINCE } = {}) {
  const start = Date.parse(since);
  if (!Number.isFinite(start)) throw new Error('--since が不正です');
  const dir = path.join(home, '.claude', 'line-openchat');
  let files;
  try { files = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; files = []; }
  let count = 0, last = 0, total = 0;
  for (const file of files.filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(dir, file.name), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      total++;
      const at = Date.parse(row?.receivedAt);
      if (typeof row?.chat === 'string' && row.chat.startsWith(CHAT_PREFIX) && at >= start
        && typeof row.text === 'string' && row.text.trim()) {
        count++;
        last = Math.max(last, at);
      }
    }
  }
  return {
    code: count ? 0 : 1,
    text: count ? `${CHAT_PREFIX} 着信 ${count}件・最終 ${new Date(last).toISOString()}（走査 ${total}行）`
      : `${CHAT_PREFIX} 着信0件（${since} 以降・走査 ${total}行${total ? '' : '・データパスを確認'}）`,
  };
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { since: { type: 'string' } } });
    const result = checkArrivals(values);
    console.log(result.text);
    process.exitCode = result.code;
  } catch (error) {
    console.log(`${CHAT_PREFIX} 確認エラー: ${String(error.message).split(/\r?\n/)[0]}`);
    process.exitCode = 2;
  }
}
