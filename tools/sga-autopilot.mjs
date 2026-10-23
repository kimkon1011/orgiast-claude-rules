#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, open, unlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createSheetsClient, quoteTab } from './lib/sheets-dwd.mjs';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { notifyKim, resolveDiscordBotToken, KIM_DISCORD_USER_ID } from './notify-kim.mjs';
import { fetchMessages } from './discord-digest.mjs';
import { upload } from './drive-upload.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { isEntry } from './is-entry.mjs';

export const SPREADSHEET_ID = '1E-MFGU8MSYiWf8BmXXdgIFdlFQuYLa4P9zmlLKd8o6w';
export const CSV_FOLDER = '1c3XZMdq0adkzQ1RKuZ5kI3ozy__R4vsJ';
export const EXCLUDED_PARTS = '現金,預金,売掛,買掛,未払,前受,前渡,立替,未収,借入,貸付,預り,仮払,仮受,資本,利益剰余,引当,累計額,建物,車両,工具,器具,備品,敷金,保証金,出資,有価証券,消費税,法人税,事業税,住民税,繰延,固定資産,投資,受取利息,雑収入,支払利息,為替差'.split(',');
export const SETTINGS_ROWS = [
  ['アシスタント報酬 科目', '外注費', 'freee の借方勘定科目名。複数は「;」区切り。要・臼井さん確認（出所: 2026-10-22 仕訳CSV実測）'],
  ['原価 科目', '仕入・外注', '粗利 = 売上高 − これらの科目。複数は「;」区切り'],
  ['売上 科目', '売上高', '複数は「;」区切り'],
  ['販管費から除外する科目', '', '貸借科目・営業外は自動除外。ここは追加の除外用'],
  ['週次レポート 通知先', 'Discord DM（kim）', 'tools/notify-kim.mjs の経路'],
];
export const jstDay = (now = Date.now()) => new Date(Number(now) + 9 * 3600000).toISOString().slice(0, 10);
export const yen = value => `¥${Math.round(value).toLocaleString('ja-JP')}`;
export const nextMonth = month => { const [y, m] = month.split('/').map(Number); return `${y + (m === 12 ? 1 : 0)}/${String(m % 12 + 1).padStart(2, '0')}`; };
export function normalizeDate(value) {
  if (typeof value === 'number') return new Date(Date.UTC(1899, 11, 30) + value * 86400000).toISOString().slice(0, 10);
  const match = String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!match) throw new Error('日付の形式が不正です');
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  if (new Date(date).toISOString().slice(0, 10) !== date) throw new Error('日付が不正です');
  return date;
}
export function csvRows(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(v => v.trim())) rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません');
  row.push(field); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
