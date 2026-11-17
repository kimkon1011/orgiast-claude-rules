#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { isEntry } from './is-entry.mjs';

const exec = promisify(execFile);
export const EVENT_ID = '5269635';
export const FOLDER_ID = '11aNyUT75_70j-S6xN26mTv5ML1eEcze7';
export const KPI_SHEET_NAME = '【飲食×AI】集客KPI 日次';
const USER = 'seisaku-team@orgiast.jp';
const JST = 'Asia/Tokyo';
const HEADERS = ['実行日時','Peatix申込数','チケット種別','Gmail社外返信','Gmail前向き','Gmail辞退','企業マスタ送信','企業マスタ返信','企業前向き','参加者マスタ送信','参加者マスタ返信','判定','不足','実行証跡'];

export const MILESTONES = [
  { date: '2026-11-20', positive: 1 }, { date: '2026-11-21', registrations: 5 },
  { date: '2026-11-24', positive: 2, registrations: 10 },
  { date: '2026-11-26', confirmed: 3 }, { date: '2026-11-27', registrations: 15 },
  { date: '2026-12-01', registrations: 20 },
  { date: '2026-12-04', registrations: 25, materials: 5 },
  { date: '2026-12-07', registrations: 30, speakers: 10 },
];

export function evaluateKpi(metrics, today) {
  const due = MILESTONES.filter(x => x.date <= today);
  const required = Object.assign({}, ...due.map(x => Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'date'))));
  const labels = { positive: '企業の前向き返信', confirmed: '企業確定', registrations: '申込', materials: '資料提出', speakers: '登壇' };
  const missing = Object.entries(required).flatMap(([key, target]) => (Number(metrics[key]) || 0) < target ? [`${labels[key]} ${target - (Number(metrics[key]) || 0)}件（必要${target}、現在${Number(metrics[key]) || 0}）`] : []);
  return { status: missing.length ? '遅れ' : '順調', missing, required };
}

