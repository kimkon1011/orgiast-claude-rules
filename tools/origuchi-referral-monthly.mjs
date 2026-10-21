#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { createSheetsClient } from './lib/sheets-dwd.mjs';
import { getAccessToken } from './lib/freee-auth.mjs';
import { buildRawMessage, createDraft, deleteDraft } from './gmail-draft.mjs';
import { sendDiscordDm } from './discord-dm.mjs';

export const SPREADSHEET_ID = '1q1qM9cwtCX4W-E_ONyJZqWgfOCvmY83Axwqf_LLbwtA';
const RECORDS = "'紹介料支払記録'";
const USER = 'kim@orgiast.jp';
const TO = 'iwaoka@broadcapitalpartners.com';
export const monthKey = now => new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 7);
const dateLabel = now => new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '/');
export function shouldRunMonthly({ marker = {}, now = new Date(), force = false } = {}) {
  return force || marker.lastSentMonth !== monthKey(now);
}
export function amount(value) {
  if (value === undefined || value === null || String(value).trim() === '') return NaN;
  return Number(String(value).replace(/[,￥¥円\s]/g, ''));
}
export function invoiceNet(value) {
  const annotated = /^([\d,]+)(?:円)?[（(]税込[\d,]+(?:円)?[）)]$/.exec(String(value ?? '').trim());
  return amount(annotated ? annotated[1] : value);
}
export function matchesTaxInclusive(net, gross) {
  return invoiceNet(net) > 0 && Number.isFinite(amount(gross)) && Math.round(invoiceNet(net) * 1.1) === amount(gross);
}
// Sheet formulas can have sub-yen values; report yen rounded to the nearest integer.
const yen = value => Number.isFinite(amount(value)) ? `${Math.round(amount(value)).toLocaleString('ja-JP')}円` : '金額確認中';
export function parseProjects(rows) {
  return rows.slice(1).filter(r => r[1] || r[2]).map(r => ({
    status: String(r[0] ?? '').trim(), customer: r[1] || '', name: r[2] || '', url: r[3] || '',
    sales: r[4], depositDate: r[5], fee: r[7], invoice: r[8], invoiceAmount: r[9], paid: r[10], total: r[16],
  }));
}
export function uninvoicedProjects(projects, records) {
  return projects.filter(p => p.status === '納品完了' && !records.some(r => r[0] === p.url && r[1] && !/未受領|未請求/.test(r[1])));
}
export function planUpdates(projects, records, deals, now = new Date()) {
  const updates = [], additions = [], review = [], projected = records.map(r => [...r]);
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    if (!String(row[3] ?? '').startsWith('未払')) continue;
    const label = `${row[4] || row[0]}（${yen(invoiceNet(row[2]))}・記録${i + 1}行）`;
    if (!Number.isFinite(invoiceNet(row[2]))) { review.push(`${label}: 一致判定できない請求書（金額注記・まとめ請求を確認）`); continue; }
    const candidates = deals.filter(d => matchesTaxInclusive(row[2], d.amount));
    if (!candidates.length) { review.push(`${label}: freee 未登録または金額不一致／当社未払`); continue; }
    if (candidates.length !== 1 || records.slice(1).filter(r => invoiceNet(r[2]) === invoiceNet(row[2])).length !== 1 || records.filter(r => r[0] === row[0]).length !== 1) {
      review.push(`${label}: 一致判定できない請求書（同額・重複・まとめ請求を確認）`); continue;
    }
    const deal = candidates[0], payments = deal.payments || [];
    if (!payments.length) { review.push(`${label}: 当社未払の請求書`); continue; }
    const receipt = deal.receipts?.[0];
    const receiptId = typeof receipt === 'object' ? receipt.id : receipt;
    if (payments.some(p => !/^\d{4}-\d{2}-\d{2}$/.test(p.date)) || payments.reduce((n, p) => n + amount(p.amount), 0) !== amount(deal.amount) || !receiptId || deal.receipts.length !== 1) {
      review.push(`${label}: 一致判定できない請求書（分割・一部入金・証憑を確認）`); continue;
    }
    const paid = payments.map(p => p.date).sort().at(-1);
    const url = `https://secure.freee.co.jp/receipts/${receiptId}`;
    updates.push({ row: i + 1, url, paid, label });
    projected[i][1] = url; projected[i][3] = paid;
  }
  for (const p of projects.filter(p => p.status === '納品完了')) {
    if (!p.url || projects.filter(q => q.url === p.url).length !== 1) { review.push(`${p.customer} ${p.name}: 見積書URLが空欄または重複`); continue; }
    if (!projected.some(r => r[0] === p.url)) {
      const row = [p.url, `ご請求書未受領（${dateLabel(now)} 時点）`, '', '', p.customer];
      additions.push(row); projected.push(row);
    }
  }
  return { updates, additions, review, projected };
}
// Sheets returns date cells as serial days; text dates are also used in G.
function depositDay(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000;
  }
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(value ?? '').trim());
  if (!match) return NaN;
  const [, year, month, day] = match.map(Number);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? timestamp : NaN;
}
export function oldApproachProjects(projects, now = new Date()) {
  const cutoff = depositDay(dateLabel(now)) - 90 * 86400000;
  return projects.filter(p => p.status === 'アプローチリスト' && depositDay(p.depositDate) <= cutoff);
}
export function buildEmail(projects, records, now = new Date()) {
  const [year, month] = monthKey(now).split('-');
  const missing = uninvoicedProjects(projects, records);
  const completed = projects.filter(p => p.status === '納品完了');
  const lines = completed.map(p => `・${p.customer}／${p.name}\n  売上：${yen(p.sales)}　ご紹介料：${yen(p.fee)}\n  ご請求書：${missing.includes(p) ? '未受領' : '受領済み'}`);
  const excluded = new Set(oldApproachProjects(projects, now));
  const progressing = ['確定', 'アプローチリスト'].map(status => {
    const list = projects.filter(p => p.status === status && !excluded.has(p));
    return `${status}：${list.length}件\n${list.map(p => `・${p.customer}／${p.name}（売上合計：${yen(p.total)}）`).join('\n')}`;
  });
  return { subject: `【株式会社オージャスト】折口様ご紹介案件のご報告（${year}年${Number(month)}月）`, body: `ブロードキャピタル・パートナーズ\n岩岡様\n\nいつも大変お世話になっております。\n株式会社オージャストの金 功勇です。\n折口様よりご紹介いただいた案件につきまして、今月の状況をご報告いたします。\n\n【納品完了の案件】\n${lines.join('\n\n') || '今月の該当案件はございません。'}\n\n${missing.length ? `【ご請求書送付のお願い】\n以下の案件のご紹介料につきまして、ご請求書をお送りいただけますと幸いです。\n${missing.map(p => `・${p.customer}／${p.name}：${yen(p.fee)}`).join('\n')}\n送付先：弊社経理 keiri2@orgiast.jp\n\n` : ''}【進行中の案件】\n${progressing.join('\n\n')}\n\n引き続き、どうぞよろしくお願い申し上げます。\n\n株式会社オージャスト 金 功勇` };
}
export function buildDm(plan, { dryRun = false, excludedApproaches = [] } = {}) {
  return `${dryRun ? '【dry-run／更新・下書き作成・DM送信は未実施】\n' : ''}折口様紹介案件の月次チェックが終わり、岩岡様宛メールを Gmail の下書きに入れました。確認して送ってください。\nhttps://mail.google.com/mail/?authuser=kim@orgiast.jp#drafts （kim@orgiast.jp で開く）\n\n今回シートで更新${dryRun ? '予定' : 'した'}行（紹介料支払記録）：\n${[...plan.updates.map(u => `・${u.label}: B列 証憑URL、D列 ${u.paid}`), ...plan.additions.map(r => `・追加 ${r[4]}: ${r[0]}／${r[1]}`)].join('\n') || 'なし'}\n\n要確認：\n${plan.review.map(r => `・${r}`).join('\n') || 'なし'}\n\nメールから外した古いアプローチ案件：${excludedApproaches.length}件\n${excludedApproaches.map(p => `・${p.customer}／${p.name}`).join('\n') || 'なし'}`;
}
export async function fetchDeals({ fetchImpl = fetch, getToken = getAccessToken } = {}) {
  const token = await getToken(), deals = [];
  for (let offset = 0; ; offset += 100) {
    const params = new URLSearchParams({ company_id: '11975741', partner_id: '117417637', type: 'expense', limit: '100', offset: String(offset) });
    const res = await fetchImpl(`https://api.freee.co.jp/api/1/deals?${params}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`freee deals HTTP ${res.status}`);
    const page = (await res.json()).deals;
    if (!Array.isArray(page)) throw new Error('freee deals の形式が不正です');
    if (page.some(d => d.type !== 'expense' || Number(d.partner_id) !== 117417637)) throw new Error('freee の取引先・収支区分が一致しません');
    deals.push(...page);
    if (page.length < 100) return deals;
  }
}
function readMarker(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function saveMarker(file, marker) {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(marker, null, 2)); fs.renameSync(`${file}.tmp`, file);
}
export async function runMonthly({ dryRun = false, force = false, now = new Date(), home = process.env.ORGIAST_HOME || os.homedir(), claudeDir = path.join(home, '.claude') } = {}, deps = {}) {
  const file = path.join(claudeDir, 'origuchi-referral-monthly.json');
  const notify = deps.sendDm || ((target, body) => sendDiscordDm(target, body, { home }));
  let stage = '月次マーカー確認', locked = false, createdDraftId;
  try {
    if (!dryRun) {
      fs.mkdirSync(claudeDir, { recursive: true });
      try { fs.mkdirSync(`${file}.lock`); locked = true; } catch (e) { if (e.code === 'EEXIST') return { skipped: true, reason: '実行中または中断した処理のロックあり' }; throw e; }
    }
    const marker = readMarker(file);
    if (!dryRun && !shouldRunMonthly({ marker, now, force })) return { skipped: true };
    if (!dryRun && marker.pending && !force) {
      if (!marker.pending.draftId) throw new Error('下書き作成結果が不明です。Gmail を確認してから --force で再実行してください');
      stage = 'Discord DM 再送'; await notify('kim', marker.pending.dm);
      saveMarker(file, { lastSentMonth: marker.pending.month, lastSentAt: now.toISOString() });
      return { resumed: true, draftId: marker.pending.draftId };
    }
    const sheets = deps.sheets || createSheetsClient();
    stage = 'シート読み取り';
    const projectRows = await sheets.get(SPREADSHEET_ID, "'折口様紹介案件'!B2:R");
    const records = await sheets.get(SPREADSHEET_ID, `${RECORDS}!A:E`);
    if (!projectRows.length || !records.length) throw new Error('シート見出しがありません');
    const projects = parseProjects(projectRows);
    stage = 'freee 読み取り';
    const deals = await (deps.fetchDeals || fetchDeals)();
    const plan = planUpdates(projects, records, deals, now);
    const email = buildEmail(projects, plan.projected, now), dm = buildDm(plan, { dryRun, excludedApproaches: oldApproachProjects(projects, now) });
    if (dryRun) return { dryRun, email, dm, plan };
    stage = '紹介料支払記録の更新';
    for (const u of plan.updates) {
      await sheets.update(SPREADSHEET_ID, `${RECORDS}!B${u.row}`, [[u.url]]);
      await sheets.update(SPREADSHEET_ID, `${RECORDS}!D${u.row}`, [[u.paid]]);
    }
    if (plan.additions.length) await sheets.append(SPREADSHEET_ID, `${RECORDS}!A:E`, plan.additions);
    stage = '更新結果の確認';
    const actual = await sheets.get(SPREADSHEET_ID, `${RECORDS}!A:E`);
    for (const u of plan.updates) if (actual[u.row - 1]?.[1] !== u.url || actual[u.row - 1]?.[3] !== u.paid) throw new Error(`記録${u.row}行の更新確認失敗`);
    for (const r of plan.additions) if (!actual.some(a => a[0] === r[0] && a[1] === r[1])) throw new Error('追加行の確認失敗');
    stage = 'Gmail 下書き作成';
    const pending = { month: monthKey(now), dm };
    saveMarker(file, { ...marker, pending }); // Ambiguous API failures must not create duplicate drafts on retry.
    const draft = await (deps.createDraft || createDraft)({ user: USER, raw: buildRawMessage({ from: USER, to: TO, ...email }) });
    createdDraftId = draft.id; pending.draftId = draft.id; saveMarker(file, { ...marker, pending });
    stage = 'Discord DM 送信'; await notify('kim', dm);
    stage = '完了記録'; saveMarker(file, { lastSentMonth: monthKey(now), lastSentAt: now.toISOString() });
    return { email, dm, draftId: draft.id, plan };
  } catch (error) {
    if (!dryRun) {
      if (createdDraftId) {
        try {
          await (deps.deleteDraft || deleteDraft)({ user: USER, id: createdDraftId });
          const marker = readMarker(file); delete marker.pending; saveMarker(file, marker);
        } catch (cleanupError) {
          error.message += `／下書き削除に失敗: ${cleanupError.message}（Gmail を要確認）`;
        }
      }
      try { await notify('kim', `折口様紹介案件の月次チェックに失敗しました。\n段階：${stage}\n理由：${error.message}\n処理を停止しました。Gmail 下書き作成段階以降の場合は、下書き一覧も確認してください。`); }
      catch (dmError) { console.error(`失敗通知DMも失敗: ${dmError.message}`); }
    }
    throw new Error(`${stage}: ${error.message}`, { cause: error });
  } finally { if (locked) fs.rmdirSync(`${file}.lock`); }
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.some(a => !['--dry-run', '--force', '--json'].includes(a))) throw new Error('usage: origuchi-referral-monthly.mjs [--dry-run] [--force] [--json]');
  const result = await runMonthly({ dryRun: argv.includes('--dry-run'), force: argv.includes('--force') });
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : result.skipped ? '今月は実行済み、または実行中です。' : result.email ? `${result.email.subject}\n\n${result.email.body}\n\n--- Discord DM ---\n${result.dm}` : 'Discord DM を再送しました。');
  return result;
}
if (isEntry(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1; });
