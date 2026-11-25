#!/usr/bin/env node
import { ensureKimEditor } from './lib/kim-editor.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getDriveToken, driveApi } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
export const HEADERS = ['会社名', '宛先', 'CC', '件名', '本文全文', '送信', '送信日時', '結果'];
export const ACCOUNT = 'seisaku-team@orgiast.jp';
const template = fileURLToPath(new URL('./mail-bulk-approve-gas/', import.meta.url));
const logic = vm.runInNewContext(fs.readFileSync(path.join(template, 'Logic.js'), 'utf8') + '\n({approvalMail, approvalRows})');
export function createSpreadsheetPayload(items, title, now = new Date()) {
  if (!Array.isArray(items) || !items.length) throw new Error('送信先を1件以上指定してください');
  const rows = [HEADERS, ...items.map(item => {
    for (const key of ['company', 'to', 'subject', 'body']) if (typeof item[key] !== 'string' || !item[key].trim()) throw new Error(`入力不足: ${key}`);
    const row = [item.company, item.to, item.cc ?? '', item.subject, item.body, false, '', ''];
    if (row.some(v => typeof v === 'string' && v.length > 50000)) throw new Error('1セル50000文字を超えています');
    logic.approvalMail([...row.slice(0, 5), true, '', '']);
    return row;
  })];
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now).replaceAll('-', '');
  return { title: `${title ?? `一括送信承認_${items[0].subject}`}_${date}`, rows };
}
// Compatibility export; the eligibility logic is the actual GAS source, not a separate mock.
export function processBulkMailApprovals(rows, send, now = new Date()) {
  return rows.map((r, i) => {
    const row = [...r];
    if (!i && row[0] === HEADERS[0]) return row;
    const mail = logic.approvalMail(row);
    if (mail) { row[7] = '送信中（再送禁止）'; try { const sent = send(mail); if (!sent?.messageId) throw new Error('messageId missing'); row[6] = now.toISOString(); row[7] = sent.messageId; } catch { row[7] = '要確認（自動再送しません）'; } }
    return row;
  });
}
export function generateGasScript() { return ['Logic.js', 'Send.js', 'Setup.js'].map(f => fs.readFileSync(path.join(template, f), 'utf8')).join('\n'); }

