#!/usr/bin/env node
import os from 'node:os';
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { ledgerFile, readLedger, writeLedger, latestOpenPromises, applyPromise } from './auto-progress-ledger.mjs';
import { executeCheck, MAX_CHECK_TIMEOUT_MS } from './auto-progress-check.mjs';
import { resolveOwner } from './notify-owner.mjs';
// 外部の成果を読まず、時計と定数だけで決まる典型的な判定を拒否する。
export function isTimeOnlyCheck(command) {
  const text = String(command || '');
  if (!/Date\.(?:now|parse)|new\s+Date|Get-Date|date\s+['"]?\+%s/i.test(text)) return false;
  if (/\b(?:fs|require|import|child_process|fetch|argv|env|stdin|readFile|Test-Path|Get-Content)\b/i.test(text)) return false;
  const code = text.replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, match => {
    // node -e / PowerShell の外側の引用はコードなので残す。
    return /Date|date\s+.*%s/i.test(match) ? match.slice(1, -1) : '';
  }).replace(/(['"])(?:(?!\1)[^\\]|\\.)*\1/g, '');
  const words = code.match(/[A-Za-z_$][\w$]*/g) || [];
  const allowed = new Set(['node', 'exe', 'e', 'eval', 'process', 'exit', 'exitCode', 'Date', 'now', 'parse', 'new', 'getTime', 'valueOf', 'if', 'else', 'true', 'false', 'powershell', 'pwsh', 'NoProfile', 'Command', 'Get', 'date', 's', 'DateTime', 'datetime', 'int', 'long', 'gt', 'ge', 'lt', 'le', 'eq', 'ne', 'and', 'or', 'not', 'test']);
  return words.every(word => word === '$' || allowed.has(word));
}
export function addCheck({ session, check, startWhen, deadline, label, nextClaude, askFile, timeout, cwd = process.cwd(), home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), probe, allowMet = false }) {
  if (!session?.trim() || !(startWhen?.trim() || check?.trim()) || !label?.trim()) throw new Error('--session, --check, --label は必須です');
  if (startWhen !== undefined && (!startWhen.trim() || !nextClaude?.trim())) throw new Error('--start-when には --next-claude が必須です');
  if (check && isTimeOnlyCheck(check)) throw new Error('時刻だけの check は完了判定になりません。開始の予約は --start-when、完了判定は成果物（ファイル・PR・台帳など）を確かめるコマンドにしてください');
  const relative = /^\+(\d+)(m|h|d)$/.exec(deadline || '');
  const deadlineMs = relative ? now + Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]] : Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error('--deadline は未来の ISO 日時または +24h などを指定してください');
  const timeoutSec = timeout === undefined || timeout === '' ? null : Number(timeout);
  if (timeoutSec !== null && !(timeoutSec > 0 && timeoutSec * 1000 <= MAX_CHECK_TIMEOUT_MS)) throw new Error(`--timeout は 1〜${MAX_CHECK_TIMEOUT_MS / 1000} の秒数で指定してください`);
  const timeoutFields = timeoutSec === null ? {} : { checkTimeoutMs: Math.round(timeoutSec * 1000) };
  if (probe) {
    const { code, text } = probe({ check: startWhen || check, checkCwd: cwd, cwd, ...timeoutFields });
    if (code === 0 && !startWhen && !allowMet) throw new Error(`check が登録時点で既に達成(exit 0)と判定されました: ${text}。達成時だけ exit 0 になる形か確認してください（例: … | grep -q MERGED）。本当に達成済みなら登録は不要です`);
    if (code !== 1 && code !== 0) throw new Error(`check がこの PC で実行できません(exit ${code}): ${text}`);
  }
  const ask = askFile === undefined ? undefined : fs.readFileSync(askFile, 'utf8');
  const file = ledgerFile(home), rows = readLedger(file);
  const old = latestOpenPromises(rows).find(row => row.sessionId === session)
    || rows.filter(row => row.sessionId === session).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  // A new revision keeps prior results auditable and resets notification state.
  const row = { ts: new Date(now).toISOString(), pc: old?.pc || os.hostname(), user: old?.user || os.userInfo().username,
    owner: old?.owner || resolveOwner({ home }), sessionId: session, cwd: old?.cwd || cwd, transcriptPath: old?.transcriptPath || '',
    promise: old?.promise || label, nextKim: old?.nextKim || 'なし', status: startWhen ? 'scheduled' : 'open', ...(check ? { check: check.trim() } : {}), ...(startWhen ? { startWhen: startWhen.trim() } : {}), checkCwd: cwd,
    deadlineAt: new Date(deadlineMs).toISOString(), label: label.trim(), nextClaude: nextClaude || '', ...(ask !== undefined || old?.ask ? { ask: ask ?? old.ask } : {}), ...timeoutFields };
  writeLedger(file, applyPromise(rows, row)); return row;
}
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'add-check': { type: 'boolean' }, 'ask-file': { type: 'string' }, 'start-when': { type: 'string' }, 'allow-met': { type: 'boolean' }, session: { type: 'string' }, check: { type: 'string' }, deadline: { type: 'string' }, label: { type: 'string' }, 'next-claude': { type: 'string' }, timeout: { type: 'string' } } });
  if (!values['add-check'] && !values['start-when']) throw new Error('使用法: --start-when "<cmd>" --session <id> --label "<名前>" --deadline +24h --next-claude "<作業>" [--check "<完了判定>"] または --add-check --session <id> --check "<cmd>" --deadline +24h --label "<名前>" [--timeout <秒>] [--ask-file <path>] [--allow-met]');
  const home = process.env.ORGIAST_HOME || os.homedir();
  return addCheck({ ...values, home, askFile: values['ask-file'], startWhen: values['start-when'], nextClaude: values['next-claude'], allowMet: values['allow-met'], probe: row => executeCheck(row, { home }) });
}
if (isEntry(import.meta.url)) { try { console.log(JSON.stringify(main())); } catch (error) { console.error(error.message); process.exitCode = 2; } }