const b64 = value => Buffer.from(value).toString('base64url');
function serviceAccountPath() {
  return process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(os.homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.gcp', 'sheets-sa.json');
}
async function token(scope, subject = USER) {
  const sa = JSON.parse(fs.readFileSync(serviceAccountPath(), 'utf8').replace(/^\uFEFF/, ''));
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify({ iss: sa.client_email, sub: subject, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const signer = createSign('RSA-SHA256'); signer.update(input);
  const assertion = `${input}.${signer.sign(sa.private_key, 'base64url')}`;
  const response = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); if (!response.ok || !data.access_token) throw new Error(`Google OAuth HTTP ${response.status}: ${data.error || 'token unavailable'}`);
  return data.access_token;
}
async function api(url, accessToken, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...options.headers }, body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body, signal: AbortSignal.timeout(30000) });
  const text = await response.text(); if (!response.ok) throw new Error(`Google API HTTP ${response.status}: ${text.slice(0, 300)}`); return text ? JSON.parse(text) : null;
}
function jstParts(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: JST, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(now).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, timestamp: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}` };
}
async function gmailJson(accessToken, endpoint) { return api(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, accessToken); }
function headersOf(message) { return Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value])); }
function decodeBody(part) { if (part?.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8'); return (part?.parts || []).map(decodeBody).join('\n'); }
function outsideOrg(from = '') { return !/@orgiast\.jp\b/i.test(from); }

async function classifyReplies(rows) {
  if (!rows.length) return { positive: 0, declined: 0, other: 0 };
  const promptFile = path.join(os.tmpdir(), `eig-replies-${process.pid}.txt`);
  const safe = rows.map((r, i) => ({ id: i, subject: r.subject, text: r.text.slice(0, 1500) }));
  fs.writeFileSync(promptFile, `以下の社外返信を positive/declined/other に分類し、JSON配列 [{"id":0,"label":"positive"}]だけを返す。positive=参加・検討・紹介など前向き、declined=辞退。\n${JSON.stringify(safe)}`, { mode: 0o600 });
  try {
    const llm = fileURLToPath(new URL('./llm-ask.mjs', import.meta.url));
    const { stdout } = await exec(process.execPath, [llm, '--provider', 'gemini', '--prefer-provider', '--category', 'classification', '--max', '1200', '--prompt-file', promptFile], { timeout: 120000, windowsHide: true });
    const json = JSON.parse(stdout.slice(stdout.indexOf('['), stdout.lastIndexOf(']') + 1));
    return json.reduce((a, x) => { if (x.label === 'positive') a.positive++; else if (x.label === 'declined') a.declined++; else a.other++; return a; }, { positive:0, declined:0, other:0 });
  } catch { return { positive: 0, declined: 0, other: rows.length, classificationError: true }; }
  finally { fs.rmSync(promptFile, { force: true }); }
}

export async function collectGmail(accessToken) {
  const list = await gmailJson(accessToken, `threads?q=${encodeURIComponent('subject:(飲食×AI)')}&maxResults=100`);
  const replies = [];
  for (const item of list.threads || []) {
    const thread = await gmailJson(accessToken, `threads/${item.id}?format=full`);
    for (const message of thread.messages || []) {
      const h = headersOf(message); if (!outsideOrg(h.from)) continue;
      replies.push({ id: message.id, subject: h.subject || '', from: h.from || '', text: decodeBody(message.payload).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
    }
  }
  return { total: replies.length, ...(await classifyReplies(replies)) };
}

async function waitForCode(accessToken, afterMs) {
  for (let tries = 0; tries < 30; tries++) {
    const list = await gmailJson(accessToken, `messages?q=${encodeURIComponent('from:noreply@peatix.com subject:認証コード newer_than:1d')}&maxResults=10`);
    for (const item of list.messages || []) {
      const message = await gmailJson(accessToken, `messages/${item.id}?format=full`); if (Number(message.internalDate) < afterMs - 5000) continue;
      const match = `${headersOf(message).subject || ''}\n${decodeBody(message.payload)}`.match(/\b(\d{6})\b/); if (match) return match[1];
    }
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error('Peatix 認証コードを取得できません');
}
function parseTicketText(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const tickets = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/(?:申込|参加者|枚数|売上枚数)?\s*(\d+)\s*(?:枚|人|件)(?:\s*[/／]\s*\d+)?/);
    if (!match) continue;
    const name = lines.slice(Math.max(0, i - 2), i).findLast(x => !/^\d|[円%]$/.test(x)) || '合計';
    if (!tickets.some(t => t.name === name)) tickets.push({ name, count: Number(match[1]) });
  }
  return tickets;
}
export async function collectPeatix(gmailToken) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto('https://peatix.com/signin', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.locator('input[type="email"]').fill(USER); await page.locator('#next-button').click();
    await page.locator('#send-passcode-button').waitFor({ timeout: 30000 }); const requested = Date.now(); await page.locator('#send-passcode-button').click();
    const code = await waitForCode(gmailToken, requested);
    for (let i = 0; i < 6; i++) await page.locator(`#otp-field${i}`).fill(code[i]);
    await page.locator('#verify-button').click(); await page.waitForTimeout(4000);
    const candidates = [`https://peatix.com/event/${EVENT_ID}/attendees`, `https://peatix.com/event/${EVENT_ID}/manage`, `https://peatix.com/event/${EVENT_ID}/dashboard`];
    const seen = new Set(); let best = { tickets: [], text: '', url: '' };
    for (const url of candidates) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(2500);
      const links = await page.locator('a').evaluateAll(as => as.map(a => ({ href:a.href, text:a.innerText })).filter(x => /attendee|ticket|order|sales|参加者|申込|チケット/i.test(`${x.href} ${x.text}`)));
      for (const current of [page.url(), ...links.map(x => x.href)]) {
        if (seen.has(current)) continue; seen.add(current); if (current !== page.url()) { await page.goto(current, { waitUntil:'domcontentloaded', timeout:60000 }); await page.waitForTimeout(2000); }
        const text = await page.locator('body').innerText(); const tickets = parseTicketText(text);
        if (tickets.length > best.tickets.length) best = { tickets, text, url: page.url() };
      }
    }
    if (!best.tickets.length) throw new Error(`Peatix 申込数を主催者画面から抽出できません（${best.url || page.url()}）`);
    return { tickets: best.tickets, total: best.tickets.reduce((n, x) => n + x.count, 0), sourceUrl: best.url };
  } finally { await browser.close(); }
}

