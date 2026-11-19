#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { ledgerFile, readLedger, writeLedger, latestOpenPromises, rowKey, isUnattendedRow, isNoopPromise, kimAction, hasClaudeWork, MAX_RESUMES } from './auto-progress-ledger.mjs';
import { appendInbox } from './auto-progress-inbox-hook.mjs';
import { displayPcNames } from './lib/pc-display.mjs';
import { mailboxDraftLabel } from './lib/drafts-auto-cleared.mjs';
import { active, CATEGORY, DAY } from './lib/fleet-chase-policy.mjs';
import { externalFile, readSkips, isSkipped, addSkip, saveAnswer, readAnswers, isAnswered, markAnswerDone } from './lib/external-waiting-state.mjs';

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
export const EXTERNAL_STALE_MS = 3 * 3600_000;
const jstHour = now => new Date(now + 9 * 3600_000).getUTCHours();
export const ageLabel = item => item.ageHours != null && item.ageHours < 48 ? `${item.ageHours}時間待ち` : `${item.ageDays}日待ち`;
// 社外の人を待たせている返信。状態ファイルを読むだけ（hook の予算を守るためネットワークには行かない）。
export function collectExternal({ home, now }) {
  const state = readJson(externalFile(home), null);
  if (!state) return { items: [], answered: [] };
  const skips = readSkips(home), answers = readAnswers(home);
  const age = now - Date.parse(state.generatedAt), failed = Object.entries(state.sources || {}).filter(([, source]) => source.ok === false);
  // 毎時 8〜21 時の巡回なので、夜間は古くて当然。日中は3時間、夜明け後は14時間を超えたら止まっているとみなす。
  const stale = !(age <= EXTERNAL_STALE_MS) && (jstHour(now) >= 9 || age > 14 * 3600_000) || Number.isNaN(age);
  const warnings = [];
  if (stale || failed.length) {
    const reason = failed.map(([mailbox, source]) => `${mailbox}: ${source.error || '取得失敗'}`).join(' / ') || 'なし';
    warnings.push({ id: 'ex:monitor', source: 'external', external: true, warning: true, title: `社外返信の監視が止まっています（最終更新 ${state.generatedAt || '不明'} / エラー ${reason}）`, ask: '監視を直す（Claude が対応）', waitingSince: state.generatedAt || new Date(now).toISOString(), ageDays: 0, route: {} });
  }
  const rawItems = (state.items || []).filter(item => !isSkipped(skips, item)).sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
  const pending = [], answered = [];
  // 同じ who の draft は最新だけ残し、古いものは「置き換え済み」として一覧から外す
  const draftByWho = new Map();
  for (const item of rawItems) {
    if (item.kind === 'draft' && item.who) {
      const existing = draftByWho.get(item.who);
      if (!existing || Date.parse(item.since) > Date.parse(existing.since)) draftByWho.set(item.who, item);
    }
  }
  for (const item of rawItems) {
    // 古い下書きはスキップ（同じ who の新しい下書きがある）
    if (item.kind === 'draft' && item.who) {
      const kept = draftByWho.get(item.who);
      if (kept && kept !== item) continue;
    }
    if (isAnswered(item, answers)) {
      answered.push(item);
    } else {
      pending.push(item);
    }
  }
  const out = [];
  for (const item of pending) {
    const ms = Math.max(0, now - Date.parse(item.since));
    const title = item.kind === 'draft' ? `下書きのまま未送信: ${item.who}${mailboxDraftLabel(item.mailbox)}「${item.subject}」` : `${item.who}${item.assignee ? `（担当: ${item.assignee}）` : ''}「${item.subject}」`;
    out.push({ id: item.id, source: 'external', external: true, title, ask: item.ask || '返信内容を決める', waitingSince: item.since, ageDays: Math.floor(ms / DAY), ageHours: Math.floor(ms / 3600_000), route: { threadId: item.threadId, mailbox: item.mailbox } });
  }
  const answeredOut = [];
  for (const item of answered) {
    const ms = Math.max(0, now - Date.parse(item.since));
    const answer = answers.find(a => a.id === item.id);
    const title = `${item.who}「${item.subject}」`;
    answeredOut.push({ id: item.id, source: 'external', external: true, answered: true, title, ask: answer ? `回答済み・実行待ち: ${answer.answer.slice(0, 60)}` : '回答済み・実行待ち', waitingSince: item.since, ageDays: Math.floor(ms / DAY), ageHours: Math.floor(ms / 3600_000), route: { threadId: item.threadId, mailbox: item.mailbox } });
  }
  return { items: [...warnings, ...out], answered: answeredOut };
}
export function formatList(items) {
  const external = items.filter(item => item.external && !item.answered), answered = items.filter(item => item.answered), internal = items.filter(item => !item.external);
  const line = item => `・${item.title} ／ 答えてほしいこと: ${item.ask} ／ ${ageLabel(item)}${item.progress ? ` ／ ${item.progress}` : ''}`;
  const answeredLine = item => `・${item.title} ／ ${item.ask} ／ ${ageLabel(item)}`;
  return [...(external.length ? [`🔴 社外の人を待たせています ${external.filter(item => !item.warning).length} 件（古い順）`, ...external.map(line)] : []), ...(answered.length ? [`📗 社外返信の回答済み ${answered.length} 件（古い順）`, ...answered.map(answeredLine)] : []), `📌 kim の返事待ち ${internal.length} 件（古い順）`, ...internal.map(line)].join('\n');
}
export function collectAwaiting({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), budgetMs = Infinity, sessionId = '' } = {}) {
  const started = performance.now();
  const ext = collectExternal({ home, now });
  const external = ext.items, answeredExternal = ext.answered;
  const result = [];
  for (const row of latestOpenPromises(readLedger(ledgerFile(home)))) {
    const exhausted = row.status === 'stalled' && (row.resumeCount ?? 0) >= MAX_RESUMES;
    if ((!exhausted && row.kimAnswer) || isUnattendedRow(row, home) || isNoopPromise(row.promise) || (!exhausted && row.status !== 'waiting_user' && (row.autoRegisteredCheck || kimAction(row) === 'なし'))) continue;
    const action = exhausted ? `止まっている: 自動再開上限（${MAX_RESUMES}回）。再開するか不要かを返答する` : kimAction(row);
    if (SESSION_OP_RE.test(action)) continue;
    const ask = EVIDENCE_RE.test(action.trim()) ? '進めてよいか判断して返事をする' : readable(action, row, sessionId && row.sessionId === sessionId ? Infinity : 80);
    const claudePending = row.status === 'open' && !String(row.check || '').trim() && (hasClaudeWork(row.nextClaude) || hasClaudeWork(row.promise));
    const updatedAt = row.updatedAt || row.ts;
    const ageHours = Math.max(0, Math.floor((now - Date.parse(updatedAt)) / 3600000));
    const progress = exhausted ? '止まっている（再開上限・check の追跡は継続）' : claudePending ? `Claude 側で進行中（最終更新 ${ageHours} 時間前）${ageHours >= 6 ? ' ⚠️ 止まっている可能性' : ''}` : '';
    result.push({ progress, id: apId(row), source: 'auto-progress', title: readable(row.purpose || row.promise, row, 60), ask, waitingSince: row.ts, route: { sessionId: row.sessionId } });
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
  const internal = result.filter(item => {
    // 現セッションの待ちは、別セッションの同名項目に埋もれさせない。
    if (sessionId && item.source === 'auto-progress' && item.route.sessionId === sessionId) return true;
    if (titles.has(item.title)) return false;
    titles.add(item.title);
    return true;
  }).map(item => ({ ...item, ageDays: Math.max(0, Math.floor((now - Date.parse(item.waitingSince)) / DAY)) }));
  return [...external, ...answeredExternal, ...internal].map(item => ({ ...item, title: displayPcNames(item.title, { home }), ask: displayPcNames(item.ask, { home }), ...(item.progress ? { progress: displayPcNames(item.progress, { home }) } : {}) }));
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
  if (id.startsWith('ex:')) {
    // 社外返信待ち: skip は skips ファイルへ、指示は answers へ（Claude が見て返信下書きを作る）。送信はしない。
    if (skip) addSkip(home, id, reason, now); else saveAnswer(home, id, body, now);
  } else if (id.startsWith('ap:')) {
    const rows = readLedger(ledgerFile(home));
    const row = latestOpenPromises(rows).find(row => apId(row) === id);
    if (!row) throw new Error('awaiting item not found');
    if (skip) Object.assign(row, { status: 'done', reason: `kim 不要: ${reason}`, doneAt: new Date(now).toISOString(), nextKim: 'なし' });
    else {
      if (row.check && (row.resumeCount ?? 0) >= MAX_RESUMES) {
        row.resumeCountBeforeAnswer = row.resumeCount;
        row.resumeCount = 0;
      }
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
export function respondAll({ home = process.env.ORGIAST_HOME || os.homedir(), inboxId, bodyFile, ids = [], now = Date.now(), spawnImpl = spawnSync } = {}) {
  if (!bodyFile) throw new Error('--body-file required');
  const body = fs.readFileSync(bodyFile, 'utf8').trim();
  if (!body) throw new Error('empty answer');
  let failed = false;
  for (const id of ids) {
    try {
      const result = respond(id, { home, bodyFile, now, spawnImpl });
      if (result !== 0) { console.error(`kim-awaiting: ${id} の回答に失敗しました`); failed = true; }
    } catch (error) { console.error(`kim-awaiting: ${id} の回答に失敗しました: ${error.message}`); failed = true; }
  }
  if (inboxId) {
    const args = [fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url)), '--answer', inboxId, '--body-file', bodyFile];
    const result = spawnImpl(process.execPath, args, { stdio: 'inherit', env: { ...process.env, ORGIAST_HOME: home } });
    if (result.error || result.status !== 0) { console.error(`kim-awaiting: kim-inbox ${inboxId} の回答に失敗しました`); failed = true; }
  }
  if (failed) throw new Error('一部の回答に失敗しました');
}
if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
    if (args.includes('--list')) {
      const items = collectAwaiting();
      console.log(args.includes('--json') ? JSON.stringify(items, null, 2) : formatList(items));
    } else if (args.includes('--answer-all')) {
      const inboxId = args.includes('--inbox') ? value('--inbox') : undefined;
      const bodyFile = value('--body-file');
      const ids = args.filter(a => /^(?:ex:|ap:|fm:)/.test(a));
      respondAll({ inboxId, bodyFile, ids });
    } else if (args.includes('--answer-done')) {
      const id = value('--answer-done');
      if (!id || !id.startsWith('ex:')) throw new Error('--answer-done には ex: 形式の ID が必要です');
      markAnswerDone(process.env.ORGIAST_HOME || os.homedir(), id);
    } else process.exitCode = respond(value(args.includes('--skip') ? '--skip' : '--answer'), { skip: args.includes('--skip'), reason: value('--reason'), bodyFile: args.includes('--body-file') ? value('--body-file') : undefined });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
