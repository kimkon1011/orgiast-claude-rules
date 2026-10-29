#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { loadLedger } from './claude-account-ledger.mjs';
import { putEnv, main as knowledgeLock } from './knowledge-lock.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { parseEnvText } from './env-kv.mjs';
import { deliverKim } from './notify-kim.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const scope = 'https://www.googleapis.com/auth/admin.directory.user.readonly';
const norm = value => String(value || '').trim().toLowerCase();
const aliases = m => [...new Set([m.email, ...(m.claudeEmails || [])].map(norm).filter(Boolean))];
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const unavailable = reason => ({ status: 'unavailable', reason, data: [] });
const ok = data => ({ status: 'ok', data, count: data.length });
// Never include upstream exception text: it may contain tokens or request URLs.
const errorType = body => {
  const kind = typeof body?.error === 'string' ? body.error : body?.error?.status || body?.error?.type;
  return ['unauthorized_client','access_denied','invalid_grant','invalid_scope','PERMISSION_DENIED','UNAUTHENTICATED','authentication_error','permission_error','not_found_error'].includes(kind) ? kind : 'APIエラー';
};
const safeError = error => ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code) ? error.code
  : ['TimeoutError', 'AbortError'].includes(error?.name) ? error.name : '取得失敗/応答形式不正';