function truthy(value) { return /^(?:1|true|yes|済|済み|送信済|返信あり|完了|前向き|確定)$/i.test(String(value).trim()); }
export function aggregateMaster(values) {
  const header = (values[0] || []).map(x => String(x).normalize('NFKC'));
  const find = patterns => header.findIndex(h => patterns.some(p => p.test(h)));
  const sentCol = find([/送信/, /配信/]), replyCol = find([/返信/, /返事/]), statusCol = find([/状態/, /ステータス/, /結果/]);
  let sent=0, replies=0, positive=0, confirmed=0, materials=0, speakers=0;
  for (const row of values.slice(1)) {
    const status = String(row[statusCol] || '');
    if (sentCol >= 0 && row[sentCol] && (truthy(row[sentCol]) || String(row[sentCol]).trim())) sent++;
    if (replyCol >= 0 && row[replyCol] && (truthy(row[replyCol]) || String(row[replyCol]).trim())) replies++;
    if (/前向き|検討|参加希望|興味/.test(status)) positive++;
    if (/確定|参加決定/.test(status)) { positive++; confirmed++; }
    if (/資料.{0,3}(?:提出|済)/.test(status)) materials++;
    if (/登壇.{0,3}(?:確定|参加|済)/.test(status)) speakers++;
  }
  return { sent, replies, positive, confirmed, materials, speakers };
}
async function findFiles(driveToken) {
  const q = `'${FOLDER_ID}' in parents and trashed=false`;
  const data = await api(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,webViewLink)&pageSize=100`, driveToken);
  return data.files || [];
}
async function sheetValues(sheetsToken, id) { const data = await api(`https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('A1:ZZ10000')}`, sheetsToken); return data.values || []; }
async function ensureKpiSheet(driveToken, sheetsToken) {
  let file = (await findFiles(driveToken)).find(x => x.name === KPI_SHEET_NAME && x.mimeType === 'application/vnd.google-apps.spreadsheet');
  if (!file) {
    const created = await api('https://sheets.googleapis.com/v4/spreadsheets', sheetsToken, { method:'POST', body:{ properties:{ title:KPI_SHEET_NAME } } });
    file = { id:created.spreadsheetId, name:KPI_SHEET_NAME };
    await api(`https://www.googleapis.com/drive/v3/files/${file.id}?addParents=${FOLDER_ID}&removeParents=root&fields=id,parents`, driveToken, { method:'PATCH', body:{} });
    await api(`https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/${encodeURIComponent('A1') }?valueInputOption=RAW`, sheetsToken, { method:'PUT', body:{ values:[HEADERS] } });
  }
  const permissions = await api(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?fields=permissions(id,emailAddress,role)`, driveToken);
  const kim = permissions.permissions?.find(p => p.emailAddress === 'kim@orgiast.jp');
  if (!kim) await api(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?sendNotificationEmail=false`, driveToken, { method:'POST', body:{ type:'user', role:'writer', emailAddress:'kim@orgiast.jp' } });
  else if (!['owner','writer'].includes(kim.role)) await api(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions/${kim.id}`, driveToken, { method:'PATCH', body:{ role:'writer' } });
  const verified = await api(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions?fields=permissions(emailAddress,role)`, driveToken);
  if (!verified.permissions?.some(p => p.emailAddress === 'kim@orgiast.jp' && ['owner','writer'].includes(p.role))) throw new Error('kim@orgiast.jp writer 権限を読み戻せません');
  return { id:file.id, url:`https://docs.google.com/spreadsheets/d/${file.id}/edit` };
}
async function notifyKim(result, today) {
  const stateDir = path.join(os.homedir(), '.claude', 'eig-kpi-watch'); fs.mkdirSync(stateDir, { recursive:true });
  const stateFile = path.join(stateDir, 'notified.json'); let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  const signature = result.judgment.missing.join('|'); if (state[today] === signature) return null;
  const body = `【飲食×AI】集客KPIが遅れています。\n不足: ${result.judgment.missing.join('、')}\n今日やる追加策: 未送信先へ次の便を配信、未返信先に再送、関係者へつながり依頼をする。\nkim の判断が要る点: 今日優先する対象と配信本数を決めてください。\n返事の例: 「参加者向けを20件追加配信、企業は未返信先に再送して」\nKPIシート: ${result.sheet.url}`;
  const tmp = path.join(stateDir, `.inbox-${process.pid}.txt`); fs.writeFileSync(tmp, body, { mode:0o600 });
  try {
    const inbox = fileURLToPath(new URL('./kim-inbox.mjs', import.meta.url));
    const { stdout } = await exec(process.execPath, [inbox, '--add', '--kind', 'ask', '--source', 'eig-kpi-watch', '--key', `eig-kpi-${today}`, '--body-file', tmp], { timeout:30000, windowsHide:true });
    state[today] = signature; fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', { mode:0o600 }); return stdout.trim();
  } finally { fs.rmSync(tmp, { force:true }); }
}

