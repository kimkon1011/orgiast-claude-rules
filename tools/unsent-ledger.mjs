#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { searchGmail } from './gmail-search.mjs';
import { isEntry } from './is-entry.mjs';

const ROOT = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'unsent-ledger');
const LEDGER = path.join(ROOT, 'ledger.json');
const EXPORTS = [path.join(os.homedir(), 'gb-reports', 'unsent-ledger'), path.join(os.homedir(), 'gb-reports', 'unsent-mail-discord-1126')];
const nowIso = () => new Date().toISOString();
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const atomicJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`); fs.renameSync(tmp, file); };
export function loadLedger(file = LEDGER) { return fs.existsSync(file) ? readJson(file) : { schema: 'unsent-ledger/v1', generated_at: nowIso(), items: [] }; }
export function normalizeItem(item) { return { to: [], cc: [], body_path: null, reply_to_message_id: null, reply_to_note: null, thread_id: null, gmail_draft_id: null, from: 'seisaku-team@orgiast.jp', urgent: false, status: '未送信', evidence: [], last_checked_at: null, sent_message_id: null, ...item, to: Array.isArray(item.to) ? item.to : item.to ? [item.to] : [], cc: Array.isArray(item.cc) ? item.cc : item.cc ? [item.cc] : [] }; }
export function ingest(ledger, inbox = path.join(ROOT, 'inbox')) {
  if (!fs.existsSync(inbox)) return 0;
  const done = path.join(inbox, 'done'); fs.mkdirSync(done, { recursive: true });
  const ids = new Set(ledger.items.map(x => x.id)); let count = 0;
  for (const name of fs.readdirSync(inbox).filter(x => x.endsWith('.json'))) {
    const file = path.join(inbox, name); const item = normalizeItem(readJson(file));
    if (!item.id) throw new Error(`inbox item id missing: ${file}`);
    if (!ids.has(item.id)) { ledger.items.push(item); ids.add(item.id); count++; }
    fs.renameSync(file, path.join(done, name));
  }
  return count;
}
export async function check(ledger, search = searchGmail) {
  for (const item of ledger.items.filter(x => x.status === '未送信')) {
    item.last_checked_at = nowIso(); delete item.last_check_error;
    const target = item.match?.to || item.to?.[0]; const after = item.match?.after;
    if (!target || target === '不明' || !after) { item.last_check_error = 'match.to または match.after が未設定'; continue; }
    try {
      const epoch = Math.floor(new Date(after).getTime() / 1000);
      if (!Number.isFinite(epoch)) throw new Error(`invalid match.after: ${after}`);
      const result = await search({ user: item.from, query: `in:sent to:${target} after:${epoch}`, max: 50 });
      const needles = item.match?.subject_any || (item.subject && item.subject !== '不明' ? [item.subject] : []);
      const found = result.messages.find(m => !needles.length || needles.some(n => String(m.subject).includes(n)));
      if (found) { item.status = '送信済み'; item.sent_message_id = found.id; item.thread_id ||= found.threadId || null; }
    } catch (error) { item.last_check_error = error.message; }
  }
}
export function bodyText(item) {
  if (!item.body_path || !fs.existsSync(item.body_path)) return '';
  const raw = fs.readFileSync(item.body_path, 'utf8').replace(/^\uFEFF/, ''); const split = raw.split(/^---\s*$/m); return (split.length > 1 ? split.slice(1).join('\n---\n') : raw).trim();
}
export function markdown(items) {
  const e = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return ['| # | 急ぎ | クライアント | 案件 | 宛先 | CC | 件名 | 決まった日 | 止まった理由 | 根拠 | 本文ファイル |','|---:|:---:|---|---|---|---|---|---|---|---|---|', ...items.map((x,i)=>`| ${i+1} | ${x.urgent?'要':'－'} | ${e(x.client)} | ${e(x.case)} | ${e(x.to.join(', '))} | ${e(x.cc.join(', '))} | ${e(x.subject)} | ${e(x.decided_date)} | ${e(x.stop_reason)} | ${e(x.evidence.join(' / '))} | ${e(x.body_path)} |`), ''].join('\n');
}
export function exportLedger(ledger, destinations = EXPORTS) {
  const pending = ledger.items.filter(x => x.status === '未送信');
  for (const dir of destinations) {
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    atomicJson(path.join(dir, 'unsent-ledger.json'), { ...ledger, generated_at: nowIso(), items: pending });
    fs.writeFileSync(path.join(dir, 'unsent-ledger.md'), markdown(pending));
    for (const item of pending) atomicJson(path.join(dir, 'cards', `${item.id.replace(/[^a-zA-Z0-9_.-]/g, '_')}.json`), { ...item, body_text: bodyText(item) });
  }
  return pending.length;
}
export async function run({ doIngest = true, doCheck = true, doExport = true, ledgerFile = LEDGER, search } = {}) {
  const ledger = loadLedger(ledgerFile); const ingested = doIngest ? ingest(ledger, path.join(path.dirname(ledgerFile), 'inbox')) : 0;
  if (doCheck) await check(ledger, search); ledger.generated_at = nowIso(); atomicJson(ledgerFile, ledger);
  const pending = doExport ? exportLedger(ledger) : ledger.items.filter(x => x.status === '未送信').length;
  return { total: ledger.items.length, pending, ingested };
}
async function main() { const a = process.argv.slice(2); const only = a.some(x => ['--ingest','--check','--export'].includes(x)); console.log(JSON.stringify(await run({ doIngest: !only || a.includes('--ingest'), doCheck: !only || a.includes('--check'), doExport: !only || a.includes('--export') }), null, 2)); }
if (isEntry(import.meta.url)) main().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