export function resolveClaspEntry(env = process.env) {
  const candidates = [env.ORGIAST_CLASP_JS,
    env.APPDATA && path.join(env.APPDATA, 'npm/node_modules/@google/clasp/build/src/index.js'),
    path.join(path.dirname(process.execPath), 'node_modules/@google/clasp/build/src/index.js'),
    ...String(env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'node_modules/@google/clasp/build/src/index.js'))];
  return candidates.find(file => file && fs.existsSync(file));
}
async function claspToken(authFile, fetchImpl = fetch) {
  const saved = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  const t = saved.tokens?.default ?? saved.token ?? saved;
  const client = t.client_id ?? saved.oauth2ClientSettings?.clientId;
  const secret = t.client_secret ?? saved.oauth2ClientSettings?.clientSecret;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: client, client_secret: secret, refresh_token: t.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(25000) });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('既存 clasp 認証の更新に失敗しました（秘密値は表示しません）');
  return data.access_token;
}
export async function createBulkApproval(items, { projectDir, authFile = path.join(os.homedir(), '.clasprc.json'), getClaspToken = claspToken, getToken = getDriveToken, api = driveApi, run = execFileSync, now = new Date() } = {}) {
  const payload = createSpreadsheetPayload(items, undefined, now);
  if (!projectDir || fs.existsSync(path.join(projectDir, '.clasp.json'))) throw new Error('新しい --project-dir を指定してください（既存projectは上書きしません）');
  const oauth = await getClaspToken(authFile);
  const json = async (token, url, method = 'GET', body) => (await api(token, url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(25000) })).json();
  const identity = await json(oauth, 'https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)');
  if (identity.user?.emailAddress !== ACCOUNT) throw new Error('既存 clasp 認証が seisaku-team@orgiast.jp ではありません');
  const token = await getToken({ impersonate: ACCOUNT, scope: 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets' });
  const cell = v => ({ userEnteredValue: typeof v === 'boolean' ? { boolValue: v } : { stringValue: v } });
  const sheet = await json(token, 'https://sheets.googleapis.com/v4/spreadsheets', 'POST', { properties: { title: payload.title }, sheets: [{ properties: { sheetId: 0, title: '送信承認', gridProperties: { frozenRowCount: 1, rowCount: Math.max(100, payload.rows.length), columnCount: 8 } }, data: [{ rowData: payload.rows.map(r => ({ values: r.map(cell) })) }] }] });
  const id = sheet.spreadsheetId;
  if (!id) throw new Error('シートIDを取得できません');
  await ensureKimEditor(id, { actingUser: ACCOUNT, token, api, created: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'approval-sheet.json'), JSON.stringify({ spreadsheetId: id, title: payload.title }, null, 2) + '\n');
  await json(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}:batchUpdate`, 'POST', { requests: [{ setDataValidation: { range: { sheetId: 0, startRowIndex: 1, endRowIndex: payload.rows.length, startColumnIndex: 5, endColumnIndex: 6 }, rule: { condition: { type: 'BOOLEAN' }, strict: true, showCustomUi: true } } }] });
  const readback = await json(token, `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent('送信承認!A1:H' + payload.rows.length)}?valueRenderOption=UNFORMATTED_VALUE`);
  if (JSON.stringify(readback.values?.map(r => Array.from({length: 8}, (_, i) => r[i] ?? ''))) !== JSON.stringify(payload.rows)) throw new Error('シート本文の読み戻し不一致');
  const project = await json(oauth, 'https://script.googleapis.com/v1/projects', 'POST', { title: payload.title, parentId: id });
  if (!project.scriptId) throw new Error('GAS project ID missing');
  fs.cpSync(template, projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.clasp.json'), JSON.stringify({ scriptId: project.scriptId, rootDir: '.' }, null, 2) + '\n');
  // Use the installed clasp JS entry on Windows; do not interpolate paths into cmd.exe.
  const clasp = resolveClaspEntry();
  if (process.platform === 'win32' && !clasp) throw new Error('インストール済み clasp が見つかりません');
  run(clasp ? process.execPath : 'clasp', [...(clasp ? [clasp] : []), '--auth', authFile, '--project', path.join(projectDir, '.clasp.json'), 'push', '--force'], { cwd: projectDir, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: 'pipe' });
  const live = await json(oauth, `https://script.googleapis.com/v1/projects/${project.scriptId}/content`);
  for (const f of ['Logic', 'Send', 'Setup']) if (live.files?.find(x => x.name === f)?.source.replace(/\r\n/g, '\n').trim() !== fs.readFileSync(path.join(projectDir, `${f}.js`), 'utf8').replace(/\r\n/g, '\n').trim()) throw new Error(`GAS読み戻し不一致: ${f}`);
  const result = { url: `https://docs.google.com/spreadsheets/d/${id}/edit?authuser=kim@orgiast.jp`, setupUrl: `https://script.google.com/d/${project.scriptId}/edit?authuser=${ACCOUNT}`, status: 'setup-required', setup: 'seisaku-team@orgiast.jp で Setup.js の setupOnce を1回実行・許可。完了ログ: command queue installed; mail approval ready' };
  fs.writeFileSync(path.join(projectDir, 'approval-sheet.json'), JSON.stringify({ ...result, spreadsheetId: id }, null, 2) + '\n');
  return result;
}
if (isEntry(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const value = key => args[args.indexOf(key) + 1];
    if (!args.includes('--input') || !args.includes('--project-dir')) throw new Error('Usage: node tools/mail-bulk-approve.mjs --input <JSON> --project-dir <新規clasp管理dir> [--clasp-auth <既存認証>]');
    const result = await createBulkApproval(JSON.parse(fs.readFileSync(value('--input'), 'utf8')), { projectDir: path.resolve(value('--project-dir')), ...(args.includes('--clasp-auth') ? { authFile: value('--clasp-auth') } : {}) });
    console.log(JSON.stringify(result, null, 2));
  } catch { console.error('一括承認シート作成に失敗しました。入力・共有アカウントの既存clasp認証・API権限・project-dir内の保存状態を確認してください。'); process.exitCode = 1; }
}
