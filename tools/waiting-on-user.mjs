#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import { parseArgs, promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';

const ledgerPath = home => path.join(home, '.claude/waiting-on-user.json');
function validate(row) {
  for (const key of ['id', 'title', 'since', 'nextStep']) if (typeof row?.[key] !== 'string' || !row[key].trim()) throw new Error(`invalid_${key}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.since) || !Number.isFinite(Date.parse(row.since)) || new Date(row.since).toISOString().slice(0, 10) !== row.since) throw new Error('invalid_since');
  if (row.check && (typeof row.check.cmd !== 'string' || !row.check.cmd.trim() || typeof row.check.doneWhenStdoutIncludes !== 'string' || !row.check.doneWhenStdoutIncludes.trim())) throw new Error('invalid_check');
  if (row.status && !['pending', 'done'].includes(row.status)) throw new Error('invalid_status');
}
export function listWaiting(home = process.env.ORGIAST_HOME || os.homedir()) {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (!Array.isArray(rows)) throw new Error('invalid_waiting_ledger');
  rows.forEach(validate);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate_waiting_id');
  return rows;
}
async function transaction(home, fn, persist = true) {
  const file = ledgerPath(home);
  if (!persist) return fn(listWaiting(home));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  let fd;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fd = fs.openSync(lock, 'wx'); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('waiting_ledger_busy');
      let dead = false;
      try { process.kill(pid, 0); } catch (e) { dead = e.code === 'ESRCH'; }
      if (!dead) throw new Error('waiting_ledger_busy');
      fs.unlinkSync(lock);
    }
  }
  if (fd === undefined) throw new Error('waiting_ledger_busy');
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(fd, String(process.pid));
    const rows = listWaiting(home);
    const result = await fn(rows);
    fs.writeFileSync(temp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
    return result;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
    fs.unlinkSync(lock);
  }
}
export async function addWaiting(row, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  validate(row);
  return transaction(home, rows => {
    if (rows.some(item => item.id === row.id)) throw new Error('duplicate_waiting_id');
    const item = { id: row.id, title: row.title, since: row.since, nextStep: row.nextStep, ...(row.check ? { check: row.check } : {}) };
    rows.push(item);
    return item;
  });
}
export async function doneWaiting(id, { home = process.env.ORGIAST_HOME || os.homedir(), now = new Date() } = {}) {
  return transaction(home, rows => {
    const row = rows.find(item => item.id === id);
    if (!row) throw new Error('waiting_id_not_found');
    if (row.status !== 'done') { row.status = 'done'; row.doneAt = now.toISOString(); }
    return row;
  });
}
export async function waitingDigest({ home = process.env.ORGIAST_HOME || os.homedir(), now = new Date(), checkImpl = promisify(exec), persist = true } = {}) {
  return transaction(home, async rows => {
    const lines = [], completedIds = [];
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    for (const row of rows) {
      let unconfirmed = false;
      if (row.status !== 'done' && row.check) {
        try {
          const { stdout } = await checkImpl(row.check.cmd, { timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' });
          if (String(stdout).includes(row.check.doneWhenStdoutIncludes)) { row.status = 'done'; row.doneAt = now.toISOString(); }
        } catch { unconfirmed = true; }
      }
      if (row.status === 'done') {
        if (!row.reportedAt) { lines.push(`完了しました: ${row.title}`); completedIds.push(row.id); }
      } else {
        const days = Math.max(0, Math.floor((Date.parse(today) - Date.parse(row.since)) / 86_400_000));
        lines.push(`待ち ${days} 日: ${row.title} — 次の一手: ${row.nextStep}${unconfirmed ? '（未確認）' : ''}`);
      }
    }
    return { text: lines.length ? `\n\nuser 作業待ち\n${lines.join('\n')}` : '', completedIds };
  }, persist);
}
export async function acknowledgeWaiting(ids, { home = process.env.ORGIAST_HOME || os.homedir(), now = new Date() } = {}) {
  if (!ids.length) return;
  await transaction(home, rows => {
    for (const row of rows) if (ids.includes(row.id) && row.status === 'done' && !row.reportedAt) row.reportedAt = now.toISOString();
  });
}
export async function main(argv = process.argv.slice(2)) {
  const options = Object.fromEntries(['home', 'id', 'title', 'since', 'next-step', 'cmd', 'done-when'].map(key => [key, { type: 'string' }]));
  const { values: v, positionals: [command] } = parseArgs({ args: argv, options, allowPositionals: true });
  const opts = { home: v.home || process.env.ORGIAST_HOME || os.homedir() };
  let result;
  if (command === 'list') { const rows = listWaiting(opts.home); result = { pending: rows.filter(row => row.status !== 'done'), done: rows.filter(row => row.status === 'done') }; }
  else if (command === 'done') result = await doneWaiting(v.id, opts);
  else if (command === 'add') result = await addWaiting({ id: v.id, title: v.title, since: v.since, nextStep: v['next-step'], ...(v.cmd || v['done-when'] ? { check: { cmd: v.cmd, doneWhenStdoutIncludes: v['done-when'] } } : {}) }, opts);
  else throw new Error('usage: waiting-on-user.mjs add|list|done [--home path]');
  console.log(JSON.stringify(result, null, 2));
}
if (isEntry(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
