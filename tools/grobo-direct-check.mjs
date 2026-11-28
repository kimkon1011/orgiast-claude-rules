#!/usr/bin/env node
/**
 * grobo-direct-check.mjs
 * グロボ直接コマンド記録 reports/grobo-direct/YYYY-MM-DD.json を検査。
 * 許可: (a) claude -p 起動の1コマンド (b) REPORT.md/DONE.txt/PROGRESS.md 読みの1コマンド のみ。
 * 複合 (; && | で複数) は違反。違反0で PASS。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

/** 許可される読み取り対象ファイル名（末尾一致） */
const ALLOWED_READ = ['REPORT.md', 'DONE.txt', 'PROGRESS.md'];

/**
 * 1コマンド文字列が許可されるか判定する。
 * @param {string} command
 * @returns {boolean} true=許可
 */
export function classifyCommand(command) {
  const cmd = String(command || '').trim();
  if (!cmd) return false;

  // 複合コマンド（; && || で複数）は違反
  // PowerShell の &（呼出演算子）は複合ではないので ; のみ
  if (/;\s|&&\s|\|\|\s|\s\|\s/.test(cmd)) return false;

  const lower = cmd.toLowerCase();

  // (a) claude -p を起動する1コマンド（run-cc.ps1 経由含む）
  if (/claude\s+-p/.test(lower)) return true;
  if (/run-cc.*\.ps1/.test(lower)) return true;

  // (b) REPORT.md / DONE.txt / PROGRESS.md を読む1コマンド (Get-Content/cat/type)
  const readMatch = lower.match(/(?:get-content|cat|type)\s+["']?([^"'\s]+)/i);
  if (readMatch) {
    const target = readMatch[1].replace(/^["']|["']$/g, '');
    if (ALLOWED_READ.some((name) => target.toLowerCase().endsWith(name.toLowerCase()))) return true;
  }

  return false;
}

/**
 * 日次記録を検査する。
 * @param {{date:string, entries:{ts:string,pc:string,command:string}[]}} record
 * @returns {{date:string, total:number, violations:{index:number,command:string}[],
 *   verdict:'PASS'|'FAIL'}}
 */
export function dailyCheck(record) {
  const entries = record?.entries || [];
  const violations = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || !entry.command) continue;
    if (!classifyCommand(entry.command)) {
      violations.push({ index: i, command: entry.command });
    }
  }

  return {
    date: record?.date || 'unknown',
    total: entries.length,
    violations,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
  };
}

/**
 * ファイルから記録を読み込んで検査する。
 * @param {string} filePath JSON ファイルのパス
 * @returns {{date:string, total:number, violations:{index:number,command:string}[], verdict:'PASS'|'FAIL'}}
 */
export function dailyFromFile(filePath) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { date: path.basename(filePath, '.json'), total: 0, violations: [], verdict: 'PASS' };
  }
  return dailyCheck(record);
}

export function main(argv = process.argv.slice(2)) {
  let filePath, date;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') filePath = argv[++i];
    else if (argv[i] === '--date') date = argv[++i];
  }

  if (filePath) {
    const result = dailyFromFile(filePath);
    console.log(JSON.stringify(result, null, 2));
    if (result.verdict === 'FAIL') process.exitCode = 1;
  } else if (date) {
    const dir = path.join(os.homedir(), 'orgiast-claude-rules', 'reports', 'grobo-direct');
    const fullPath = path.join(dir, `${date}.json`);
    const result = dailyFromFile(fullPath);
    console.log(JSON.stringify(result, null, 2));
    if (result.verdict === 'FAIL') process.exitCode = 1;
  } else {
    console.error('Usage: grobo-direct-check.mjs --file <path> | --date <YYYY-MM-DD>');
    process.exitCode = 1;
  }
}

if (isEntry(import.meta.url)) {
  main();
}