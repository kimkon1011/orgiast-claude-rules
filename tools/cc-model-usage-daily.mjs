#!/usr/bin/env node
/**
 * cc-model-usage-daily.mjs
 * model-usage.jsonl を日次集計し、日付・合計・モデル別内訳・opus比率・理由なしopusを出力。
 * CLI: --file <jsonl> --date <YYYY-MM-DD>
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

export function defaultUsageFile() {
  return path.join(os.homedir(), 'gb-reports', 'model-usage.jsonl');
}

/**
 * model-usage.jsonl を日次集計する。
 * @param {string} filePath jsonl ファイルのパス
 * @param {string} [date] YYYY-MM-DD 形式、省略時は全期間
 * @returns {{ date:string, total:number, byModel:Record<string,number>, opusRatio:number|null, opusWithoutReason:number }}
 */
export function dailySummary(filePath, date) {
  const result = { date: date || 'all', total: 0, byModel: {}, opusRatio: null, opusWithoutReason: 0 };

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { ...result, opusRatio: null };
  }

  let opusCount = 0;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try { row = JSON.parse(s); } catch { continue; }

    // 日付フィルタ
    if (date) {
      const rowDate = (row.ts || '').slice(0, 10);
      if (rowDate !== date) continue;
    }

    result.total++;
    const model = row.model || 'unknown';
    result.byModel[model] = (result.byModel[model] || 0) + 1;

    if (model.startsWith('opus')) {
      opusCount++;
      if (!row.reason || String(row.reason).trim().length < 10) {
        result.opusWithoutReason++;
      }
    }
  }

  if (opusCount > 0 && result.total > 0) {
    result.opusRatio = opusCount / result.total;
  } else {
    result.opusRatio = null;
  }

  return result;
}

export function main(argv = process.argv.slice(2)) {
  let filePath = defaultUsageFile();
  let date;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') filePath = argv[++i];
    else if (argv[i] === '--date') date = argv[++i];
  }

  const result = dailySummary(filePath, date);
  console.log(JSON.stringify(result, null, 2));
}

if (isEntry(import.meta.url)) {
  main();
}