export function parseFreeeCsv(buffer) {
  let text, encoding = 'UTF-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { encoding = 'CP932'; text = new TextDecoder('shift_jis').decode(buffer); }
  const lines = [];
  for (const row of csvRows(text.replace(/^\uFEFF/, ''))) {
    if (row[3]?.includes('取引日') || row[4]?.includes('借方勘定科目')) continue;
    if (row.length < 17) throw new Error('CSV の列数が不足しています');
    const amounts = [row[8], row[14]].map(v => v.trim() === '' ? 0 : Number(v));
    if (!amounts.every(Number.isFinite)) throw new Error('CSV の金額が不正です');
    lines.push({ date: normalizeDate(row[3]), debitAccount: row[4].trim(), debitAmount: amounts[0], creditAccount: row[10].trim(), creditAmount: amounts[1], description: row[16] });
  }
  return { lines, encoding, rowCount: lines.length };
}
export function classifyAccount(name, settings) {
  if (!name) return 'excluded';
  for (const [key, type] of [['assistantAccounts', 'assistant'], ['cogsAccounts', 'cogs'], ['revenueAccounts', 'revenue'], ['excludedAccounts', 'excluded']]) {
    const values = settings[key] ?? { assistantAccounts: '外注費', cogsAccounts: '仕入・外注', revenueAccounts: '売上高', excludedAccounts: '' }[key];
    if ((Array.isArray(values) ? values : values.split(';')).map(v => v.trim()).includes(name)) return type;
  }
  return EXCLUDED_PARTS.some(part => name.includes(part)) ? 'excluded' : 'sga';
}
export function aggregateMonthly(lines, settings) {
  const result = new Map();
  for (const line of lines) {
    if (line.date < settings.start || line.date > settings.end) continue;
    const month = line.date.slice(0, 7).replace('-', '/');
    const value = result.get(month) ?? { assistant: 0, sga: 0, revenue: 0, cogs: 0, grossProfit: 0, byAccount: {}, lastDate: '' };
    for (const [account, amount] of [[line.debitAccount, line.debitAmount], [line.creditAccount, -line.creditAmount]]) {
      const type = classifyAccount(account, settings);
      if (type === 'excluded') continue;
      value[type] += type === 'revenue' ? -amount : amount;
      if (type === 'assistant' || type === 'sga') value.byAccount[account] = (value.byAccount[account] ?? 0) + amount;
    }
    value.grossProfit = value.revenue - value.cogs;
    value.lastDate = [value.lastDate, line.date].sort().at(-1);
    result.set(month, value);
  }
  return result;
}
export function readSettings(rows) {
  const values = Object.fromEntries(rows.map(row => [row[0], row[1]]));
  const settings = { start: normalizeDate(rows[1]?.[1]), end: normalizeDate(rows[2]?.[1]), assistantLimit: Number(rows[3]?.[1]), sgaLimit: Number(rows[4]?.[1]), annualLimit: Number(rows[5]?.[1]), grossProfitTarget: Number(rows[6]?.[1]), warning: Number(rows[7]?.[1]) };
  if (![settings.assistantLimit, settings.sgaLimit, settings.annualLimit, settings.grossProfitTarget, settings.warning].every(v => Number.isFinite(v) && v > 0) || settings.warning > 1 || settings.end < settings.start) throw new Error('設定の上限・警戒ライン・期間を確認してください');
  for (const [key, label, fallback] of [['assistantAccounts', 'アシスタント報酬 科目', '外注費'], ['cogsAccounts', '原価 科目', '仕入・外注'], ['revenueAccounts', '売上 科目', '売上高'], ['excludedAccounts', '販管費から除外する科目', '']]) settings[key] = values[label] ?? fallback;
  return settings;
}
export function readMonthly(rows) {
  return rows.map((r, i) => {
    const values = [r[2], r[4], r[10]].map(v => Number(v || 0));
    if (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(r[0]) || !values.every(Number.isFinite)) throw new Error('月次の対象月または実績が不正です');
    return { month: r[0], assistant: values[0], sga: values[1], grossProfit: values[2], memo: String(r[14] || ''), row: i + 2 };
  });
}
export function readLedger(rows) {
  return rows.filter(r => typeof r[3] === 'number' && Number.isFinite(r[3]) && r[3] > 0 && !String(r[2] ?? '').startsWith('（記入例）')).map(r => ({ date: r[0], month: r[1], item: r[2], amount: r[3], kind: r[4], verdict: r[5], reason: r[6], posted: r[7] }));
}
export const sum = (rows, value) => rows.reduce((a, r) => a + value(r), 0);
export function budget({ month, kind, settings, monthly, ledger }) {
  const approved = ledger.filter(r => r.verdict === '承認' && r.posted !== '済' && r.month >= settings.start.slice(0, 7).replace('-', '/') && r.month <= settings.end.slice(0, 7).replace('-', '/'));
  const actual = monthly.find(r => r.month === month);
  const assistant = kind === 'アシスタント報酬';
  const remaining = (assistant ? settings.assistantLimit : settings.sgaLimit) - (actual?.[assistant ? 'assistant' : 'sga'] || 0) - sum(approved.filter(r => r.month === month && r.kind === kind), r => r.amount);
  const annualRemaining = settings.annualLimit - sum(monthly, r => r.assistant + r.sga) - sum(approved, r => r.amount);
  return { remaining, annualRemaining, burnRate: (settings.annualLimit - annualRemaining) / settings.annualLimit };
}
export function judge(input) {
  const { amount, kind, month, settings, force } = input;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('金額は正の整数で指定してください');
  if (!['アシスタント報酬', 'その他販管費'].includes(kind)) throw new Error('支出区分が不正です');
  if (!/^\d{4}\/(0[1-9]|1[0-2])$/.test(month) || month < settings.start.slice(0, 7).replace('-', '/') || month > settings.end.slice(0, 7).replace('-', '/')) throw new Error('対象月が管理期間外です');
  const b = budget(input);
  let verdict = '承認', reason = '予算内です。';
  if (amount > b.annualRemaining) { verdict = '却下'; reason = '年間上限を超えます。'; }
  else if (b.burnRate >= settings.warning && !force) { verdict = '却下'; reason = '警戒モード。kim の明示指示があれば --force。'; }
  else if (amount > b.remaining) {
    verdict = '保留'; const next = nextMonth(month); const remaining = budget({ ...input, month: next }).remaining;
    reason = next > settings.end.slice(0, 7).replace('-', '/') ? '当月上限を超えます。翌月は管理期間外です。' : `当月上限を超えます。翌月残枠 ${yen(remaining)}。${amount <= remaining ? '翌月なら可。' : '翌月も残枠不足です。'}`;
  }
  return { verdict, reason: `${reason}当月残枠 ${yen(b.remaining)} → 承認後 ${yen(b.remaining - amount)}／年間残枠 ${yen(b.annualRemaining)}` };
}
export function makeStatus(data, month, now = Date.now()) {
  const b = budget({ ...data, month, kind: 'アシスタント報酬' });
  const current = data.monthly.find(r => r.month === month) ?? { assistant: 0, sga: 0, grossProfit: 0 };
  const selected = data.ledger.filter(r => r.month === month);
  const counts = verdict => { const rows = selected.filter(r => r.verdict === verdict); return { count: rows.length, amount: sum(rows, r => r.amount) }; };
  return { month, assistantRemaining: b.remaining, sgaRemaining: budget({ ...data, month, kind: 'その他販管費' }).remaining, annualRemaining: b.annualRemaining, burnRate: b.burnRate, mode: b.burnRate >= data.settings.warning ? '警戒' : '通常', approvedThisMonth: counts('承認'), pendingThisMonth: counts('保留'), grossProfitYtd: sum(data.monthly, r => r.grossProfit), annualActual: sum(data.monthly, r => r.assistant + r.sga), current, settings: data.settings, day: Number(jstDay(now).slice(8)), byAccount: current.byAccount ?? {} };
}
export function formatWeeklyReport(status, prev) {
  const s = status, settings = s.settings;
  const days = new Date(Date.UTC(Number(s.month.slice(0, 4)), Number(s.month.slice(5)), 0)).getUTCDate();
  const actual = s.current.assistant + s.current.sga, forecast = actual / s.day * days;
  const top = Object.entries(s.byAccount ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const lines = [`${s.month} 販管費のお知らせ（速報）`, '給与・役員報酬・家賃など、まだ会計に入っていない費用があります。', `今月実績 ${yen(actual)}／月末見込み ${yen(forecast)}`, `今月あと使える額：アシスタント報酬 ${yen(s.assistantRemaining)}、その他 ${yen(s.sgaRemaining)}`, `承認済み ${s.approvedThisMonth.count}件 ${yen(s.approvedThisMonth.amount)}／保留 ${s.pendingThisMonth.count}件 ${yen(s.pendingThisMonth.amount)}`, `年間実績 ${yen(s.annualActual)}／年間上限 ${yen(settings.annualLimit)} まで残り ${yen(s.annualRemaining)}（未計上の承認分を差引済み）`, `予算消化 ${(s.burnRate * 100).toFixed(1)}%・${s.mode}`, `粗利累計 ${yen(s.grossProfitYtd)}／年間目標 ${yen(settings.grossProfitTarget)}（${(s.grossProfitYtd / settings.grossProfitTarget * 100).toFixed(1)}%）`, `今月の主な費用：${top.map(([name, amount]) => `${name} ${yen(amount)}`).join('、') || 'まだありません'}`, prev ? `前回報告からの年間実績の増減 ${yen(s.annualActual - prev.annualActual)}` : '初回のため先週との比較はありません。'];
  if (forecast > settings.assistantLimit + settings.sgaLimit || s.current.assistant / s.day * days > settings.assistantLimit || s.current.sga / s.day * days > settings.sgaLimit) lines.push(`月額上限を超える見込みです。削減を検討する費用：${top.map(([name, amount]) => `${name} ${yen(amount)}`).join('、')}`);
  return lines.join('\n').slice(0, 2000);
}
export function parseDmCommand(text) {
  text = text.trim();
  if (/^(販管費|状況|残枠)$/.test(text)) return { type: 'status' };
  const force = /強制|例外|警戒でも/.test(text);
  text = text.replace(/強制|例外|警戒でも/g, '').replace(/^支出\s+/, '').trim();
  const money = '(?:[¥￥]\\s*)?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:万)?(?:円)?';
  const end = text.match(new RegExp(`^(.+?)(?:に|\\s+)(${money})$`));
  const start = text.match(new RegExp(`^(${money})\\s+(.+)$`));
  if (!end && !start) return null;
  const item = (end ? end[1] : start[2]).trim(), raw = end ? end[2] : start[1];
  const amount = Number(raw.replace(/[¥￥,円万\s]/g, '')) * (raw.includes('万') ? 10000 : 1);
  if (!item || !Number.isSafeInteger(amount) || amount <= 0) return null;
  return { type: 'approve', item, amount, kind: /アシスタント|報酬/.test(item) ? 'アシスタント報酬' : 'その他販管費', force };
}
export const publicReason = reason => reason.replace('kim の明示指示があれば --force。', '例外として承認してほしい時は「強制」と添えて送ってください。');
export const shouldSkipWeekly = (state, now, force) => !force && state.lastWeekly?.at?.slice(0, 10) === jstDay(now);
export const isFinalized = row => row.memo.startsWith('確定');
export function parseArgs(argv) {
  const [command = 'status', ...rest] = argv, options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--')) throw new Error('引数の形式が不正です');
    if (['json', 'dry-run', 'force', 'force-send', 'scheduled'].includes(key)) options[key] = true;
    else if (['item', 'amount', 'kind', 'month', 'csv'].includes(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) options[key] = rest[++i];
    else throw new Error('不明な引数、または値がありません');
  }
  return { command, options };
}

export function createAutopilot(deps = {}) {
  const client = deps.client ?? createSheetsClient();
  const now = deps.now ?? (() => Date.now());
  const home = deps.home ?? homedir();
  const statePath = join(home, '.claude/state/sga-autopilot.json');
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tokenProvider = deps.getToken ?? getDriveToken;
  const drive = deps.driveApi ?? driveApi;
  const notify = deps.notify ?? notifyKim;
  const get = range => client.get(SPREADSHEET_ID, range);
  async function load() {
    const [settings, monthly, ledger] = await Promise.all([get(`${quoteTab('設定')}!A1:C100`), get(`${quoteTab('月次')}!A2:O13`), get(`${quoteTab('承認ログ')}!A2:H`)]);
    return { settings: readSettings(settings), monthly: readMonthly(monthly), ledger: readLedger(ledger) };
  }
  async function stateRead() { try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; } }
  async function stateSave(state) { await mkdir(dirname(statePath), { recursive: true }); const temp = `${statePath}.${process.pid}.tmp`; await writeFile(temp, JSON.stringify(state, null, 2)); await rename(temp, statePath); if (await readFile(statePath, 'utf8') !== JSON.stringify(state, null, 2)) throw new Error('処理記録の保存確認に失敗しました'); }
  async function verify(range, rows) {
    const actual = await get(range);
    if (rows.some((row, i) => row.some((v, j) => v !== (actual[i]?.[j] ?? '')))) throw new Error(`書き込み後の確認が一致しません: ${range}`);
  }
  async function update(range, rows) { await client.update(SPREADSHEET_ID, range, rows); await verify(range, rows); }
  async function approve(options, data) {
    data ??= await load();
    if (!options.item?.trim()) throw new Error('支出内容がありません');
    const month = options.month ?? jstDay(now()).slice(0, 7).replace('-', '/');
    const kind = options.kind ?? 'その他販管費', amount = Number(options.amount);
    const result = judge({ ...data, month, kind, amount, force: options.force });
    const row = [jstDay(now()).replaceAll('-', '/'), month, options.item, amount, kind, result.verdict, result.reason, '未'];
    let range;
    if (!options['dry-run']) {
      const response = await client.append(SPREADSHEET_ID, `${quoteTab('承認ログ')}!A:H`, [row]);
      range = response.updates?.updatedRange;
      if (!range) throw new Error('追記した範囲を確認できません');
      await verify(range, [row]);
    }
    return { ...result, row, range, text: `${result.verdict}：${options.item} ${yen(amount)}\n${publicReason(result.reason)}${range ? `\n台帳 ${range.match(/![A-Z]+(\d+)/)?.[1] ?? ''}行目に記録しました。` : '\n確認のみ。台帳への記録はしていません。'}` };
  }
  async function latestCsv(options) {
    if (options.csv) return { buffer: await readFile(options.csv), name: basename(options.csv), modifiedTime: (await stat(options.csv)).mtime.toISOString() };
    const token = await tokenProvider({ impersonate: 'kim@orgiast.jp' });
    const query = new URLSearchParams({ q: `'${CSV_FOLDER}' in parents and trashed=false and name contains 'freee_journals'`, orderBy: 'modifiedTime desc', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', fields: 'files(id,name,modifiedTime)', pageSize: '1' });
    const list = await (await drive(token, `https://www.googleapis.com/drive/v3/files?${query}`)).json();
    const file = list.files?.[0];
    if (!file) throw new Error('仕訳 CSV が見つかりません');
    return { ...file, buffer: Buffer.from(await (await drive(token, `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)).arrayBuffer()) };
  }
  async function sync(options = {}, data) {
    data ??= await load();
    const file = await latestCsv(options), parsed = parseFreeeCsv(file.buffer), months = aggregateMonthly(parsed.lines, data.settings);
    const stamp = file.name.match(/_(\d{4})(\d{2})(\d{2})-\d+\.csv$/);
    const csvDate = stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}` : file.modifiedTime.slice(0, 10);
    const warnings = now() - Date.parse(stamp ? `${csvDate}T05:01:00+09:00` : file.modifiedTime) > 8 * 86400000 ? [`注意：会計データ（仕訳）が ${csvDate.slice(5).replace('-', '/')} 時点のもので、8日以上更新されていません。`] : [];
    const results = [];
    for (const [month, value] of months) {
      const row = data.monthly.find(r => r.month === month);
      if (!row) throw new Error(`月次の対象月が見つかりません: ${month}`);
      const skipped = isFinalized(row);
      results.push({ month, ...value, skipped });
      if (skipped) continue;
      const memo = `速報: freee仕訳 ${value.lastDate.replaceAll('-', '/')} 時点（CSV ${csvDate}）`;
      if (!options['dry-run']) for (const [col, cell] of [['C', value.assistant], ['E', value.sga], ['K', value.grossProfit], ['O', memo]]) await update(`${quoteTab('月次')}!${col}${row.row}`, [[cell]]);
      Object.assign(row, value, { memo });
    }
    return { file: file.name, encoding: parsed.encoding, rowCount: parsed.rowCount, warnings, months: results, data };
  }
  async function send(text) { const result = await notify(text); if (!result || result.delivered === 'none') throw new Error('通知を送信できませんでした'); }
  async function weekly(options = {}) {
    const state = await stateRead();
    if (shouldSkipWeekly(state, now(), options['force-send'])) return { skipped: true, text: '本日は報告済みです。' };
    const synced = await sync(options);
    const status = makeStatus(synced.data, jstDay(now()).slice(0, 7).replace('-', '/'), now());
    const warning = synced.warnings.join('\n');
    const report = formatWeeklyReport(status, state.lastWeekly?.status);
    const text = warning ? `${report.slice(0, 2000 - warning.length - 1)}\n${warning}` : report;
    if (!options['dry-run']) { await send(text); state.lastWeekly = { at: jstDay(now()), status }; await stateSave(state); }
    return { text, status };
  }
  async function meetingMemo(options = {}) {
    if (options.scheduled && jstDay(now()).slice(8) !== '01') return { skipped: true, text: '月初以外は定期作成を省略します。' };
    const synced = await sync(options), data = synced.data;
    const thisMonth = jstDay(now()).slice(0, 7).replace('-', '/');
    const previous = new Date(`${thisMonth.replace('/', '-')}-01T00:00:00Z`); previous.setUTCMonth(previous.getUTCMonth() - 1);
    const month = options.month ?? [data.settings.start.slice(0, 7).replace('-', '/'), previous.toISOString().slice(0, 7).replace('-', '/')].sort().at(-1);
    const row = data.monthly.find(r => r.month === month);
    if (!row) throw new Error('対象月が管理期間外です');
    const next = nextMonth(month);
    const text = [`# ${month} 販管費 打合せメモ`, ...synced.warnings, '実績は速報です。未計上の固定費があります。', `アシスタント報酬：予算 ${yen(data.settings.assistantLimit)}／実績 ${yen(row.assistant)}／予算との差 ${yen(row.assistant - data.settings.assistantLimit)}`, `その他販管費：予算 ${yen(data.settings.sgaLimit)}／実績 ${yen(row.sga)}／予算との差 ${yen(row.sga - data.settings.sgaLimit)}`, `粗利：当月 ${yen(row.grossProfit)}／月次目標 ${yen(data.settings.grossProfitTarget / 12)}／累計 ${yen(sum(data.monthly, r => r.grossProfit))}／年間目標 ${yen(data.settings.grossProfitTarget)}`, next > data.settings.end.slice(0, 7).replace('-', '/') ? '翌月は管理期間外です。次期予算の確認が必要です。' : `翌月支出上限：アシスタント報酬 ${yen(budget({ ...data, month: next, kind: 'アシスタント報酬' }).remaining)}／その他 ${yen(budget({ ...data, month: next, kind: 'その他販管費' }).remaining)}`, '## 当月の申請', ...data.ledger.filter(r => r.month === month).map(r => `- ${r.item}：${yen(r.amount)}、${r.kind}、${r.verdict}、${publicReason(r.reason ?? '')}`), '## 臼井さんへの確認事項', '- アシスタント報酬の科目を「外注費」で確定してよいか。', '- 給与・役員報酬・家賃など未計上の固定費と計上予定日。'].join('\n');
    if (options['dry-run']) return { text };
    const path = join(home, '.claude/logs/sga-autopilot', `meeting-${month.replace('/', '-')}.md`);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, text);
    if (await readFile(path, 'utf8') !== text) throw new Error('打合せメモの保存確認に失敗しました');
    const uploaded = await (deps.upload ?? upload)({ file: path, folder: 'root', name: basename(path), as: 'kim@orgiast.jp' });
    const token = await tokenProvider({ impersonate: 'kim@orgiast.jp' });
    const readBack = await (await drive(token, `https://www.googleapis.com/drive/v3/files/${uploaded.id}?alt=media`)).text();
    if (readBack !== text) throw new Error('打合せメモのアップロード後の確認が一致しません');
    await send(`${month} の打合せメモを作りました。\n${uploaded.url}\n（kim@orgiast.jp で開く）`);
    return { text, path, url: uploaded.url };
  }
  async function watchDm(options = {}) {
    const state = await stateRead(), token = deps.discordToken ?? resolveDiscordBotToken();
    const userId = process.env.KIM_DISCORD_USER_ID || KIM_DISCORD_USER_ID;
    if (!token) throw new Error('通知用の認証情報がありません');
    const request = async (path, body) => {
      const res = await fetchImpl(`https://discord.com/api/v10${path}`, { method: 'POST', headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`通知サービスの応答エラー: ${res.status}`);
      return res.json();
    };
    // 確認のみではチャンネル作成も行いません。
    let channel;
    if (options['dry-run']) {
      const response = await fetchImpl('https://discord.com/api/v10/users/@me/channels', { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`通知先の読み取りエラー: ${response.status}`);
      channel = (await response.json()).find(c => c.type === 1 && c.recipients?.some(r => r.id === userId));
      if (!channel) return { results: [], text: '既存の通知先がありません。確認のみのため作成しません。' };
    } else channel = await request('/users/@me/channels', { recipient_id: userId });
    const since = state.lastMessageId ? Number((BigInt(state.lastMessageId) >> 22n) + 1420070400000n) : now() - 2 * 3600000;
    const { messages, truncated } = await (deps.fetchMessages ?? fetchMessages)({ channelId: channel.id, limit: 1000, since, token, fetchImpl });
    if (truncated) throw new Error('未処理のメッセージが多すぎるため、読み取りを中断しました');
    const results = [];
    for (const message of messages.sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : 1)) {
      if (state.lastMessageId && BigInt(message.id) <= BigInt(state.lastMessageId)) continue;
      if (message.author?.id !== userId || message.author?.bot) continue;
      const command = parseDmCommand(message.content ?? '');
      if (options['dry-run']) { results.push({ id: message.id, command }); continue; }
      // 外部追記前に受信を記録します。通信結果が曖昧な場合も再追記しません。
      const recovering = state.inFlight?.id === message.id;
      state.inFlight ??= { id: message.id }; await stateSave(state);
      let text;
      try {
        if (recovering) throw new Error('前回処理の結果を確認できません');
        if (command?.type === 'approve') text = (await approve(command)).text;
        else if (command?.type === 'status') {
          const status = makeStatus(await load(), jstDay(now()).slice(0, 7).replace('-', '/'), now());
          text = `今月の残枠：アシスタント報酬 ${yen(status.assistantRemaining)}、その他 ${yen(status.sgaRemaining)}\n年間残枠 ${yen(status.annualRemaining)}／${status.mode}`;
        }
      } catch { text = '読み取れなかったので、形式『支出 内容 金額』で送り直してください'; }
      // 返信前に記録し、送信応答を失っても同じ受信へ二度返信しません。
      state.lastMessageId = message.id; delete state.inFlight; await stateSave(state);
      if (text) await request(`/channels/${channel.id}/messages`, { content: text.slice(0, 2000), message_reference: { message_id: message.id }, allowed_mentions: { parse: [] } });
      results.push({ id: message.id, text });
    }
    return { results };
  }
  async function run(command, options = {}) {
    if (command === 'status') return makeStatus(await load(), options.month ?? jstDay(now()).slice(0, 7).replace('-', '/'), now());
    if (command === 'approve') return approve(options);
    if (command === 'sync') { const { data, ...result } = await sync(options); return result; }
    if (command === 'weekly') return weekly(options);
    if (command === 'meeting-memo') return meetingMemo(options);
    if (command === 'watch-dm') return watchDm(options);
    if (command === 'register') { if (!options['dry-run']) { if (process.platform !== 'win32') throw new Error('タスク登録は Windows 上で実行してください'); runRegisterPs1('register-sga-autopilot.ps1'); } return { text: options['dry-run'] ? '確認のみ。タスク登録は行いません。' : 'タスクを登録しました。' }; }
    if (command === 'init-settings') {
      const rows = await get(`${quoteTab('設定')}!A15:C1000`), added = [];
      for (const row of SETTINGS_ROWS) {
        if (rows.some(r => r[0] === row[0])) continue;
        let index = rows.findIndex(r => !r.some(v => v !== '')); if (index < 0) index = rows.length;
        if (!options['dry-run']) await update(`${quoteTab('設定')}!A${index + 15}:C${index + 15}`, [row]);
        rows[index] = row; added.push(row);
      }
      return { added };
    }
    throw new Error('不明なコマンドです');
  }
  async function execute(command, options = {}) {
    if (options['dry-run'] || command === 'status') return run(command, options);
    await mkdir(dirname(statePath), { recursive: true });
    const lockPath = `${statePath}.lock`; let lock;
    try { lock = await open(lockPath, 'wx'); } catch (error) { if (error.code === 'EEXIST') throw new Error('別の販管費処理が実行中です。終了後に再実行してください'); throw error; }
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, at: jstDay(now()) })); return await run(command, options); }
    finally { await lock.close(); await unlink(lockPath); }
  }
  return { execute };
}
export async function main(argv = process.argv.slice(2)) {
  try {
    const { command, options } = parseArgs(argv);
    const result = await createAutopilot().execute(command, options);
    console.log(options.json ? JSON.stringify(result, null, 2) : result.text ?? JSON.stringify(result, null, 2));
  } catch (error) { console.error(error.stack ?? String(error)); process.exitCode = 1; }
}
if (isEntry(import.meta.url)) await main();
