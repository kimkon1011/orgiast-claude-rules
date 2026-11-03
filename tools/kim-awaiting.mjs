#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { ledgerFile, readLedger, writeLedger, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, kimAction } from './auto-progress-ledger.mjs';
import { appendInbox } from './auto-progress-inbox-hook.mjs';
import { active, CATEGORY, DAY } from './lib/fleet-chase-policy.mjs';

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
const ledgerPath = home => path.join(home, '.claude', 'fleet-chase', 'ledger.json');

export const shownFile = home => path.join(home, '.claude', 'state', 'kim-awaiting-shown.json');
export const apId = row => 'ap:' + createHash('sha256').update(rowKey(row)).digest('hex').slice(0, 12);
export const isKimMail = item => item.kind === 'inbound' && (item.category === CATEGORY.decision || /^\[(判断|作業)依頼\]/.test(item.why || item.title || ''));
export const MAX_FLEET_ITEMS = 10000;
export const COLLECT_BUDGET_MS = 2000;
export const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
function readable(value, row, limit) {
  let text = String(value || '');
  for (const [key, replacement] of [['pc', 'このパソコン'], ['sessionId', 'この作業']]) if (row[key]) text = text.split(row[key]).join(replacement);
  return cleanDisplay(text).slice(0, limit);
}
function cleanDisplay(value) {
  return String(value || '').replace(/[（(]\s*\d{10,}\s*[)）]/g, '')
    .replace(/\bmail-[\w-]+\b/g, '').replace(/\d{10,}/g, '')
    .replace(/[（(]\s*[)）]/g, '').replace(/\s+/g, ' ').trim();
}
const PERMISSION_RE = /needs your permission|AskUserQuestion|permission to use/i;
// そのセッションの画面操作（タブを閉じる・Enter を押す・/session-close 等）は、セッションが終われば意味を失う。
// 返事待ちとして追いかけない（2026-10-23 実測: 56 件中の多数がこの種で、本当の判断が埋もれた）。
export const SESSION_OP_RE = /タブ|✕|Enter\s*を|\/session-(?:close|start)|\/clear|新しいセッション|古いタブ/;
// 判断待ちの理由欄に入った調査記録（「宣言…を実測で確認した」等）は、kim への問いとして見せない。
const EVIDENCE_RE = /^(?:宣言|実測|検証|確認した|\(\d\))/;
export function collectAwaiting({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), budgetMs = Infinity } = {}) {
  const started = performance.now();
  const result = [];
  for (const row of latestOpenPromises(readLedger(ledgerFile(home)))) {
    if (row.kimAnswer || isUnattendedRow(row, home) || isNoopPromise(row.promise) || (row.status !== 'waiting_user' && kimAction(row) === 'なし')) continue;
    const action = kimAction(row);
    if (SESSION_OP_RE.test(action)) continue;
    const ask = EVIDENCE_RE.test(action.trim()) ? '進めてよいか判断して返事をする' : readable(action, row, 80);
    result.push({ id: apId(row), source: 'auto-progress', title: readable(row.purpose || row.promise, row, 60), ask, waitingSince: row.ts, route: { sessionId: row.sessionId } });
  }
  const file = ledgerPath(home);
  // Bound synchronous JSON work as well as item traversal inside the five-second hook.
  const ledger = fs.existsSync(file) && fs.statSync(file).size <= MAX_LEDGER_BYTES ? readJson(file) : null;
  for (const item of Object.values(ledger?.items || {}).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, MAX_FLEET_ITEMS)) {
    if (performance.now() - started > budgetMs) break;
    if (!active(item) || !isKimMail(item) || !/^[\w-]+$/.test(item.mailId)) continue;
    const mail = /^[\w-]+$/.test(item.mailId) ? readJson(path.join(home, '.claude', 'fleet-inbox', `${item.mailId}.json`)) : null;
    if (mail?.ackAt || fs.existsSync(path.join(home, '.claude', 'fleet-answers', `${path.basename(item.mailId)}.json`))) continue;
    let title = String(item.why || mail?.why || item.sourceMail?.why || item.title || '').replace(/^\[[^\]]+\]\s*/, '');
    for (const pc of [item.from, item.target]) if (pc) title = title.split(pc).join('');
    const body = String(mail?.body || item.sourceMail?.body || item.bodyHead || '');
    if ([item.why, item.title, mail?.why, mail?.title, mail?.subject, item.sourceMail?.why, body, item.sourceMail?.body, item.bodyHead].some(value => PERMISSION_RE.test(value || ''))) continue;
    const question = body.split(/\r?\n/).find(line => /[?？]\s*$/.test(line) && !/node |--\w|mail-|[{};]|typeof|=>/.test(line));
    // 「<PC> のセッション質問」は PC 名を外すと中身が残らない。本文の「質問:」行を件名に使う（2026-10-23 実測）。
    const asked = body.match(/質問[:：]\s*([^\r\n]+)/)?.[1];
    const replyOpening = /^(?:おっしゃる通り|承知しました|ありがとうございます)/.test(asked || '');
    const bodyTitle = replyOpening && question ? question.split(/。/).at(-1).trim() : asked || question;
    if (title.trim().replace(/^の/, '').length < 10 || /セッション質問$/.test(title.trim())) title = `${bodyTitle || title}`.replace(/\s+/g, ' ');
    title = cleanDisplay(title.replace(/^質問[:：]\s*/, ''));
    let ask = cleanDisplay((question || '').trim().replace(/^質問[:：]\s*/, ''));
    if (!ask || ask === title) ask = '判断して返事をする';
    if (item.from && !title.includes(item.from)) title = `${title.trim().slice(0, 50)}（${item.from}から）`;
    result.push({ id: `fm:${item.mailId}`, source: 'fleet-mail', title: cleanDisplay(title).slice(0, 66), ask: ask.slice(0, 80), waitingSince: item.createdAt, route: { mailId: item.mailId } });
  }
  result.sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince));
  const titles = new Set();
  return result.filter(item => { if (titles.has(item.title)) return false; titles.add(item.title); return true; }).map(item => ({ ...item, ageDays: Math.max(0, Math.floor((now - Date.parse(item.waitingSince)) / DAY)) }));
}
export function clearShown(home, id) {
  const state = readJson(shownFile(home), {});
  for (const session of Object.values(state)) session.ids = (session.ids || []).filter(value => value !== id);
  saveJson(shownFile(home), state);
}
export function respond(id, { home = process.env.ORGIAST_HOME || os.homedir(), bodyFile, reason, skip = false, now = Date.now(), spawnImpl = spawnSync } = {}) {
  if (skip ? !reason?.trim() : !bodyFile) throw new Error(skip ? '--reason required' : '--body-file required');
  const body = skip ? '' : fs.readFileSync(bodyFile, 'utf8').trim();
  if (!skip && !body) throw new Error('empty answer');
  if (id.startsWith('ap:')) {
    const rows = readLedger(ledgerFile(home));
    const row = latestOpenPromises(rows).find(row => apId(row) === id);
    if (!row) throw new Error('awaiting item not found');
    if (skip) Object.assign(row, { status: 'done', reason: `kim 不要: ${reason}`, doneAt: new Date(now).toISOString(), nextKim: 'なし' });
    else {
      Object.assign(row, { kimAnswer: body, kimAnsweredAt: new Date(now).toISOString(), status: 'stalled', nextKim: 'なし' });
      delete row.resumedAt;
    }
    writeLedger(ledgerFile(home), rows);
    if (!skip) appendInbox(home, row.sessionId, { state: 'answered', evidence: `kim の返事を受け取りました: ${body.slice(0, 60)}` });
  } else if (/^fm:[\w-]+$/.test(id)) {
    const mailId = id.slice(3);
    const args = [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), skip ? '--ack' : mailId.startsWith('mail-question-') ? '--answer' : '--reply', mailId, ...(skip ? [] : ['--body-file', bodyFile])];
    const result = spawnImpl(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ORGIAST_HOME: home } });
    if (result.error || result.status !== 0) return result.status || 1;
  } else throw new Error('invalid awaiting id');
  clearShown(home, id);
  return 0;
}
if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    if (args.includes('--list')) {
      const items = collectAwaiting();
      console.log(args.includes('--json') ? JSON.stringify(items, null, 2) : [`📌 kim の返事待ち ${items.length} 件（古い順）`, ...items.map(item => `・${item.title} ／ 答えてほしいこと: ${item.ask} ／ ${item.ageDays}日待ち`)].join('\n'));
    } else process.exitCode = respond(value(args.includes('--skip') ? '--skip' : '--answer'), { skip: args.includes('--skip'), reason: value('--reason'), bodyFile: args.includes('--body-file') ? value('--body-file') : undefined });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