function envFile(file) { try { return parseEnvText(fs.readFileSync(file, 'utf8')); } catch { return {}; } }
function context(deps) {
  const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
  return { home, toolsDir, env: process.env, now: Date.now, fetch: globalThis.fetch, spawn,
    platform: process.platform, serverDir: process.platform === 'win32' ? 'C:\\Users\\uers\\Downloads\\orgiast-keyserve'
      : '/mnt/c/Users/uers/Downloads/orgiast-keyserve', stdout: text => process.stdout.write(text + '\n'),
    getToken: getDriveToken, notify: deliverKim, ...deps };
}
async function request(ctx, url, options = {}) {
  const r = await ctx.fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  if (!r.ok) {
    const e = new Error(); e.httpStatus = r.status;
    try { const body = await r.json(); e.errorType = errorType(body); } catch {}
    throw e;
  }
  return r.json();
}
export async function collectWorkspace(ctx) {
  let tokenHttp, tokenError;
  try {
    const token = await ctx.getToken({ scope, impersonate: 'kim@orgiast.jp',
      ...(ctx.env.GOOGLE_SA_KEY ? { keyPath: ctx.env.GOOGLE_SA_KEY } : {}),
      signal: AbortSignal.timeout(30000), fetchImpl: async (...args) => {
        const r = await ctx.fetch(...args);
        if (!r.ok) { tokenHttp = r.status; try { tokenError = errorType(await r.clone().json()); } catch {} }
        return r;
      } });
    const users = [], seen = new Set(); let page;
    do {
      const url = new URL('https://admin.googleapis.com/admin/directory/v1/users');
      Object.entries({ domain: 'orgiast.jp', maxResults: '500', projection: 'basic', ...(page ? { pageToken: page } : {}) }).forEach(([k,v]) => url.searchParams.set(k,v));
      const data = await request(ctx, url, { headers: { Authorization: `Bearer ${token}` } });
      if (!Array.isArray(data.users) || data.users.some(u => !u.primaryEmail)) throw Error();
      users.push(...data.users.map(u => ({ primaryEmail: norm(u.primaryEmail), suspended: u.suspended === true, archived: u.archived === true })));
      page = data.nextPageToken;
      if (page && seen.has(page)) throw Error();
      seen.add(page);
    } while (page);
    return ok(users);
  } catch (e) {
    return unavailable(`${e.httpStatus || tokenHttp ? `HTTP ${e.httpStatus || tokenHttp} ${e.errorType || tokenError || '認可/APIエラー'}` : safeError(e)}。Admin コンソールの DWD に admin.directory.user.readonly を追加（未認可の場合）`);
  }
}
export async function collectClaude(ctx) {
  const env = { ...envFile(path.join(ctx.home, '.claude/cost-monitor.env')), ...ctx.env };
  const key = env.ANTHROPIC_ADMIN_KEY;
  if (!key) return unavailable('ANTHROPIC_ADMIN_KEY 未設定');
  try {
    const users = [], seen = new Set(); let after;
    do {
      const url = new URL('https://api.anthropic.com/v1/organizations/users?limit=100');
      if (after) url.searchParams.set('after_id', after);
      const data = await request(ctx, url, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      if (!Array.isArray(data.data) || data.data.some(u => !u.email)) throw Error();
      users.push(...data.data.map(u => ({ email: norm(u.email) })));
      if (!data.has_more) break;
      after = data.last_id;
      if (!after || seen.has(after)) throw Error();
      seen.add(after);
    } while (true);
    return { ...ok(users), note: 'この Admin キーの組織だけが対象。Claude Team 全席の取得を保証しない' };
  } catch (e) {
    return unavailable(`${e.httpStatus ? `HTTP ${e.httpStatus} ${e.errorType || 'APIエラー'}` : safeError(e)}。この Admin キーは Console 組織用で Claude Team の席は返らない可能性`);
  }
}
export async function collectFleet(ctx) {
  const env = { ...envFile(path.join(ctx.home, '.claude/fleet-sheet.env')), ...ctx.env };
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) return unavailable('FLEET_SHEET_URL/TOKEN 未設定');
  try {
    const url = new URL(env.FLEET_SHEET_URL); url.searchParams.set('token', env.FLEET_SHEET_TOKEN);
    const payload = await request(ctx, url, { redirect: 'follow' });
    if (!payload.ok || !Array.isArray(payload.rows)) throw Error();
    const rows = payload.rows.filter(r => r.label || r.hostname || r.pcName).map(r => ({
      pc: r.label || r.hostname || r.pcName, email: norm(r.claudeAccount),
      reportedAt: fleetTime(r.reportedAt), keyservePcId: r.keyservePcId || null,
    }));
    const missing = rows.filter(r => !r.email || !r.reportedAt);
    return { ...ok(rows), ...(missing.length ? { status: 'unavailable', reason: `${missing.length} PC の Claude ログイン email または最終報告時刻が未取得` } : {}),
      keyserveIds: rows.every(r => r.keyservePcId) ? { status: 'ok' }
        : { status: 'unavailable', reason: 'fleet 状態一覧に keyserve PC ID の報告なし（PC表示名から推測しない）' } };
  } catch (e) { return unavailable(e.httpStatus ? `HTTP ${e.httpStatus}` : safeError(e)); }
}
export function fleetTime(value) {
  let s = String(value || '').trim();
  if (/^\d{4}[-/]\d\d[-/]\d\d[ T]\d\d:\d\d(?::\d\d)?$/.test(s)) s = s.replaceAll('/', '-').replace(' ', 'T') + '+09:00';
  const n = Date.parse(s); return Number.isFinite(n) ? new Date(n).toISOString() : null;
}
export function analyze({ date, sources, ledger, revoked, now }) {
  const findings = [], retired = [], unknown = [];
  const known = new Set(ledger.members.flatMap(aliases));
  const revokedSet = new Set(revoked.map(norm));
  for (const m of ledger.members) {
    const ws = sources.workspace.data.find(u => norm(u.primaryEmail) === norm(m.email));
    const reasons = [];
    if (m.status === 'retired') reasons.push('台帳退職済');
    if (m.retiredOn && m.retiredOn <= date) reasons.push('退職日到達');
    if (ws?.suspended || ws?.archived) reasons.push('Workspace停止/アーカイブ');
    if (sources.workspace.status === 'ok' && m.status === 'active' && !ws) reasons.push('Workspaceに存在しない');
    if (!reasons.length) continue;
    retired.push({ email: m.email, name: m.name || m.email, reasons });
    const add = (type, detail) => findings.push({ email: m.email, name: m.name || m.email, type, detail });
    const emails = aliases(m);
    for (const u of sources.claude.data) if (emails.includes(norm(u.email))) add('claude-member', u.email);
    for (const pc of sources.fleet.data) {
      const age = now - Date.parse(pc.reportedAt);
      if (emails.includes(norm(pc.email)) && age >= 0 && age <= 7 * 86400e3) add('recent-login', `${pc.pc}: ${pc.email} (${pc.reportedAt})`);
    }
    if (sources.revoked.status === 'ok') for (const pc of m.pcs || []) if (!revokedSet.has(norm(pc))) add('unrevoked-pc', pc);
    if (m.status === 'active') add('ledger-active', reasons.join('・'));
  }
  for (const [source, rows] of [['claude', sources.claude.data], ['fleet', sources.fleet.data]]) {
    for (const row of rows) {
      const email = norm(row.email);
      if (email && (!known.has(email) || !email.endsWith('@orgiast.jp'))) unknown.push({ source, email, pc: row.pc || null,
        reason: !known.has(email) ? '台帳外' : '組織外ドメイン' });
    }
  }
  return { date, sources, retired, findings, unknown, actions: [] };
}
export function formatReport(r) {
  const labels = { 'claude-member': 'Claude組織に残存', 'recent-login': '直近7日ログイン', 'unrevoked-pc': 'PC未失効', 'ledger-active': '台帳がactive' };
  const lines = [`退職者監視 ${r.date}`, `退職判定 ${r.retired.length}人 / 検出 ${r.findings.length}件 / 台帳外・組織外 ${r.unknown.length}件`, '対象 | 検出 | 詳細'];
  for (const f of r.findings) lines.push(`${f.name} (${f.email}) | ${labels[f.type]} | ${f.detail}`);
  for (const u of r.unknown) lines.push(`${u.email} | ${u.reason} | ${u.source}${u.pc ? ` / ${u.pc}` : ''}`);
  for (const [name, s] of Object.entries(r.sources)) {
    if (s.status === 'unavailable') lines.push(`未取得: ${name}（${s.reason}）`);
    if (s.note) lines.push(`${name}: ${s.note}`);
    if (s.keyserveIds?.status === 'unavailable') lines.push(`未取得: fleet keyserve PC ID（${s.keyserveIds.reason}）`);
  }
  if (r.notification?.status === 'unavailable') lines.push(`未取得: 通知送信（${r.notification.reason}）`);
  lines.push(`自動処理: ${r.actions.length ? r.actions.join(' / ') : '変更なし'}`);
  lines.push(r.retired.length || r.unknown.length ? 'kim がやること: 検出を確認し、Claude 組織からの削除・Workspace 停止を承認（本ツールはアカウントを停止しません）。' : 'kim がやること: 未取得があれば取得状態を確認。検出なしでも未取得の源は未判定です。');
  return lines.join('\n');
}
export async function main(argv = process.argv.slice(2), deps = {}) {
  const ctx = context(deps);
  let date = new Date(ctx.now() + 9 * 3600e3).toISOString().slice(0, 10);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--date') date = argv[++i];
    else if (!['--json', '--notify', '--apply-revoke'].includes(argv[i])) throw Error('引数が不正です');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(`${date}T00:00:00Z`).toISOString().slice(0,10) !== date) throw Error('日付が不正です');
  const sources = {};
  let ledger = { members: [] }, revoked = [];
  try { ledger = loadLedger(path.join(ctx.toolsDir, 'claude-account-ledger.json')); sources.ledger = ok(ledger.members); }
  catch (e) { sources.ledger = unavailable(safeError(e)); }
  try {
    revoked = read(path.join(ctx.toolsDir, 'knowledge-revoked-pcs.json'));
    if (!Array.isArray(revoked) || revoked.some(p => typeof p !== 'string' || !p.trim())) throw Error();
    sources.revoked = ok(revoked);
  } catch (e) { revoked = []; sources.revoked = unavailable(safeError(e)); }
  const entries = await Promise.all(['workspace', 'claude', 'fleet'].map(async name => {
    try { return [name, await (deps.collectors?.[name] || { workspace: collectWorkspace, claude: collectClaude, fleet: collectFleet }[name])(ctx)]; }
    catch (e) { return [name, unavailable(safeError(e))]; }
  }));
  Object.assign(sources, Object.fromEntries(entries));
  const r = analyze({ date, sources, ledger, revoked, now: argv.includes('--date') ? Date.parse(`${date}T23:59:59+09:00`) : ctx.now() });
  let failed = false;
  if (argv.includes('--apply-revoke') && r.retired.length) {
    if (sources.ledger.status !== 'ok' || sources.revoked.status !== 'ok') {
      r.actions.push('失効処理保留: 台帳または失効PC正本が未取得'); failed = true;
    } else {
      try {
        // Persist desired state first, then always retry both envs on subsequent runs.
        const ids = [...new Set([...revoked, ...r.findings.filter(f => f.type === 'unrevoked-pc').map(f => f.detail)])];
        save(path.join(ctx.toolsDir, 'knowledge-revoked-pcs.json'), ids);
        for (const m of ledger.members) if (r.retired.some(x => x.email === m.email)) { m.status = 'retired'; m.retiredOn ||= date; }
        save(path.join(ctx.toolsDir, 'claude-account-ledger.json'), ledger);
        r.actions.push('ローカル失効PC台帳・退職者台帳を更新');
        await putEnv(ctx, 'ORGIAST_REVOKED_PCS', JSON.stringify(ids));
        r.actions.push('失効PCを production/preview の環境変数へ反映');
        const code = await (deps.ledgerSync || knowledgeLock)(['ledger-sync', '--apply'], { ...ctx, stdout: () => {}, stderr: () => {} });
        if (code !== 0) throw Error();
        r.actions.push('契約台帳を production/preview へ同期');
      } catch { r.actions.push('失効反映が未完了（部分更新の可能性あり・次回再試行）'); failed = true; }
      r.actions.push('keyserve 再デプロイで有効化。環境変数の変更自体は次回デプロイまで効きません。再デプロイは未実施');
    }
  }
  const logFile = path.join(ctx.home, '.claude/logs/offboarding-watch', `${date}.json`);
  try { save(logFile, r); } catch (e) { sources.log = unavailable(`監視ログ保存失敗: ${safeError(e)}`); failed = true; }
  const message = formatReport(r);
  const needsNotify = r.findings.length || r.unknown.length || Object.values(sources).some(s => s.status === 'unavailable' || s.keyserveIds?.status === 'unavailable');
  if (argv.includes('--notify') && needsNotify) {
    const stateFile = path.join(ctx.home, '.claude/state/offboarding-watch-notified.json');
    const hash = crypto.createHash('sha256').update(message).digest('hex');
    let fd;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fd = fs.openSync(`${stateFile}.lock`, 'wx');
      let state = {}; try { state = read(stateFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (state.date !== date || !state.hashes?.includes(hash)) {
        const result = await ctx.notify(message, { home: ctx.home, fetchImpl: ctx.fetch, plainJa: false, kimActionRequired: true, webhookFallback: false });
        if (result?.delivered !== 'dm') throw Error();
        save(stateFile, { date, hashes: [...(state.date === date ? state.hashes || [] : []), hash] });
        r.notification = { status: 'sent', body: message };
      } else r.notification = { status: 'suppressed' };
    } catch (e) { r.notification = { status: 'unavailable', reason: safeError(e) }; failed = true; }
    finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(`${stateFile}.lock`); } }
  }
  try { save(logFile, r); } catch { /* already reported above */ }
  ctx.stdout(argv.includes('--json') ? JSON.stringify(r, null, 2) : formatReport(r));
  return failed ? 1 : 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch { console.error('offboarding-watch: 引数・日付またはローカル状態を確認してください（秘密情報省略）'); process.exitCode = 1; }
}