export async function main() {
  const now = jstParts();
  const [gmailToken, driveToken, sheetsToken] = await Promise.all([token('https://www.googleapis.com/auth/gmail.readonly'), token('https://www.googleapis.com/auth/drive'), token('https://www.googleapis.com/auth/spreadsheets')]);
  const files = await findFiles(driveToken);
  const masters = {};
  for (const name of ['課題提供企業 配信先マスタ','参加者 案内先マスタ']) {
    const file = files.find(x => x.name === name); if (!file) throw new Error(`${name} がフォルダにありません`);
    masters[name] = aggregateMaster(await sheetValues(sheetsToken, file.id));
  }
  const [peatix, gmail] = await Promise.all([collectPeatix(gmailToken), collectGmail(gmailToken)]);
  const company = masters['課題提供企業 配信先マスタ'], participant = masters['参加者 案内先マスタ'];
  const metrics = { registrations:peatix.total, positive:Math.max(company.positive, gmail.positive), confirmed:company.confirmed, materials:company.materials, speakers:participant.speakers };
  const judgment = evaluateKpi(metrics, now.date); const sheet = await ensureKpiSheet(driveToken, sheetsToken);
  const row = [now.timestamp, peatix.total, peatix.tickets.map(x=>`${x.name}:${x.count}`).join(' / '), gmail.total, gmail.positive, gmail.declined, company.sent, company.replies, metrics.positive, participant.sent, participant.replies, judgment.status, judgment.missing.join(' / '), `Peatix:${peatix.sourceUrl}`];
  const appended = await api(`https://sheets.googleapis.com/v4/spreadsheets/${sheet.id}/values/${encodeURIComponent('A:N')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, sheetsToken, { method:'POST', body:{ values:[row] } });
  const result = { sheet, appendedRange:appended.updates?.updatedRange, peatix, gmail, masters, metrics, judgment };
  if (judgment.status === '遅れ') result.kimInbox = await notifyKim(result, now.date);
  console.log(JSON.stringify(result, null, 2)); return result;
}
if (isEntry(import.meta.url)) main().catch(error => { console.error(`eig-kpi-watch: ${error.message}`); process.exitCode = 1; });
