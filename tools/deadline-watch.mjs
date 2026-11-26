#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { withAbort, budgetMs } from './lib/deadline-budget.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { seatCheck } from './lib/deadline-seat.mjs';
import { parseRows as parseVehicles } from './vehicle-inspection-watch.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { reportHeartbeat } from './lib/heartbeat.mjs';
import { calendarBase, calendarOptions, calendarIds, readableEvent, isKimTask, listCalendarEvents, belongsToLedger, moveCalendarEvent, timedDuplicates } from './lib/deadline-calendar.mjs';
import { DEFAULT_CONFIG, createLedger, loadConfig, defaultHome, dataPath, readJson, saveJson, sheetUrl, googleClient, withLedgerLock, parseSheetDate, jstDate, daysUntil, isDuplicate, initialize } from './deadline-ledger.mjs';
const exec = promisify(execFile);
const inboxScript = fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url));
const inboxWorker = fileURLToPath(new URL('./lib/deadline-inbox-worker.mjs', import.meta.url));
const inboxOptions = (home, signal) => ({ encoding: 'utf8', windowsHide: true, timeout: 120_000, killSignal: 'SIGKILL', signal, env: { ...process.env, ORGIAST_HOME: home } });
export async function readInboxKeys(home, signal) {
  const { stdout } = await exec(process.execPath, [inboxWorker, 'list'], inboxOptions(home, signal));
  return JSON.parse(stdout);
}
export const STAGES = { default: [30,14,7,3,1,0], '訴訟・法務': [30,14,7,3,2,1,0], '契約更新': [60,30,14,7,1,0], '支払': [7,3,1,0], '回答・返信': [3,1,0] };
export const closed = row => ['完了','不要','見送り'].includes(row.status);
export function effectiveDue(row) {
  if (row.status === '延期') return parseSheetDate(String(row.notes || '').match(/(?:延期先|延期|until)\s*[:：=]?\s*(\d{4}-\d{2}-\d{2})/)?.[1]);
  return parseSheetDate(row.due);
}
// 前倒し・バッファ20%以上（kim 2026-11-26 絶対ルール）。期限日ではなく着手期限で知らせる。
// 所要日数 = 種別の標準日数 + 郵送/オンライン請求・処理・確認・返信待ちの日数。着手期限 = 期限日 − ceil(所要日数 × (1 + buffer))。
export const LEAD_DAYS = { '車検': 21, '訴訟・法務': 14, '行政・消防': 10, '補助金・申請': 14, '契約更新': 14, '支払': 3, '回答・返信': 1, '提出': 7, 'その他': 5 };
export const LEAD_EXTRAS = [
  { re: /登記|謄本|履歴事項|証明書|印鑑証明|住民票|納税証明|戸籍|法務局/, days: 7, method: 'オンライン請求＋郵送受取（窓口に行かない）' },
  { re: /郵送|書留|原本|押印|捺印|署名|返送/, days: 5, method: '郵送（往復）' },
  { re: /申請|届出|許可|申込|手続/, days: 5, method: 'オンライン申請（審査・処理待ち込み）' },
  { re: /見積|相見積|発注|手配|業者/, days: 5, method: '見積取得・比較（返信待ち込み）' },
  { re: /確認|承認|レビュー|回答|返信/, days: 2, method: '確認・返信待ち' },
];
export const BUFFER_RATE = 0.2;
export function startPlan(row, config = DEFAULT_CONFIG) {
  const due = effectiveDue(row); if (!due) return null;
  const text = `${row.title || ''} ${row.action || ''} ${row.kind || ''}`;
  const manual = Number(String(row.notes || '').match(/所要日数\s*[:：=]?\s*(\d+)/)?.[1]);
  const base = (config.leadDays || {})[row.kind] ?? LEAD_DAYS[row.kind] ?? LEAD_DAYS['その他'];
  const extras = LEAD_EXTRAS.filter(x => x.re.test(text));
  const lead = Number.isFinite(manual) && manual > 0 ? manual : base + extras.reduce((a, x) => a + x.days, 0);
  const rate = Math.max(BUFFER_RATE, Number(config.bufferRate) || 0);
  const total = Math.max(lead + 1, Math.ceil(lead * (1 + rate)));
  const d = new Date(`${due}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - total);
  return { startBy: d.toISOString().slice(0, 10), leadDays: lead, totalDays: total, method: extras[0]?.method || '最安の方法（オンライン・郵送を優先）' };
}
export function evaluate(row, today, config = DEFAULT_CONFIG) {
  const due = effectiveDue(row), remainingDays = due ? daysUntil(today, due) : null;
  const stages = row.status === '対応中' ? [3,1,0] : STAGES[row.kind] || STAGES.default;
  const eligible = !closed(row) && row.status !== '候補' && remainingDays !== null;
  const plan = eligible ? startPlan(row, config) : null;
  const startDays = plan ? daysUntil(today, plan.startBy) : null;
  // 未着手は着手期限の3日前・当日・超過（毎日）で知らせる。期限日の段階通知も残す。
  const startAlert = !!plan && row.status !== '対応中' && remainingDays >= 0 && (startDays <= 0 || [3, 0].includes(startDays));
  return { due, remainingDays, startBy: plan?.startBy || null, startDays, leadDays: plan?.totalDays ?? null, method: plan?.method || null,
    startOverdue: !!plan && row.status !== '対応中' && startDays < 0,
    stage: eligible && (remainingDays < 0 || stages.includes(remainingDays) || startAlert),
    kim: eligible && (config.kimNames.includes(String(row.assignee || '')) || remainingDays <= 3 || (startAlert && startDays <= 0)) };
}
export function notificationLine(row, decision, config) {
  const n = decision.remainingDays;
  const color = n <= 3 || decision.startDays < 0 ? '🔴' : n <= 14 || decision.startDays === 0 ? '🟠' : '🟡';
  const sb = decision.startBy ? decision.startBy.slice(5).replace('-', '/') : '';
  const start = !sb || n < 0 ? '' : decision.startDays < 0 ? `【着手期限超過 ${sb}・安い方法が間に合わない恐れ】` : decision.startDays === 0 ? `【本日着手 ${sb}】` : `【着手期限 ${sb}】`;
  const when = `${start}${n < 0 ? `期限切れ ${decision.due.slice(5).replace('-', '/')}` : `あと${n}日 ${decision.due.slice(5).replace('-', '/')}`}`;
  const url = String(row.quote || '').match(/https?:\/\/[^\s<>]+/)?.[0] || sheetUrl(config);
  return `${color} ${row.id} ${when}｜${row.title}（担当 ${row.assignee || 'kim'}）→ ${row.action || '対応状況を確認'}｜根拠: ${url}`.replace(/[\r\n]+/g, ' ');
}
export function formatDigest(rows, today, config) {
  const entries = rows.map(row => ({ row, ...evaluate(row, today, config) })).filter(x => !closed(x.row) && x.row.status !== '候補' && x.remainingDays !== null && (x.remainingDays <= 14 || (x.startDays !== null && x.startDays <= 7))).sort((a, b) => (a.startDays ?? a.remainingDays) - (b.startDays ?? b.remainingDays));
  return ['今週の期限（着手期限＝期限日−所要日数×1.2 の早い順）', ...entries.map(x => `${x.row.id} ${x.due}（${x.remainingDays < 0 ? `${-x.remainingDays}日超過` : `あと${x.remainingDays}日`}${x.startBy && x.row.status !== '対応中' ? `／着手期限 ${x.startBy}${x.startDays < 0 ? ' 超過' : ''}` : ''}）${x.row.title}｜担当 ${x.row.assignee || 'kim'}`), entries.length ? '' : '14日以内・超過の期限はありません。', `期限台帳: ${sheetUrl(config)}`].filter(Boolean).join('\n');
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
export async function inboxAction({ home, row, decision, config, close = false, execImpl = exec, signal }) {
  const options = inboxOptions(home, signal);
  if (close) return execImpl(process.execPath, [inboxScript, '--close-key', row.id], options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-inbox-'));
  const file = path.join(dir, 'body.txt');
  fs.writeFileSync(file, notificationLine(row, decision, config), { mode: 0o600 });
  const result = await execImpl(process.execPath, [inboxScript, '--add', '--kind', 'deadline', '--key', row.id, '--due', decision.due, '--remaining-days', String(decision.remainingDays), '--source', 'deadline-watch', '--body-file', file], options);
  signal?.throwIfAborted();
  if (row.readOnly && row.vehicleName && row.plate) await execImpl(process.execPath, [inboxWorker, 'retire', row.vehicleName, row.plate], options);
  return result;
}
export function sourceMetadata(row) {
  try { return JSON.parse(String(row.notes || '{}').split('\n')[0]); } catch { return {}; }
}
export async function hasSentReply(row, request, onGmail404) {
  if (row.kind !== '回答・返信' || !/^gmail$/i.test(row.source)) return false;
  const meta = sourceMetadata(row);
  if (!meta.mailbox || !Number.isFinite(Date.parse(row.detectedAt))) return false;
  let threadId = meta.threadId;
  if (!threadId && meta.messageId) {
    try {
      const message = await request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(meta.messageId)}?format=metadata`, { user: meta.mailbox, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
      threadId = message.threadId;
    } catch (e) {
      if (e.status === 404 || String(e.message || '').includes('notFound') || String(e.message || '').includes('HTTP 404')) {
        if (onGmail404) onGmail404();
        return false;
      }
      throw e;
    }
  }
  if (!threadId) return false;
  try {
    const thread = await request(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=metadata`, { user: meta.mailbox, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
    return (thread.messages || []).some(m => m.labelIds?.includes('SENT') && Number(m.internalDate) > Date.parse(row.detectedAt));
  } catch (e) {
    if (e.status === 404 || String(e.message || '').includes('notFound') || String(e.message || '').includes('HTTP 404')) {
      if (onGmail404) onGmail404();
      return false;
    }
    throw e;
  }
}
export async function syncCalendar(row, { config, state, request, persist = () => {}, log = console.error }) {
  if (!config.calendar.enabled || state.calendarSync === false) return;
  const ids = calendarIds(config), opts = calendarOptions;
  try {
    const due = effectiveDue(row);
    const found = [];
    for (const calendar of [ids.kim, ids.task]) {
      const events = await listCalendarEvents(request, calendar, { privateExtendedProperty: `deadlineId=${row.id}` });
      found.push(...events.filter(e => e.extendedProperties?.private?.deadlineId === row.id && belongsToLedger(e, config) && !e.start?.dateTime).map(event => ({ calendar, event })));
    }
    // Close the ledger first. Notes alone are not proof of cancellation, and
    // legacy events without a ledger namespace must not match another D-150.
    if (closed(row)) {
      for (const { calendar, event } of found) {
        const sheet = event.extendedProperties?.private?.deadlineSheetId || String(event.description || '').match(/spreadsheets\/(?:a\/[^/]+\/)?d\/([\w-]+)/)?.[1];
        if (sheet !== config.sheetId) continue;
        try { await request(`${calendarBase(calendar)}/${encodeURIComponent(event.id)}?sendUpdates=none`, { ...opts, method: 'DELETE' }); }
        catch (error) { if (![404, 410].includes(error.status)) throw error; }
      }
      return;
    }
    const label = readableEvent(row, config, found.map(x => x.event));
    const inactive = closed(row) || !due || row.status === '候補';
    // Cancellation evidence is retained even when the ledger remains open for audit.
    const cancelled = /見送り済み|発送不要|先方見送り/.test(String(row.notes || ''));
    const duplicates = !inactive && !cancelled && label && isKimTask(row, config) ? await timedDuplicates(row, due, label.customer, config, request) : [];
    const target = !inactive && !cancelled && label && isKimTask(row, config) && !duplicates.length ? ids.kim : ids.task;
    const active = found.filter(x => !x.event.extendedProperties?.private?.deadlineArchive);
    const primary = active.find(x => x.calendar === target) || active[0];
    const patch = async (event, calendar, body) => request(`${calendarBase(calendar)}/${encodeURIComponent(event.id)}?sendUpdates=none`, { ...opts, method: 'PATCH', body });
    for (const item of found) {
      const archive = item.event.extendedProperties?.private?.deadlineArchive;
      const duplicate = item !== primary || archive === 'duplicate';
      const destination = duplicate || archive ? ids.task : target;
      const moved = await moveCalendarEvent(request, item.event, item.calendar, destination);
      const privateProps = { ...item.event.extendedProperties?.private, deadlineId: row.id, deadlineSheetId: config.sheetId };
      if (duplicate) privateProps.deadlineArchive = 'duplicate';
      else if (cancelled || inactive) privateProps.deadlineArchive = cancelled ? 'cancelled' : 'closed';
      const prefix = !label ? '【顧客未解決】' : '';
      const summary = `${prefix}${(label?.summary || item.event.summary || row.title).replace(/^(?:【(?:重複|顧客未解決|完了|不要|保留|見送り済み)】)+/, '')}`;
      const body = { summary, ...(label ? { description: label.description } : {}), extendedProperties: { private: privateProps } };
      if (!inactive && !duplicate && !archive) Object.assign(body, { start: { date: due }, end: { date: new Date(Date.parse(due) + 86400000).toISOString().slice(0,10) } });
      await patch(moved, destination, body);
    }
    // Never recreate preserved duplicates or unresolved/closed ledger entries.
    if (found.length || inactive || cancelled || !label) return;
    const { customer, ...labeled } = label;
    const body = { ...labeled, start: { date: due }, end: { date: new Date(Date.parse(due) + 86400000).toISOString().slice(0,10) },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10080 }, { method: 'popup', minutes: 1440 }] }, extendedProperties: { private: { deadlineId: row.id, deadlineSheetId: config.sheetId } } };
    const base = calendarBase(target);
    {
      const id = createHash('sha256').update(`${config.sheetId}:${row.id}`).digest('hex');
      try { await request(`${base}?sendUpdates=none`, { ...opts, method: 'POST', body: { ...body, id } }); }
      catch (e) {
        if (e.status !== 409) throw e;
        const existing = await request(`${base}/${id}`, opts);
        if (existing.status === 'cancelled' || !belongsToLedger(existing, config) || existing.extendedProperties?.private?.deadlineId !== row.id) throw Error(`Calendar ID衝突: ${row.id}（別予定へのPATCHを停止）`);
        await patch(existing, target, body);
      }
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
export function isTimeout(error) {
  return !!error && (error.code === 'DEADLINE_TIMEOUT' || error.name === 'TimeoutError' ||
    error.name === 'AbortError' || error.killed || isTimeout(error.cause));
}
export function watchRuntime(home, { stderr = console.error, totalMs = 45 * 60_000, httpMs = 60_000, inboxMs = 120_000, lockMs = 300_000, logging = true, filename: suppliedFilename } = {}) {
  const filename = suppliedFilename || dataPath(home, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`);
  if (logging) fs.mkdirSync(path.dirname(filename), { recursive: true });
  const context = new AsyncLocalStorage();
  const global = new AbortController();
  const log = (event, name) => logging && fs.appendFileSync(filename, `${new Date().toISOString()} ${event} ${name}\n`);
  const fail = (name, error) => { const message = `${name}: ${error.message}`; log('WARN', message); stderr(`deadline-watch: ${message}`); };
  let active = 'startup';
  const timeout = name => Object.assign(new Error(`${name} timeout`), { code: 'DEADLINE_TIMEOUT' });
  const timer = setTimeout(() => {
    const error = timeout('overall watchdog (45min)');
    fail(active, error); global.abort(error);
  }, totalMs);
  async function step(name, operation, ms = httpMs) {
    const parent = context.getStore() || global.signal;
    parent.throwIfAborted();
    const previous = active;
    active = name; log('START', name);
    const controller = new AbortController();
    const local = setTimeout(() => controller.abort(timeout(name)), ms);
    const signal = AbortSignal.any([parent, controller.signal]);
    try { return await withAbort(signal, () => context.run(signal, () => operation(signal))); }
    catch (error) { fail(name, error); throw error; }
    finally { clearTimeout(local); log('END', name); active = previous; }
  }
  return { step, log, filename, currentSignal: () => context.getStore() || global.signal, signal: global.signal, inboxMs, lockMs, httpMs, finish: () => clearTimeout(timer) };
}
export async function runWatch({ home, config, ledger, sheets, request, today, dryRun = false, rows: suppliedRows, state = {}, notify = inboxAction, heartbeat = reportHeartbeat, stderr = console.error, runtime, readInbox = readInboxKeys }) {
  const perform = runtime?.step || ((name, fn) => fn());
  let rows = suppliedRows;
  const errors = [], warnings = [];
  const attempt = async (id, phase, fn, ms) => {
    try { return { ok: true, value: await perform(`${id} ${phase}`, fn, ms) }; }
    catch (e) {
      runtime?.signal.throwIfAborted();
      errors.push({ id, phase, error: e.message, ...(isTimeout(e) ? { timeout: true } : {}) });
      return { ok: false };
    }
  };
  let loaded = true;
  if (!rows) {
    const main = await attempt('ledger', 'Sheets read', () => ledger.read());
    const vehicle = config.vehicleSheetId ? await attempt('vehicle', 'Sheets read', async () => vehicleRows(await sheets.get(config.vehicleSheetId, "'車検台帳'!A1:O10000"), config)) : { value: [] };
    loaded = main.ok && (!config.vehicleSheetId || vehicle.ok);
    const imported = vehicle.value || [];
    const ids = new Set(imported.map(row => row.id));
    rows = [...(main.value || []).filter(row => !ids.has(row.id)), ...imported];
  }
  const inbox = dryRun ? { value: [] } : await attempt('inbox', 'listItems', signal => readInbox(home, signal), runtime?.inboxMs);
  const openKeys = new Set(inbox.value || []);
  const persist = () => saveJson(dataPath(home, 'state.json'), state);
  const decisions = [];
  for (const original of rows) {
    runtime?.signal.throwIfAborted();
    let row = { ...original };
    try {
      let completionEvidence = row.kind === '支払' && row.completedAt;
      if (!closed(row) && !row.readOnly && !completionEvidence) {
        const checked = await attempt(row.id, 'auto-close', () => hasSentReply(row, request, () => warnings.push({ id: row.id, phase: 'auto-close', warning: '元メールが見つからない(404)' })));
        completionEvidence = checked.value;
      }
      // An unavailable completion check must not suppress an outstanding deadline.
      if (!closed(row) && !row.readOnly && completionEvidence) {
        const changes = { status: '完了', completedAt: row.completedAt || today };
        if (dryRun || (await attempt(row.id, 'Sheets completion', () => ledger.patch(row.id, changes))).ok) Object.assign(row, changes);
      }
      Object.assign(original, row);
      const decision = evaluate(row, today, config);
      if (!dryRun && !row.readOnly) await attempt(row.id, 'Sheets remainingDays', () => ledger.patch(row.id, { remainingDays: decision.remainingDays ?? '' }));
      const priorDate = row.readOnly ? state.vehicles?.[row.id]?.lastNotified : row.lastNotified;
      const shouldNotify = decision.stage && decision.kim && priorDate !== today;
      decisions.push({ id: row.id, title: row.title, status: row.status, ...decision, notify: !!shouldNotify, ...(shouldNotify ? { line: notificationLine(row, decision, config) } : {}) });
      if (!dryRun) {
        if (closed(row) || !decision.kim) await attempt(row.id, 'kim-inbox close', signal => notify({ home, row, config, close: true, signal }), runtime?.inboxMs);
        else if (shouldNotify || openKeys.has(row.id)) {
          const sent = await attempt(row.id, 'kim-inbox add', signal => notify({ home, row, decision, config, signal }), runtime?.inboxMs);
          if (shouldNotify && sent.ok) {
            if (row.readOnly) { state.vehicles ||= {}; state.vehicles[row.id] = { lastNotified: today }; persist(); }
            else await attempt(row.id, 'Sheets lastNotified', () => ledger.patch(row.id, { lastNotified: today, notifyCount: Number(row.notifyCount || 0) + 1 }));
          }
        }
        await attempt(row.id, 'Calendar sync', () => syncCalendar(row, { config, state, request, persist, log: stderr }));
      }
    } catch (e) { runtime?.signal.throwIfAborted(); errors.push({ id: row.id, error: e.message, ...(isTimeout(e) ? { timeout: true } : {}) }); }
  }
  if (!dryRun && loaded) await attempt('state', 'persist digest', () => {
    state.lastWatchAt = new Date().toISOString(); persist();
    saveJson(dataPath(home, 'digest.json'), { at: state.lastWatchAt, today, text: formatDigest(rows, today, config) });
  });
  return { today, dryRun, decisions, errors, warnings };
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
  let args, runtime; const startedAt = new Date().toISOString(); let ok = false; let resultSummary = ''; let partial = false;
  try {
    args = parseArgs(argv);
    runtime = watchRuntime(home, { stderr, logging: !args['dry-run'] && !args.digest, filename: deps.logFile, ...deps.timeouts, totalMs: budgetMs(deps.timeouts?.totalMs, 45 * 60_000, 45 * 60_000) });
    const makeSheets = () => {
      const client = deps.sheets || createSheetsClient({ fetchImpl: gwsFetch, totalTimeoutMs: runtime.httpMs, signalProvider: runtime.currentSignal });
      return Object.fromEntries(Object.entries(client).map(([name, method]) => [name, (...values) => runtime.step(`Sheets ${name}`, () => method(...values))]));
    };
    const rawRequest = deps.request || googleClient();
    const boundedRequest = (url, options = {}) => runtime.step(`HTTP ${options.method || 'GET'} ${new URL(url).hostname}`, signal => rawRequest(url, { ...options, signal }));
    const today = args.now || jstDate();
    if (!args.fixture && deps.skipSeatCheck !== true) {
      const seat = deps.seatCheck ? deps.seatCheck(home) : seatCheck(home);
      if (!seat.kim) { resultSummary = '鍵なし席のためスキップ'; stdout(JSON.stringify({ skip: true, reason: resultSummary, seat })); ok = true; return 0; }
    }
    const fixture = args.fixture ? readJson(args.fixture) : null;
    if (args.fixture && (!fixture || !Array.isArray(fixture.rows))) throw new Error('fixture の台帳JSONがありません、または形式が不正です');
    const config = fixture ? { ...DEFAULT_CONFIG, ...fixture.config, calendar: { enabled: false } } : deps.config || loadConfig(home);
    if (!config.sheetId) {
      stderr('deadline-watch: deadline-ledger 未初期化のため自動初期化します');
      const result = await runtime.step('initialize', () => initialize({ home, sheets: makeSheets(), request: boundedRequest }), 300_000);
      config.sheetId = result.sheetId;
      saveJson(dataPath(home, 'config.json'), config);
    }
    const sheets = makeSheets();
    const rawLedger = deps.ledger || (fixture ? { read: async tab => (tab === '候補' ? fixture.candidates || [] : fixture.rows).map((r, i) => ({ ...r, rowNumber: i + 2 })) } : createLedger({ sheets, config }));
    const ledger = Object.fromEntries(Object.entries(rawLedger).map(([name, method]) => [name, typeof method === 'function' ? (...values) => runtime.step(`ledger ${name}`, () => method(...values)) : method]));
    const rows = fixture ? [...fixture.rows, ...(fixture.vehicles || [])] : undefined;
    const request = fixture ? (deps.request || (async () => ({ messages: [] }))) : boundedRequest;
    const operation = ['done','defer','drop','approve'].find(k => args[k]);
    const work = async () => {
      if (args.digest) { stdout(formatDigest(rows || await loadRows({ config, ledger, sheets }), today, config)); return { errors: [] }; }
      let result;
      if (operation) result = { actions: await manualOperation({ operation, id: args[operation], until: args.until, note: args.note, ledger, home, today, config, notify: args => runtime.step('kim-inbox manual', signal => (deps.notify || inboxAction)({ ...args, signal }), runtime.inboxMs), dryRun: !!args['dry-run'] }), errors: [] };
      else result = await runWatch({ home, config, ledger, sheets, request, today, dryRun: !!args['dry-run'], rows, state: fixture ? {} : readJson(dataPath(home, 'state.json'), {}), notify: deps.notify, stderr, runtime, readInbox: deps.readInbox });
      stdout(JSON.stringify(result, null, 2)); return result;
    };
    let lockAcquired = false;
    const lockedWork = async () => { lockAcquired = true; runtime.log('END', 'ledger lock acquisition'); return work(); };
    if (!args['dry-run'] && !args.digest) runtime.log('START', 'ledger lock acquisition');
    let result;
    try { result = args['dry-run'] || args.digest ? await work() : await withLedgerLock(home, lockedWork, { waitMs: runtime.lockMs, signal: runtime.signal }); }
    catch (error) {
      if (!args['dry-run'] && !args.digest && !lockAcquired) {
        runtime.log('WARN', 'ledger lock acquisition: ' + error.message);
        runtime.log('END', 'ledger lock acquisition');
      }
      throw error;
    }
    ok = !result.errors.length;
    if (result.errors.length) resultSummary = `期限追跡エラー: ${result.errors.map(e => e.id || e.message || String(e)).join(', ')}`;
    else if (result.warnings?.length) {
      const ids = result.warnings.map(w => w.id);
      const suffix = ids.length === 1 ? ids[0] : `${ids[0]} ほか ${ids.length - 1}件`;
      resultSummary = `期限追跡完了（警告: ${suffix} 元メール404）`;
    } else resultSummary = '期限追跡完了';
    partial = result.errors.some(e => e.timeout);
    return ok ? 0 : partial ? 2 : 1;
  } catch (e) { resultSummary = `期限追跡エラー: ${e.message}`; stderr(`deadline-watch: ${e.message}`); runtime?.log('WARN', e.message); partial = isTimeout(e); return partial ? 2 : 1; }
  finally {
    let heartbeatError;
    if (args && !args['dry-run'] && !args.digest) {
      try {
        const writeHeartbeat = () => (deps.heartbeat || reportHeartbeat)({ job: 'OrgiastDeadlineWatch', startedAt, finishedAt: new Date().toISOString(), ok, summary: resultSummary || (ok ? '期限追跡完了' : '期限追跡エラー'), cycleMinutes: 1440 }, { homeDir: home, localOnly: true });
        if (runtime && !runtime.signal.aborted) await runtime.step('heartbeat', writeHeartbeat);
        else if (!runtime) await withAbort(AbortSignal.timeout(60_000), writeHeartbeat);
      } catch (e) {
        heartbeatError = e; ok = false;
        resultSummary = `期限追跡エラー: heartbeat: ${e.message}`;
        stderr(`deadline-watch: heartbeat: ${e.message}`);
      }
      try { const log = path.join(home, '.claude/logs/deadline-watch-app.log'); fs.mkdirSync(path.dirname(log), { recursive: true }); fs.appendFileSync(log, `${new Date().toISOString()} deadline-watch ${ok ? 'ok' : (resultSummary || 'error')}\n`); } catch (e) { stderr(`deadline-watch: log write failed (${e.code || e.message})`); }
    }
    runtime?.finish();
    if (heartbeatError && (partial || isTimeout(heartbeatError))) return 2;
    if (heartbeatError) return 1;
  }
}
// Separate process so the wall-clock guard also covers synchronous filesystem
// stalls (including the inbox directory scan and vehicle ask retirement).
export async function supervise(argv, { home = defaultHome(), timeoutMs = 45 * 60_000, spawnImpl = spawn, stderr = console.error } = {}) {
  const filename = dataPath(home, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
      stdio: 'inherit', windowsHide: true, env: { ...process.env, ORGIAST_DEADLINE_WATCH_CHILD: '1', ORGIAST_DEADLINE_WATCH_LOG: filename },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const message = 'overall watchdog timeout (45min); see last START in run log';
      stderr(`deadline-watch: ${message}`);
      fs.appendFileSync(filename, `${new Date().toISOString()} WARN ${message}\n`);
      child.kill('SIGKILL');
      resolve(2);
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(timedOut ? 2 : code ?? 1); });
  });
}
if (isEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (process.env.ORGIAST_DEADLINE_WATCH_CHILD === '1') {
    const code = await main(argv, { logFile: process.env.ORGIAST_DEADLINE_WATCH_LOG });
    process.exitCode = code;
    if (code === 2) process.exit(2);
  } else if (argv.includes('--dry-run') || argv.includes('--digest')) process.exitCode = await main(argv);
  else process.exitCode = await supervise(argv);
}
