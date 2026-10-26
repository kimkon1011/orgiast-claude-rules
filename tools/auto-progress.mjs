#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { ledgerFile, readLedger, writeLedger, latestOpenPromises, applyPromise } from './auto-progress-ledger.mjs';
import { resolveOwner } from './notify-owner.mjs';
export function addCheck({ session, check, deadline, label, nextClaude, cwd = process.cwd(), home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now() }) {
  if (!session?.trim() || !check?.trim() || !label?.trim()) throw new Error('--session, --check, --label は必須です');
  const relative = /^\+(\d+)(m|h|d)$/.exec(deadline || '');
  const deadlineMs = relative ? now + Number(relative[1]) * { m: 60000, h: 3600000, d: 86400000 }[relative[2]] : Date.parse(deadline);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= now) throw new Error('--deadline は未来の ISO 日時または +24h などを指定してください');
  const file = ledgerFile(home), rows = readLedger(file);
  const old = latestOpenPromises(rows).find(row => row.sessionId === session)
    || rows.filter(row => row.sessionId === session).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
  // A new revision keeps prior results auditable and resets notification state.
  const row = { ts: new Date(now).toISOString(), pc: old?.pc || os.hostname(), user: old?.user || os.userInfo().username,
    owner: old?.owner || resolveOwner({ home }), sessionId: session, cwd: old?.cwd || cwd, transcriptPath: old?.transcriptPath || '',
    promise: old?.promise || label, nextKim: old?.nextKim || 'なし', status: 'open', check: check.trim(), checkCwd: cwd,
    deadlineAt: new Date(deadlineMs).toISOString(), label: label.trim(), nextClaude: nextClaude || '' };
  writeLedger(file, applyPromise(rows, row)); return row;
}
export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv, options: { 'add-check': { type: 'boolean' }, session: { type: 'string' }, check: { type: 'string' }, deadline: { type: 'string' }, label: { type: 'string' }, 'next-claude': { type: 'string' } } });
  if (!values['add-check']) throw new Error('使用法: --add-check --session <id> --check "<cmd>" --deadline +24h --label "<名前>"');
  return addCheck({ ...values, nextClaude: values['next-claude'] });
}
if (isEntry(import.meta.url)) { try { console.log(JSON.stringify(main())); } catch (error) { console.error(error.message); process.exitCode = 2; } }
