#!/usr/bin/env node
/**
 * schedule-autopilot.mjs — 全PCの「日付のある予定」を期限台帳に集め、営業日ベースで逆算して
 * 金さんへ先回りで届ける（無LLM）。金さんの判断が要るものだけを「答えるだけで進む形」で出し、
 * 答えが来たら担当PCへ次工程を自動で依頼する。
 *
 *   add      … 作業中のセッションが予定を書き出す（期限台帳へ追記。失敗時はローカル outbox に保留）
 *   capture  … Stop hook。最後の返答の【予定】行を自動で add する
 *   flush    … outbox の保留分を台帳へ送る
 *   run      … 000 の定時ジョブ。--slot morning（毎朝の一覧）/ tick（15分毎: 締切数時間前・回答の反映）
 *   plan     … 台帳を読み、予定ごとの着手期限・送信期限・通知段階を JSON で出す（確認用）
 *   done     … 台帳の行を完了にする
 *
 * 届け先は金さん向けの正規経路（kim-inbox ＋ スマホ通知キュー）。kim 宛 Discord DM は全廃ルールのため使わない。
 * 社外への送信は一切しない。金さんの承認が要る送信・支払・削除は「承認依頼」を期限前に出すだけ。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { latestAssistantText } from './lib/assistant-text.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { addDays, isBusinessDay, lastBusinessDayOnOrBefore, prevBusinessDay, nextBusinessDay, addBusinessDays, closedStreakAfter, holidayName } from './lib/jp-business-days.mjs';

const exec = promisify(execFile);
const HOUR = 3_600_000;
export const META_PREFIX = 'autopilot:';
export const TYPES = ['send', 'approval', 'delivery', 'task'];
export const TYPE_LABEL = { send: '送信・配信', approval: '金さん承認', delivery: '納期', task: 'やること' };
const repoConfigPath = fileURLToPath(new URL('../config/schedule-autopilot.json', import.meta.url));
export const defaultHome = () => process.env.ORGIAST_HOME || os.homedir();
export const dataDir = home => path.join(home, '.claude', 'deadline-watch');

export function jstNow(now = new Date()) {
  const d = new Date(new Date(now).getTime() + 9 * HOUR).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
}
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}
export function loadAutopilotConfig(home = defaultHome()) {
  const base = readJson(repoConfigPath, {});
  const local = readJson(path.join(dataDir(home), 'autopilot.json'), {});
  const legacy = readJson(path.join(dataDir(home), 'config.json'), {});
  return { ...base, ...local, ledgerSheetId: local.ledgerSheetId || legacy.sheetId || base.ledgerSheetId,
    calendar: { ...(base.calendar || {}), ...(local.calendar || {}) }, sources: local.sources || base.sources || [] };
}
const bizOpts = config => ({ closed: config?.closed });

// ---------- 予定の解釈 ----------
export function parseMeta(notes) {
  const line = String(notes || '').split(/\r?\n/).find(l => l.startsWith(META_PREFIX));
  if (!line) return {};
  try { return JSON.parse(line.slice(META_PREFIX.length)); } catch { return {}; }
}
export function withMeta(notes, meta) {
  const rest = String(notes || '').split(/\r?\n/).filter(l => l && !l.startsWith(META_PREFIX));
  return [META_PREFIX + JSON.stringify(meta), ...rest].join('\n');
}
export function parseWhen(value) {
  const m = String(value || '').trim().normalize('NFKC').match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return null;
  return { date, time: m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : null };
}
const SEND_WORDS = /配信|送信|送付|発送|募集|告知|案内|リリース|打診|提出/;
export function classify(row, meta = parseMeta(row.notes)) {
  if (TYPES.includes(meta.type)) return meta.type;
  if (row.kind === '回答・返信' || SEND_WORDS.test(row.title || '')) return 'send';
  if (meta.needsKim) return 'approval';
  if (/納品|納期|納入|出荷|搬入/.test(row.title || '')) return 'delivery';
  return 'task';
}
export const isClosed = row => ['完了', '不要'].includes(row.status);
function effectiveDue(row) {
  if (row.status === '延期') { const m = String(row.notes || '').match(/(?:延期先|延期|until)\s*[:：=]?\s*(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; }
  return parseWhen(row.due)?.date || null;
}
const minus = (time, hours) => { const [h, m] = time.split(':').map(Number); const t = Math.max(0, h * 60 + m - hours * 60); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
export function planItem(row, config = {}) {
  const meta = parseMeta(row.notes), due = effectiveDue(row);
  if (!due) return null;
  const opts = bizOpts(config), type = classify(row, meta), cutoff = config.sendCutoff || '12:00';
  const time = meta.time || parseWhen(row.due)?.time || null;
  let actionDay, actionTime;
  if (type === 'send') {
    // 相手が読む営業日の午前中に届ける。期限が休み・連休中なら直前の営業日の午前に前倒し。
    actionDay = lastBusinessDayOnOrBefore(due, opts);
    actionTime = actionDay === due && time && time < cutoff ? time : cutoff;
  } else {
    actionDay = isBusinessDay(due, opts) ? due : lastBusinessDayOnOrBefore(due, opts);
    actionTime = actionDay === due && time ? time : '18:00';
  }
  const prepDays = Number.isFinite(Number(meta.prepDays)) ? Number(meta.prepDays) : type === 'send' || meta.needsKim ? 1 : 0;
  const startBy = addBusinessDays(actionDay, -prepDays, opts);
  const needsKim = String(meta.needsKim || '');
  // 金さんの判断は、実行の3時間前（送信なら当日 9:00）までにもらう。
  const kimBy = needsKim ? `${actionDay}T${minus(actionTime, config.hoursBefore ?? 3)}` : null;
  return { id: row.id, title: row.title, type, due, time, actionDay, actionAt: `${actionDay}T${actionTime}`, startBy,
    prevDay: prevBusinessDay(actionDay, opts), kimBy, needsKim, recommend: meta.recommend || '', draftUrl: meta.draftUrl || '',
    assignee: row.assignee || 'kim', pc: meta.pc || '', action: row.action || '', status: row.status || '',
    moved: actionDay !== due ? `${due}（${holidayName(due, opts) || (isBusinessDay(due, opts) ? '' : '休み')}）→${actionDay}` : '' };
}
// 今どの段階か。push は段階が変わったときだけ（同じ内容の連打をしない）。
export function stageOf(plan, now = new Date(), config = {}) {
  if (!plan || ['完了', '不要'].includes(plan.status)) return 'none';
  const { date, time } = jstNow(now), stamp = `${date}T${time}`;
  if (stamp > plan.actionAt) return 'late';
  const hours = config.hoursBefore ?? 3;
  if (date === plan.actionDay) return time >= minus(plan.actionAt.slice(11), hours) ? 'hours' : 'day';
  if (date === plan.prevDay) return 'prev';
  if (date >= plan.startBy && date < plan.prevDay) return 'start';
  return 'none';
}
export const STAGE_MARK = { start: '🟡', prev: '🟠', day: '🔴', hours: '🚨', late: '⚠️' };
const md = d => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const wd = d => '日月火水木金土'[new Date(`${d}T00:00:00Z`).getUTCDay()];
const when = p => `${md(p.actionDay)}(${wd(p.actionDay)}) ${p.actionAt.slice(11)}`;
export function recoveryPlan(plan, config = {}) {
  const next = nextBusinessDay(jstNow().date, bizOpts(config));
  if (plan.type === 'send') return `挽回策: ${md(next)}(${wd(next)}) 9:00 に送る。返事の期限が近すぎる文面なら1営業日延ばした版に直す`;
  if (plan.needsKim) return '挽回策: 今日中に返事をもらえれば担当PCが続きをすぐ進める';
  return `挽回策: 担当（${plan.assignee}）へ今日中の対応を再依頼する。延ばすなら「延期 ${plan.id} ${md(next)}」と返事`;
}
export function askText(plan, n) {
  return [
    `何の件: ${plan.title}（${plan.id}・${TYPE_LABEL[plan.type]}・${when(plan)}まで）`,
    `起きたこと: ${plan.moved ? `期限 ${plan.moved} に前倒し。` : ''}${plan.action || '準備はAI側で進めています'}`,
    `判断してほしいこと: ${plan.needsKim}${plan.recommend ? `（推奨: ${plan.recommend}）` : ''}${plan.draftUrl ? ` 文面: ${plan.draftUrl}` : ''}`,
    `返事の例: ${n ? `${n} 可` : '可'}／${n ? `${n} ` : ''}直す: <直す点>／${n ? `${n} ` : ''}見送り`,
  ].join('\n');
}

// ---------- 集約元（読み取りのみ） ----------
const pick = (header, names = []) => names.map(n => header.findIndex(h => String(h).trim() === n)).find(i => i >= 0) ?? -1;
export function sheetDate(value, today) {
  if (typeof value === 'number' && value > 20000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000).toISOString().slice(0, 10);
  const text = String(value ?? '').normalize('NFKC');
  const full = parseWhen(text); if (full) return full.date;
  const m = text.match(/(\d{1,2})\/(\d{1,2})/);
  if (!m) return null;
  const year = Number(today.slice(0, 4)), month = Number(m[1]);
  const y = month < Number(today.slice(5, 7)) - 6 ? year + 1 : month > Number(today.slice(5, 7)) + 6 ? year - 1 : year;
  return `${y}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}
export function extractSourceRows(values, source, today) {
  for (let h = 0; h < Math.min(3, values.length); h++) {
    const header = values[h] || [];
    const di = pick(header, source.date), ti = pick(header, source.title);
    if (di < 0 || ti < 0) continue;
    const ai = pick(header, source.assignee), si = (source.status || []).map(n => header.indexOf(n)).filter(i => i >= 0);
    const [from, to] = source.window || [-7, 7];
    return values.slice(h + 1).flatMap(cells => {
      const date = sheetDate(cells[di], today), title = String(cells[ti] ?? '').trim();
      if (!date || !title) return [];
      const status = si.map(i => String(cells[i] ?? '')).join(' ');
      if ((source.closedWords || []).some(w => status.includes(w))) return [];
      const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
      if (diff < from || diff > to) return [];
      return [{ source: source.name, kind: source.kind, date, diff, title: title.replace(/\s+/g, ' ').slice(0, 60), assignee: ai >= 0 ? String(cells[ai] ?? '') : '', status }];
    });
  }
  return [];
}
export async function readSources(config, sheets, today, log = () => {}) {
  const items = [], milestones = [], errors = [];
  for (const source of config.sources || []) {
    try {
      let tabs = source.tabs;
      if (!tabs) tabs = ((await sheets.metadata(source.sheetId)).sheets || []).map(s => s.properties.title).slice(0, source.maxTabs || 3);
      for (const tab of tabs) {
        const values = await sheets.get(source.sheetId, `'${tab.replaceAll("'", "''")}'!A1:AD${source.maxRows || 2000}`);
        if (source.kind === 'milestone') {
          const row = values.find(r => { const m = String(r[1] || '').match(/(\d{4}-\d{2}-\d{2})〜(\d{2})-(\d{2})/); return m && today >= m[1] && today <= `${m[1].slice(0, 4)}-${m[2]}-${m[3]}`; });
          if (row) milestones.push({ source: source.name, week: row[0], period: row[1], goal: String(row[2] || ''), kpi: String(row[3] || '') });
        } else items.push(...extractSourceRows(values, source, today).map(x => ({ ...x, tab })));
      }
    } catch (e) { errors.push({ source: source.name, error: e.message }); log(`schedule-autopilot: ${source.name}: ${e.message}`); }
  }
  return { items, milestones, errors };
}

// ---------- 朝の一覧 ----------
const cap = (lines, n, more) => lines.length > n ? [...lines.slice(0, n), `　ほか${lines.length - n}件（${more}）`] : lines;
export function buildMorningDigest({ plans, now = new Date(), config = {}, sources = { items: [], milestones: [] }, ledgerUrl = '' }) {
  const { date } = jstNow(now), opts = bizOpts(config);
  const business = isBusinessDay(date, opts), streak = business ? closedStreakAfter(date, opts) : 0;
  const staged = plans.map(p => ({ p, s: stageOf(p, now, config) })).filter(x => x.s !== 'none');
  const asks = staged.filter(x => x.p.needsKim && ['start', 'prev', 'day', 'hours', 'late'].includes(x.s));
  const lines = [`【予定の先回り ${md(date)}(${wd(date)}) 朝】${streak >= 2 ? `明日から${streak}連休。連休明けまでの分を今日の午前に前倒しします。` : ''}`];
  const sendNow = staged.filter(x => x.p.type === 'send' && ['day', 'hours'].includes(x.s));
  if (sendNow.length) lines.push('', '🔴 今日の午前中に送るもの', ...cap(sendNow.map(x => `・${x.p.title}（${x.p.id}・${when(x.p)}まで${x.p.moved ? `・期限${x.p.moved}` : ''}）担当 ${x.p.assignee}`), 8, '期限台帳'));
  if (asks.length) lines.push('', '🙋 金さんの判断待ち（答えるだけで進みます）', ...cap(asks.map((x, i) => `${i + 1}. ${x.p.title}（${when(x.p)}まで）: ${x.p.needsKim}${x.p.recommend ? ` → 推奨「${x.p.recommend}」` : ''}　返事例「${i + 1} 可」`), 8, '受信箱'));
  const today = staged.filter(x => x.p.type !== 'send' && ['day', 'hours'].includes(x.s) && !x.p.needsKim);
  if (today.length) lines.push('', '🟠 今日が期限', ...cap(today.map(x => `・${x.p.title}（${x.p.id}）担当 ${x.p.assignee}`), 8, '期限台帳'));
  const ahead = staged.filter(x => ['prev', 'start'].includes(x.s) && !x.p.needsKim);
  if (ahead.length) lines.push('', `🟡 ${streak >= 2 ? '連休明けに期限が来るもの（今日のうちに準備）' : '次の営業日に期限が来るもの（今日のうちに準備）'}`, ...cap(ahead.map(x => `・${x.p.title}（${x.p.id}・${when(x.p)}）担当 ${x.p.assignee}`), 8, '期限台帳'));
  const late = staged.filter(x => x.s === 'late');
  if (late.length) lines.push('', '⚠️ 遅れ（挽回策つき）', ...cap(late.map(x => `・${x.p.title}（${x.p.id}・${when(x.p)}）${recoveryPlan(x.p, config)}`), 6, '期限台帳'));
  const planLate = sources.items.filter(i => i.kind === 'plan' && i.diff < 0), planToday = sources.items.filter(i => i.kind === 'plan' && i.diff === 0);
  if (planLate.length || planToday.length || sources.milestones.length) {
    lines.push('', `📈 3億円計画: 今日のタスク ${planToday.length}件／終わっていない過去分 ${planLate.length}件`);
    for (const m of sources.milestones) lines.push(`　今週(${m.week})の目標: ${m.goal.slice(0, 80)}`);
    if (planLate.length) lines.push(...cap(planLate.map(i => `・${md(i.date)} ${i.title}（${i.assignee || '担当未定'}）→ 今日の朝枠に繰り越し`), 4, '3億円 実行計画'));
  }
  const follow = sources.items.filter(i => ['followup', 'project', 'inquiry'].includes(i.kind) && i.diff <= 0);
  if (follow.length) lines.push('', `📞 営業・案件・問い合わせ（期日が今日まで ${follow.length}件）`, ...cap(follow.sort((a, b) => a.diff - b.diff).map(i => `・${i.source}: ${i.title} ${md(i.date)}${i.diff < 0 ? `（${-i.diff}日過ぎ）` : ''} 担当 ${i.assignee || '未定'}`), 5, '各シート'));
  if (lines.length === 1) lines.push('今日・次の営業日に手当てが要る予定はありません。');
  if (ledgerUrl) lines.push('', `期限台帳: ${ledgerUrl}`);
  return { text: lines.join('\n'), asks: asks.map(x => x.p), counts: { send: sendNow.length, asks: asks.length, today: today.length, ahead: ahead.length, late: late.length, planLate: planLate.length, follow: follow.length }, business };
}

// ---------- 台帳アクセス（deadline-ledger を再利用） ----------
async function ledgerDeps(home, config) {
  const { createLedger } = await import('./deadline-ledger.mjs');
  const { createSheetsClient } = await import('./lib/sheets-dwd.mjs');
  const { gwsFetch } = await import('./lib/gws-proxy.mjs');
  const sheets = createSheetsClient({ fetchImpl: gwsFetch });
  return { sheets, ledger: createLedger({ sheets, config: { sheetId: config.ledgerSheetId } }) };
}
const newId = () => `S-${Date.now().toString(36).toUpperCase()}${randomBytes(1).toString('hex').toUpperCase()}`;
export function buildRow(input, { today, pc, sessionId = '' }) {
  const when = parseWhen(input.due);
  if (!input.title || !when) throw new Error('--title と --due (YYYY-MM-DD[ HH:MM]) が必要です');
  const type = TYPES.includes(input.type) ? input.type : undefined;
  const meta = Object.fromEntries(Object.entries({ type, time: when.time, needsKim: input.needsKim, recommend: input.recommend, draftUrl: input.draftUrl,
    prepDays: input.prepDays !== undefined ? Number(input.prepDays) : undefined, pc, session: sessionId }).filter(([, v]) => v !== undefined && v !== '' && v !== null));
  const norm = String(input.title).normalize('NFKC').replace(/\s+/g, '');
  return { id: input.id || newId(), title: String(input.title).slice(0, 200), kind: input.kind || (type === 'send' ? '提出' : 'その他'), company: input.company || '',
    due: when.date, remainingDays: '', status: '未着手', assignee: input.assignee || 'kim', action: input.action || '', quote: input.quote || input.draftUrl || '',
    source: `session:${pc}`, sourceId: input.sourceId || `session:${createHash('sha256').update(`${pc}|${norm}`).digest('hex').slice(0, 16)}`,
    detectedAt: today, lastNotified: '', notifyCount: 0, completedAt: '', notes: withMeta('', meta) };
}
export async function upsertRows(rows, { ledger }) {
  const { isDuplicate } = await import('./deadline-ledger.mjs');
  const existing = await ledger.read();
  const result = [];
  for (const row of rows) {
    const same = existing.find(r => r.sourceId === row.sourceId) || (isDuplicate(row, existing) ? existing.find(r => String(r.title).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase() === String(row.title).normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase()) : null);
    if (same) {
      const meta = { ...parseMeta(same.notes), ...parseMeta(row.notes) };
      const changes = {};
      if (row.due && row.due !== same.due && !isClosed(same)) changes.due = row.due;
      if (row.action && row.action !== same.action) changes.action = row.action;
      const notes = withMeta(same.notes, meta); if (notes !== same.notes) changes.notes = notes;
      if (Object.keys(changes).length) await ledger.patch(same.id, changes);
      result.push({ id: same.id, updated: Object.keys(changes) });
    } else { await ledger.append([row]); existing.push(row); result.push({ id: row.id, added: true }); }
  }
  return result;
}
const outboxDir = home => path.join(dataDir(home), 'autopilot-outbox');
export function queueOutbox(home, rows) {
  fs.mkdirSync(outboxDir(home), { recursive: true });
  for (const row of rows) saveJson(path.join(outboxDir(home), `${row.id}.json`), row);
}
export async function flushOutbox(home, deps) {
  let files = [];
  try { files = fs.readdirSync(outboxDir(home)).filter(f => f.endsWith('.json')); } catch { return { flushed: 0 }; }
  if (!files.length) return { flushed: 0 };
  const rows = files.map(f => readJson(path.join(outboxDir(home), f), null)).filter(Boolean);
  await upsertRows(rows, deps);
  for (const f of files) fs.rmSync(path.join(outboxDir(home), f), { force: true });
  return { flushed: rows.length };
}
export async function addEntries(home, inputs, { deps, now = new Date(), sessionId = '' } = {}) {
  const config = loadAutopilotConfig(home), pc = resolveFleetLabel(home), today = jstNow(now).date;
  const rows = inputs.map(input => buildRow(input, { today, pc, sessionId }));
  try {
    const d = deps || await ledgerDeps(home, config);
    await flushOutbox(home, d);
    return { ok: true, rows: await upsertRows(rows, d) };
  } catch (e) { queueOutbox(home, rows); return { ok: false, queued: rows.map(r => r.id), reason: e.message }; }
}

// ---------- 【予定】行の取り込み（Stop hook） ----------
// 例: 【予定】2026-11-24 09:00｜課題提供企業 第4便の送信｜種別:送信｜担当:008｜金さん判断:送ってよいか｜推奨:送る｜文面:https://...
const KEYS = { '種別': 'type', '担当': 'assignee', 'やること': 'action', '金さん判断': 'needsKim', '推奨': 'recommend', '文面': 'draftUrl', '準備日数': 'prepDays', '会社': 'company' };
const TYPE_WORDS = { '送信': 'send', '配信': 'send', '送付': 'send', '承認': 'approval', '判断': 'approval', '納期': 'delivery', '納品': 'delivery', 'やること': 'task', 'タスク': 'task' };
export function parseScheduleLines(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^[\s>*・-]+/, '').normalize('NFKC').replace(/\|/g, '｜');
    const m = line.match(/^【予定】\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2})?)\s*｜\s*([^｜]+?)\s*(?:｜(.*))?$/);
    if (!m) continue;
    const entry = { due: m[1], title: m[2].trim() };
    for (const part of (m[3] || '').split('｜')) {
      const kv = part.match(/^\s*([^:：]+)\s*[:：]\s*(.+?)\s*$/); if (!kv || !KEYS[kv[1].trim()]) continue;
      const key = KEYS[kv[1].trim()];
      entry[key] = key === 'type' ? (TYPE_WORDS[kv[2]] || (TYPES.includes(kv[2]) ? kv[2] : 'task')) : kv[2];
    }
    out.push(entry);
  }
  return out;
}
export async function captureHook({ raw, home = defaultHome(), deps } = {}) {
  if (!raw?.trim()) return { captured: 0 };
  const input = JSON.parse(raw);
  const text = input.last_assistant_message ?? input.assistant_text ?? (input.transcript_path && fs.existsSync(input.transcript_path) ? latestAssistantText(input.transcript_path) : '');
  const entries = parseScheduleLines(text);
  if (!entries.length) return { captured: 0 };
  const result = await addEntries(home, entries, { deps, sessionId: input.session_id || '' });
  return { captured: entries.length, ...result };
}

// ---------- 届ける ----------
export async function defaultDeliver({ home, kind, text, title, dedupeKey, urgent = true }) {
  const { addItem } = await import('./kim-inbox.mjs');
  const item = await addItem(home, { kind, urgent, source: 'schedule-autopilot', dedupeKey, text });
  if (title) {
    const { appendMobilePush } = await import('./lib/mobile-push-queue.mjs');
    const { resolveOwner } = await import('./lib/fleet-owner.mjs');
    appendMobilePush(home, { owner: resolveOwner({ home }), title, body: text.slice(0, 900) });
  }
  return item;
}
async function syncKimCalendar(plan, { config, request, state }) {
  if (!config.calendar?.enabled || !request || plan.assignee !== 'kim' || !plan.time || plan.type === 'send') return;
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendar.calendarId || 'kim@orgiast.jp')}/events`;
  const opts = { user: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/calendar.events' };
  const key = `${plan.id}:${plan.actionAt}`; if (state.calendar?.[plan.id] === key) return;
  const start = new Date(Date.parse(`${plan.actionAt}:00+09:00`)), end = new Date(start.getTime() + 30 * 60000);
  const body = { summary: `【調整可】${plan.title}`, start: { dateTime: start.toISOString(), timeZone: 'Asia/Tokyo' }, end: { dateTime: end.toISOString(), timeZone: 'Asia/Tokyo' },
    description: [`やること: ${plan.action || plan.title}`, plan.needsKim ? `判断: ${plan.needsKim}${plan.recommend ? `（推奨: ${plan.recommend}）` : ''}` : '', plan.draftUrl ? `文面・資料: ${plan.draftUrl}` : '', `期限台帳 ${plan.id}`].filter(Boolean).join('\n'),
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: config.calendar.reminderMinutes ?? 30 }] }, extendedProperties: { private: { autopilotId: plan.id } } };
  const found = await request(`${base}?${new URLSearchParams({ privateExtendedProperty: `autopilotId=${plan.id}` })}`, opts);
  if (found.items?.[0]) await request(`${base}/${encodeURIComponent(found.items[0].id)}?sendUpdates=none`, { ...opts, method: 'PATCH', body });
  else await request(`${base}?sendUpdates=none`, { ...opts, method: 'POST', body });
  (state.calendar ||= {})[plan.id] = key;
}
// 金さんの回答を台帳に書き、担当PCへ次工程を依頼する（自動で次へ進む）。
export async function applyAnswers({ home, ledger, state, listItems, sendPrompt, plansById }) {
  const done = [];
  for (const item of listItems(home, { status: 'answered' }).filter(i => i.source === 'schedule-autopilot' && String(i.dedupeKey || '').includes('schedule-autopilot:ask:'))) {
    if (state.answers?.[item.id]) continue;
    const id = String(item.dedupeKey).split('schedule-autopilot:ask:')[1].split(':')[0];
    const plan = plansById.get(id); const answer = String(item.answer?.text ?? item.answer ?? '').slice(0, 500);
    if (plan) {
      const rows = await ledger.read(); const row = rows.find(r => r.id === id);
      if (row) await ledger.patch(id, { status: /見送|不要|やめ/.test(answer) ? '不要' : '対応中', notes: `${row.notes || ''}\n金さん回答 ${item.answeredAt || ''}: ${answer}`.trim() });
      if (plan.pc && !/見送|不要|やめ/.test(answer)) await sendPrompt(plan.pc, `[作業依頼] 期限台帳 ${id}「${plan.title}」に金さんが回答しました: 「${answer}」\n回答どおりに次の工程を進めてください（期限 ${when(plan)}）。社外送信は回答で承認された文面・宛先の範囲だけ。終わったら node tools/schedule-autopilot.mjs done --id ${id}`);
    }
    (state.answers ||= {})[item.id] = new Date().toISOString(); done.push(id);
  }
  return done;
}
async function defaultSendPrompt(home, to, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-'));
  try {
    const file = path.join(dir, 'body.txt'); fs.writeFileSync(file, body);
    await exec(process.execPath, [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--send', '--to', to, '--kind', 'prompt', '--why', `[作業依頼] 金さん回答の反映（schedule-autopilot）`, '--body-file', file], { timeout: 120000, windowsHide: true, env: { ...process.env, ORGIAST_HOME: home } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

export async function run({ home = defaultHome(), slot = 'tick', now = new Date(), dryRun = false, deps = {} } = {}) {
  const config = deps.config || loadAutopilotConfig(home);
  const { date } = jstNow(now);
  const statePath = path.join(dataDir(home), 'autopilot-state.json');
  const state = deps.state || readJson(statePath, {});
  const ld = deps.ledger ? deps : await ledgerDeps(home, config);
  if (!dryRun) await flushOutbox(home, ld).catch(() => {});
  const rows = deps.rows || await ld.ledger.read();
  const plans = rows.filter(r => !isClosed(r)).map(r => planItem(r, config)).filter(Boolean);
  const plansById = new Map(plans.map(p => [p.id, p]));
  const deliver = deps.deliver || (msg => defaultDeliver({ home, ...msg }));
  const out = { slot, date, sent: [], asks: [], answers: [], errors: [] };
  if (slot === 'morning') {
    const sources = deps.sources || await readSources(config, ld.sheets, date);
    const digest = buildMorningDigest({ plans, now, config, sources, ledgerUrl: `https://docs.google.com/spreadsheets/d/${config.ledgerSheetId}/edit` });
    out.digest = digest; out.sourceErrors = sources.errors || [];
    const key = `morning:${date}`;
    const quiet = !digest.business && !digest.counts.send && !digest.counts.asks && !digest.counts.late;
    if (!quiet && !state.sent?.[key] && !dryRun) {
      await deliver({ kind: 'info', text: digest.text, title: `予定の先回り ${md(date)}: 送る${digest.counts.send}・判断${digest.counts.asks}・遅れ${digest.counts.late}`, dedupeKey: `schedule-autopilot:${key}` });
      (state.sent ||= {})[key] = new Date().toISOString(); out.sent.push(key);
    }
    for (const [i, p] of digest.asks.entries()) {
      const s = stageOf(p, now, config), k = `schedule-autopilot:ask:${p.id}:${s}`;
      if (state.sent?.[k] || dryRun) continue;
      await deliver({ kind: 'ask', text: askText(p, i + 1), dedupeKey: k, urgent: s !== 'start' });
      (state.sent ||= {})[k] = new Date().toISOString(); out.asks.push(p.id);
    }
  } else {
    // 締切の数時間前（hours）と遅れ（late）を、段階ごとに1回だけ個別に届ける。
    for (const p of plans) {
      const s = stageOf(p, now, config);
      if (!['hours', 'late'].includes(s)) continue;
      const k = `schedule-autopilot:${s}:${p.id}:${p.actionAt}`;
      if (state.sent?.[k]) continue;
      if (s === 'late' && (Date.parse(`${jstNow(now).date}T${jstNow(now).time}:00Z`) - Date.parse(`${p.actionAt}:00Z`)) > 30 * 60000) continue; // 遅れは期限直後に1回。翌朝以降は朝の一覧で扱う
      const text = s === 'hours'
        ? `${STAGE_MARK.hours} あと${config.hoursBefore ?? 3}時間: ${p.title}（${p.id}・${when(p)}まで・担当 ${p.assignee}）${p.needsKim ? `\n判断: ${p.needsKim}${p.recommend ? `（推奨: ${p.recommend}）` : ''}\n返事の例: 可／直す: <点>／見送り` : ''}`
        : `${STAGE_MARK.late} 期限を過ぎました: ${p.title}（${p.id}・${when(p)}）\n${recoveryPlan(p, config)}`;
      if (!dryRun) await deliver({ kind: p.needsKim && s === 'hours' ? 'ask' : 'info', text, title: text.split('\n')[0].slice(0, 90), dedupeKey: p.needsKim && s === 'hours' ? `schedule-autopilot:ask:${p.id}:hours` : k });
      (state.sent ||= {})[k] = new Date().toISOString(); out.sent.push(k);
    }
  }
  if (!dryRun) {
    try {
      const { listItems } = deps.listItems ? { listItems: deps.listItems } : await import('./kim-inbox.mjs');
      out.answers = await applyAnswers({ home, ledger: ld.ledger, state, listItems, plansById, sendPrompt: deps.sendPrompt || ((to, body) => defaultSendPrompt(home, to, body)) });
    } catch (e) { out.errors.push({ phase: 'answers', error: e.message }); }
    if (config.calendar?.enabled && slot === 'morning') {
      let request = deps.request;
      try { if (!request) request = (await import('./deadline-ledger.mjs')).googleClient(); } catch {}
      for (const p of plans) { try { await syncKimCalendar(p, { config, request, state }); } catch (e) { out.errors.push({ id: p.id, phase: 'calendar', error: e.message }); } }
    }
    state.lastRunAt = new Date().toISOString();
    if (!deps.state) saveJson(statePath, state);
    if (out.digest) saveJson(path.join(dataDir(home), 'autopilot-digest.json'), { at: state.lastRunAt, date, text: out.digest.text, counts: out.digest.counts });
  }
  return out;
}

// ---------- CLI ----------
export function parseArgs(argv) {
  const [command, ...rest] = argv; const args = { command };
  const map = { '--title': 'title', '--due': 'due', '--type': 'type', '--assignee': 'assignee', '--action': 'action', '--needs-kim': 'needsKim', '--recommend': 'recommend',
    '--draft-url': 'draftUrl', '--prep-days': 'prepDays', '--company': 'company', '--source-id': 'sourceId', '--quote': 'quote', '--slot': 'slot', '--now': 'now', '--id': 'id', '--note': 'note' };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dry-run') { args.dryRun = true; continue; }
    if (rest[i] === '--json') { args.json = true; continue; }
    const key = map[rest[i]]; if (!key || rest[i + 1] === undefined) throw new Error(`不明な引数または値不足: ${rest[i]}`);
    args[key] = rest[++i];
  }
  return args;
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home || defaultHome(), log = deps.log || console.log;
  let args;
  try { args = parseArgs(argv); } catch (e) { console.error(`schedule-autopilot: ${e.message}`); return 2; }
  try {
    if (args.command === 'capture') {
      try { await captureHook({ raw: await readStdinWithTimeout(4000), home }); } catch {}
      return 0; // hook はセッションを止めない
    }
    if (args.command === 'add') { const r = await addEntries(home, [args], { sessionId: process.env.CLAUDE_SESSION_ID || '' }); log(JSON.stringify(r)); return r.ok ? 0 : 3; }
    if (args.command === 'flush') { const config = loadAutopilotConfig(home); log(JSON.stringify(await flushOutbox(home, await ledgerDeps(home, config)))); return 0; }
    const now = args.now ? new Date(args.now) : new Date();
    if (args.command === 'plan') {
      const config = loadAutopilotConfig(home); const { ledger } = await ledgerDeps(home, config);
      const plans = (await ledger.read()).filter(r => !isClosed(r)).map(r => planItem(r, config)).filter(Boolean).map(p => ({ ...p, stage: stageOf(p, now, config) }));
      log(JSON.stringify(plans.filter(p => p.stage !== 'none' || args.json), null, 2)); return 0;
    }
    if (args.command === 'run') {
      const r = await run({ home, slot: args.slot || 'tick', now, dryRun: !!args.dryRun });
      log(args.dryRun && r.digest ? r.digest.text : JSON.stringify({ ...r, digest: r.digest ? { counts: r.digest.counts } : undefined }, null, 2)); return r.errors.length ? 1 : 0;
    }
    if (args.command === 'done') {
      const config = loadAutopilotConfig(home); const { ledger } = await ledgerDeps(home, config);
      await ledger.patch(args.id, { status: '完了', completedAt: jstNow().date }); log(`完了: ${args.id}`); return 0;
    }
    console.error('使い方: schedule-autopilot.mjs add|capture|flush|plan|run|done'); return 2;
  } catch (e) { console.error(`schedule-autopilot: ${e.message}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await main();
