#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { seatCheck } from './lib/deadline-seat.mjs';
import { parseRows as parseVehicles, retireVehicleAsks } from './vehicle-inspection-watch.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { reportHeartbeat } from './lib/heartbeat.mjs';
import { listItems } from './kim-inbox.mjs';
import { DEFAULT_CONFIG, createLedger, loadConfig, defaultHome, dataPath, readJson, saveJson, sheetUrl, googleClient, withLedgerLock, parseSheetDate, jstDate, daysUntil, isDuplicate, initialize } from './deadline-ledger.mjs';
const exec = promisify(execFile);
const inboxScript = fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url));
export const STAGES = { default: [30,14,7,3,1,0], '訴訟・法務': [30,14,7,3,2,1,0], '契約更新': [60,30,14,7,1,0], '支払': [7,3,1,0], '回答・返信': [3,1,0] };
export const closed = row => ['完了','不要'].includes(row.status);
export function effectiveDue(row) {
  if (row.status === '延期') return parseSheetDate(String(row.notes || '').match(/(?:延期先|延期|until)\s*[:：=]?\s*(\d{4}-\d{2}-\d{2})/)?.[1]);
  return parseSheetDate(row.due);
}
export function evaluate(row, today, config = DEFAULT_CONFIG) {
  const due = effectiveDue(row), remainingDays = due ? daysUntil(today, due) : null;
  const stages = row.status === '対応中' ? [3,1,0] : STAGES[row.kind] || STAGES.default;
  const eligible = !closed(row) && row.status !== '候補' && remainingDays !== null;
  return { due, remainingDays, stage: eligible && (remainingDays < 0 || stages.includes(remainingDays)),
    kim: eligible && (config.kimNames.includes(String(row.assignee || '')) || remainingDays <= 3) };
}
export function notificationLine(row, decision, config) {
  const n = decision.remainingDays;
  const color = n <= 3 ? '🔴' : n <= 14 ? '🟠' : '🟡';
  const when = n < 0 ? `期限切れ ${decision.due.slice(5).replace('-', '/')}` : `あと${n}日 ${decision.due.slice(5).replace('-', '/')}`;
  const url = String(row.quote || '').match(/https?:\/\/[^\s<>]+/)?.[0] || sheetUrl(config);
  return `${color} ${row.id} ${when}｜${row.title}（担当 ${row.assignee || 'kim'}）→ ${row.action || '対応状況を確認'}｜根拠: ${url}`.replace(/[\r\n]+/g, ' ');
}
export function formatDigest(rows, today, config) {
  const entries = rows.map(row => ({ row, ...evaluate(row, today, config) })).filter(x => !closed(x.row) && x.row.status !== '候補' && x.remainingDays !== null && x.remainingDays <= 14).sort((a, b) => a.remainingDays - b.remainingDays);
  return ['今週の期限', ...entries.map(x => `${x.row.id} ${x.due}（${x.remainingDays < 0 ? `${-x.remainingDays}日超過` : `あと${x.remainingDays}日`}）${x.row.title}｜担当 ${x.row.assignee || 'kim'}`), entries.length ? '' : '14日以内・超過の期限はありません。', `期限台帳: ${sheetUrl(config)}`].filter(Boolean).join('\n');
}
export function vehicleRows(values, config) {
  return parseVehicles(values).map(v => ({ id: v.id, vehicleName: v.name, plate: v.plate, title: `${v.name} 車検`, kind: '車検', company: v.company, assignee: v.assignee || 'kim', due: v.expiry,
    status: ['完了','売却済'].includes(v.status) ? '完了' : ['予約済','入庫中'].includes(v.status) ? '対応中' : '未着手',
    action: v.status === '完了' && !v.nextExpiry ? '次回満了日を車検台帳に記録' : '入庫手配・更新確認',
    quote: `https://docs.google.com/spreadsheets/d/${config.vehicleSheetId}/edit`, source: '車検台帳', sourceId: v.id, readOnly: true }));
}
export async function loadRows({ config, ledger, sheets }) {
  const rows = await ledger.read();
  const vehicles = config.vehicleSheetId ? vehicleRows(await sheets.get(config.vehicleSheetId, "'車検台帳'!A1:O10000"), config) : [];
  // Imported vehicle IDs always follow the authoritative vehicle sheet.
  const byId = new Map(vehicles.map(row => [row.id, row]));
  return [...rows.filter(row => !byId.has(row.id)), ...vehicles];
}
export async function inboxAction({ home, row, decision, config, close = false, execImpl = exec }) {
  if (close) return execImpl(process.execPath, [inboxScript, '--close-key', row.id], { windowsHide: true, timeout: 60000, env: { ...process.env, ORGIAST_HOME: home } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-inbox-'));
  try {
    const file = path.join(dir, 'body.txt'); fs.writeFileSync(file, notificationLine(row, decision, config), { mode: 0o600 });
    const result = await execImpl(process.execPath, [inboxScript, '--add', '--kind', 'deadline', '--key', row.id, '--due', decision.due, '--remaining-days', String(decision.remainingDays), '--source', 'deadline-watch', '--body-file', file], { encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, ORGIAST_HOME: home } });
    if (row.readOnly) retireVehicleAsks(home, { name: row.vehicleName, plate: row.plate });
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
export function sourceMetadata(row) {
  try { return JSON.parse(String(row.notes || '{}').split('\n')[0]); } catch { return {}; }
}
export async function hasSentReply(row, request) {
  if (row.kind !== '回答・返信' || !/^gmail$/i.test(row.source)) return false;
  const meta = sourceMetadata(row);
  if (!meta.mailbox || !Number.isFinite(Date.parse(row.detectedAt))) return false;
  let threadId = meta.threadId;
  if (!threadId && meta.messageId) {
    const message = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(meta.messageId)}?format=metadata`, { user: meta.mailbox, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    threadId = message.threadId;
  }
  if (!threadId) return false;
  const thread = await request(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`, { user: meta.mailbox, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
  return (thread.messages || []).some(m => m.labelIds?.includes('SENT') && Number(m.internalDate) > Date.parse(row.detectedAt));
}
export async function syncCalendar(row, { config, state, request, persist = () => {}, log = console.error }) {
  if (!config.calendar.enabled || state.calendarSync === false) return;
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar.calendarId)}/events`;
  const opts = { user: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/calendar.events' };
  try {
    const due = effectiveDue(row);
    const query = new URLSearchParams({ privateExtendedProperty: `deadlineId=${row.id}`, maxResults: '2500' });
    const existing = await request(`${base}?${query}`, opts);
    const events = existing.items || [];
    if (closed(row) || !due || row.status === '候補') {
      for (const e of events) await request(`${base}/${encodeURIComponent(e.id)}`, { ...opts, method: 'DELETE' });
      return;
    }
    const end = new Date(Date.parse(due) + 86400000).toISOString().slice(0, 10);
    const body = { summary: `【期限】${row.title}`, start: { date: due }, end: { date: end }, description: `${row.id} 担当: ${row.assignee || 'kim'}\n${row.action || ''}\n期限台帳: ${sheetUrl(config)}`,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10080 }, { method: 'popup', minutes: 1440 }] }, extendedProperties: { private: { deadlineId: row.id } } };
    if (events[0]) await request(`${base}/${encodeURIComponent(events[0].id)}`, { ...opts, method: 'PATCH', body });
    else {
      const id = createHash('sha256').update(`${config.sheetId}:${row.id}`).digest('hex');
      try { await request(base, { ...opts, method: 'POST', body: { ...body, id } }); }
      catch (e) { if (e.status !== 409) throw e; await request(`${base}/${id}`, { ...opts, method: 'PATCH', body }); }
    }
  } catch (e) {
    if (e.status !== 403) throw e;
    state.calendarSync = false; persist(); log('deadline-watch: Calendar HTTP 403、以降の同期を停止しました');
  }
}
export async function manualOperation({ operation, id, until, note, ledger, home, today, config, notify = inboxAction, dryRun = false }) {
  if (operation === 'approve') {
    const candidates = await ledger.read('候補'), mainRows = await ledger.read();
    const selected = candidates.filter(r => r.status === '候補' && (id === '全部' || r.rowNumber === Number(id)));
    if (!selected.length) throw new Error('承認する候補行がありません');
    const actions = [];
    for (const row of selected) {
      if (!parseSheetDate(row.due)) { actions.push({ id: row.id, skipped: '期限未確認' }); continue; }
      if (!dryRun) {
        if (!mainRows.some(r => r.id === row.id) && !isDuplicate(row, mainRows)) {
          await ledger.append([{ ...row, status: '未着手' }]); if (!mainRows.some(r => r.id === row.id)) mainRows.push(row);
        }
        await ledger.patch(row.id, { status: '完了', notes: `${row.notes || ''}\n期限台帳へ承認済み` }, '候補');
        await notify({ home, row, config, close: true });
      }
      actions.push({ id: row.id, operation });
    }
    return actions;
  }
  const row = (await ledger.read()).find(r => r.id === id);
  if (!row) throw new Error('期限台帳にIDがありません（車両は車検台帳で更新）');
  const changes = operation === 'done' ? { status: '完了', completedAt: today } : operation === 'drop' ? { status: '不要' } : { status: '延期', notes: `${row.notes || ''}`.replace(/(?:延期先|延期|until)\s*[:：=]?\s*\d{4}-\d{2}-\d{2}/g, '').trim() + `\n延期先: ${until}`, lastNotified: '' };
  if (note) changes.notes = `${changes.notes ?? row.notes ?? ''}\n${note}`.trim();
  if (!dryRun) { await ledger.patch(id, changes); await notify({ home, row, config, close: true }); }
  return [{ id, operation, changes }];
}
export async function runWatch({ home, config, ledger, sheets, request, today, dryRun = false, rows: suppliedRows, state = {}, notify = inboxAction, heartbeat = reportHeartbeat, stderr = console.error }) {
  const rows = suppliedRows || await loadRows({ config, ledger, sheets });
  const openKeys = new Set(dryRun ? [] : listItems(home, { status: 'open' }).filter(i => i.kind === 'deadline').map(i => i.key));
  const persist = () => saveJson(dataPath(home, 'state.json'), state);
  const decisions = [], errors = [];
  for (const original of rows) {
    let row = { ...original };
    try {
      let completionEvidence = row.kind === '支払' && row.completedAt;
      if (!closed(row) && !row.readOnly && !completionEvidence) {
        try { completionEvidence = await hasSentReply(row, request); }
        catch (e) { errors.push({ id: row.id, phase: 'auto-close', error: e.message }); }
      }
      // An unavailable completion check must not suppress an outstanding deadline.
      if (!closed(row) && !row.readOnly && completionEvidence) {
        row.status = '完了'; row.completedAt ||= today;
        if (!dryRun) await ledger.patch(row.id, { status: row.status, completedAt: row.completedAt });
      }
      Object.assign(original, row);
      const decision = evaluate(row, today, config);
      if (!dryRun && !row.readOnly) await ledger.patch(row.id, { remainingDays: decision.remainingDays ?? '' });
      const priorDate = row.readOnly ? state.vehicles?.[row.id]?.lastNotified : row.lastNotified;
      const shouldNotify = decision.stage && decision.kim && priorDate !== today;
      decisions.push({ id: row.id, title: row.title, status: row.status, ...decision, notify: !!shouldNotify, ...(shouldNotify ? { line: notificationLine(row, decision, config) } : {}) });
      if (!dryRun) {
        if (closed(row) || !decision.kim) await notify({ home, row, config, close: true });
        else if (shouldNotify || openKeys.has(row.id)) {
          await notify({ home, row, decision, config });
          if (shouldNotify) {
            if (row.readOnly) { state.vehicles ||= {}; state.vehicles[row.id] = { lastNotified: today }; persist(); }
            else await ledger.patch(row.id, { lastNotified: today, notifyCount: Number(row.notifyCount || 0) + 1 });
          }
        }
        await syncCalendar(row, { config, state, request, persist, log: stderr });
      }
    } catch (e) { errors.push({ id: row.id, error: e.message }); }
  }
  if (!dryRun) { state.lastWatchAt = new Date().toISOString(); persist(); saveJson(dataPath(home, 'digest.json'), { at: state.lastWatchAt, today, text: formatDigest(rows, today, config) }); }
  return { today, dryRun, decisions, errors };
}
export async function readDigest({ home = defaultHome(), today = jstDate(), ...deps } = {}) {
  const config = deps.config || loadConfig(home);
  if (!config.sheetId) return '';
  const sheets = deps.sheets || createSheetsClient({ fetchImpl: gwsFetch });
  const ledger = deps.ledger || createLedger({ config, sheets });
  return formatDigest(await loadRows({ config, ledger, sheets }), today, config);
}
export function parseArgs(argv) {
  const args = {}; const values = ['--now','--fixture','--done','--defer','--drop','--approve','--until','--note'];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (['--dry-run','--digest'].includes(flag)) args[flag.slice(2)] = true;
    else if (values.includes(flag) && argv[i + 1] && !argv[i + 1].startsWith('--')) args[flag.slice(2)] = argv[++i];
    else throw new Error(`不明な引数または値不足: ${flag}`);
  }
  if (args.now && parseSheetDate(args.now) !== args.now) throw new Error('--now は YYYY-MM-DD');
  if (args.defer && (!args.until || parseSheetDate(args.until) !== args.until)) throw new Error('--until は YYYY-MM-DD');
  if (['done','defer','drop','approve'].filter(k => args[k]).length > 1) throw new Error('操作は1つずつ指定してください');
  if (args.digest && ['done','defer','drop','approve'].some(k => args[k])) throw new Error('--digest と更新操作は併用できません');
  if (args.until && !args.defer || args.note && !['done','defer','drop'].some(k => args[k])) throw new Error('--until / --note に対応する操作がありません');
  if (args.fixture && !args['dry-run']) throw new Error('--fixture は --dry-run と併用してください');
  return args;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home || defaultHome(), stdout = deps.stdout || console.log, stderr = deps.stderr || console.error;
  let args; const startedAt = new Date().toISOString(); let ok = false;
  try {
    args = parseArgs(argv); const today = args.now || jstDate();
    if (!args.fixture && deps.skipSeatCheck !== true) {
      const seat = seatCheck(home);
      if (!seat.kim) { stdout(JSON.stringify({ skip: true, reason: 'deadline jobs run only on the seat with the kim DWD key', seat })); return 0; }
    }
    const fixture = args.fixture ? readJson(args.fixture) : null;
    if (args.fixture && (!fixture || !Array.isArray(fixture.rows))) throw new Error('fixture の台帳JSONがありません、または形式が不正です');
    const config = fixture ? { ...DEFAULT_CONFIG, ...fixture.config, calendar: { enabled: false } } : deps.config || loadConfig(home);
    if (!config.sheetId) {
      stderr('deadline-watch: deadline-ledger 未初期化のため自動初期化します');
      const result = await initialize({ home, sheets: deps.sheets || createSheetsClient({ fetchImpl: gwsFetch }), request: deps.request || googleClient() });
      config.sheetId = result.sheetId;
      saveJson(dataPath(home, 'config.json'), config);
    }
    const sheets = deps.sheets || createSheetsClient({ fetchImpl: gwsFetch });
    const ledger = deps.ledger || (fixture ? { read: async tab => (tab === '候補' ? fixture.candidates || [] : fixture.rows).map((r, i) => ({ ...r, rowNumber: i + 2 })) } : createLedger({ sheets, config }));
    const rows = fixture ? [...fixture.rows, ...(fixture.vehicles || [])] : undefined;
    const request = deps.request || (fixture ? async () => ({ messages: [] }) : googleClient());
    const operation = ['done','defer','drop','approve'].find(k => args[k]);
    const work = async () => {
      if (args.digest) { stdout(formatDigest(rows || await loadRows({ config, ledger, sheets }), today, config)); return { errors: [] }; }
      let result;
      if (operation) result = { actions: await manualOperation({ operation, id: args[operation], until: args.until, note: args.note, ledger, home, today, config, notify: deps.notify, dryRun: !!args['dry-run'] }), errors: [] };
      else result = await runWatch({ home, config, ledger, sheets, request, today, dryRun: !!args['dry-run'], rows, state: fixture ? {} : readJson(dataPath(home, 'state.json'), {}), notify: deps.notify, stderr });
      stdout(JSON.stringify(result, null, 2)); return result;
    };
    const result = args['dry-run'] || args.digest ? await work() : await withLedgerLock(home, work);
    ok = !result.errors.length; return ok ? 0 : 1;
  } catch (e) { stderr(`deadline-watch: ${e.message}`); return 1; }
  finally {
    if (args && !args['dry-run'] && !args.digest) {
      await (deps.heartbeat || reportHeartbeat)({ job: 'OrgiastDeadlineWatch', startedAt, finishedAt: new Date().toISOString(), ok, summary: ok ? '期限追跡完了' : '鍵なし席のためスキップ', cycleMinutes: 1440 }, { homeDir: home, localOnly: true });
      try { const log = path.join(home, '.claude/logs/deadline-watch.log'); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, `${new Date().toISOString()} deadline-watch ${ok ? 'ok' : 'skipped'}\n`); } catch (e) { stderr(`deadline-watch: log write failed (${e.code || e.message})`); }
    }
  }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
