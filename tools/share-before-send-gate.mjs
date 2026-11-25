#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"share-before-send-gate","remedies":[{"kind":"repo-file","ref":"tools/drive-share.mjs"}]};
import fs from 'node:fs';
import path from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { extractFileId, shareLedgerPath } from './lib/drive-share.mjs';
import { extractAddresses } from './internal-recipient-gmail-guard.mjs';
import { readStdin } from './transcript-tail.mjs';
import { isEntry } from './is-entry.mjs';

export const HOOK_MATCHER = 'mcp__claude_ai_Discord[^|]*__(send_dm|send_message|reply_message)|mcp__claude_ai_Gmail(?:_\\d+)?__(send_message|create_draft|reply|forward|update_draft)|Bash|PowerShell';
const TARGET = new RegExp(`^(?:${HOOK_MATCHER})$`);
const SHELL = /^(?:Bash|PowerShell)$/;
export function fileIds(text) {
  return [...new Set((String(text).match(/https?:\/\/(?:docs|drive)\.google\.com\/[^\s<>"'\\)\]。]+/g) ?? []).map(extractFileId).filter(Boolean))];
}
/** Keep each URL: two URLs for the same ID can have different login/Office behavior. */
export function driveUrls(text) {
  return [...new Set(String(text).match(/https?:\/\/(?:docs|drive)\.google\.com(?=[/\s]|$)[^\s<>"'\\)\]。」、]+/gi) ?? [])];
}

const EXTERNAL_MIMES = new Set(['application/pdf', ...['document', 'spreadsheet', 'presentation', 'drawing', 'form'].map(type => `application/vnd.google-apps.${type}`)]);
const loginUrl = url => /(?:^|\.)accounts\.google\.com$/i.test(url.hostname) || /\/ServiceLogin(?:[/?]|$)/i.test(url.pathname);
const googleDownloadUrl = url => url.protocol === 'https:' && !url.username && !url.password && !url.port &&
  /(?:^|\.)(?:google\.com|googleusercontent\.com)$/.test(url.hostname);

/** Strict external delivery check. No ledger, individual shares or anonymous fallback prove permissions. */
export async function checkExternalLinks(text, dependencies = {}) {
  const urls = driveUrls(text);
  if (!urls.length) return { decision: 'pass', checks: [] };
  const { getDriveToken } = await import('./lib/drive-auth.mjs');
  const { gwsFetch } = await import('./lib/gws-proxy.mjs');
  const getToken = dependencies.getToken ?? getDriveToken;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const apiFetch = dependencies.apiFetch ?? ((url, options) => gwsFetch(url, options, { fetchImpl }));
  const checks = [];
  for (const originalUrl of urls) {
    const check = { url: originalUrl };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 15000);
    const signal = controller.signal;
    const json = async (url, token) => {
      const response = await apiFetch(url, { headers: { Authorization: `Bearer ${token}` }, signal });
      if (!response.ok) throw Error(`Drive API HTTP ${response.status}`);
      return response.json();
    };
    try {
      let current = new URL(originalUrl);
      const id = extractFileId(originalUrl);
      if (!id || current.protocol !== 'https:') throw Error('Drive/Docs URL が不正です');
      if ([...current.searchParams].some(([key, value]) => key.toLowerCase() === 'rtpof' && value.toLowerCase() === 'true')) throw Error('rtpof=true の Office 表示URLは送れません');
      const token = await getToken({ impersonate: 'seisaku-team@orgiast.jp', signal, fetchImpl });
      const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`;
      const meta = await json(`${base}?fields=mimeType,owners(emailAddress)&supportsAllDrives=true`, token);
      check.mimeType = meta.mimeType;
      if (!EXTERNAL_MIMES.has(meta.mimeType)) throw Error(`Google形式またはPDFが必要です（${meta.mimeType ?? 'MIME不明'}）`);
      // A native file can still have a URL requesting an Office download.
      if (/(?:\.|\/export\/)(?:pptx?|xlsx?|docx?)(?:$|[/?#])/i.test(current.pathname) ||
          [...current.searchParams].some(([key, value]) => /^(?:format|exportFormat|mimeType)$/i.test(key) && /^(?:pptx?|xlsx?|docx?)$|officedocument|msword|ms-excel|ms-powerpoint/i.test(value))) throw Error('Office形式の書き出しURLは送れません');
      const owner = meta.owners?.map(x => x.emailAddress).find(email => /@orgiast\.jp$/i.test(email));
      const ownerToken = owner && owner !== 'seisaku-team@orgiast.jp' ? await getToken({ impersonate: owner, signal, fetchImpl }) : token;
      const permissions = [];
      let pageToken;
      do {
        const result = await json(`${base}/permissions?${new URLSearchParams({ fields: 'nextPageToken,permissions(type,role,allowFileDiscovery)', supportsAllDrives: 'true', ...(pageToken ? { pageToken } : {}) })}`, ownerToken);
        permissions.push(...(result.permissions ?? [])); pageToken = result.nextPageToken;
      } while (pageToken);
      const publicPermissions = permissions.filter(p => p.type === 'anyone');
      if (publicPermissions.length !== 1 || publicPermissions[0].role !== 'reader' || publicPermissions[0].allowFileDiscovery !== false) throw Error('anyoneWithLink reader（検索非公開）が必要です');
      for (let hop = 0; ; hop++) {
        if (loginUrl(current)) throw Error('ログイン画面への転送を検出しました');
        if (!googleDownloadUrl(current)) throw Error('Google以外または不正な転送先です');
        // Do not forward API headers or cookies, even across redirects.
        const response = await fetchImpl(current.href, { redirect: 'manual', credentials: 'omit', signal });
        const location = response.headers.get('location');
        if (location && loginUrl(new URL(location, current))) throw Error('ログイン画面への転送を検出しました');
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          if (!location || hop >= 5) throw Error('転送回数超過またはLocationなし');
          current = new URL(location, current); continue;
        }
        if (response.status !== 200) throw Error(`未ログイン取得 HTTP ${response.status}`);
        if (response.url && loginUrl(new URL(response.url))) throw Error('ログイン画面を検出しました');
        const type = response.headers.get('content-type') ?? '';
        if (type.startsWith('text/') || type.includes('html') || !type) {
          const html = await response.text();
          // Public viewers include a Sign in link too; only a login page/form or redirect is a failure.
          if (/<title[^>]*>\s*(?:Sign in|Google Accounts|ログイン)/i.test(html) ||
              /<form\b[^>]*action=["'][^"']*(?:accounts\.google\.com|ServiceLogin|signin)/i.test(html) ||
              /(?:location(?:\.href)?\s*=|http-equiv=["']refresh["'])[^\n]{0,300}ServiceLogin/i.test(html)) throw Error('HTTP 200 のログイン画面を検出しました');
        } else await response.body?.cancel();
        check.httpStatus = response.status; check.finalUrl = current.href; check.ok = true; break;
      }
    } catch (error) {
      // Token/network error bodies can contain private information. Return only actionable categories.
      check.ok = false;
      check.reason = controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? '確認がタイムアウトしました' :
        /^(?:Drive API HTTP \d{3}|Google形式|Office形式|rtpof=true|Drive\/Docs URL|anyoneWithLink|ログイン画面|Google以外|転送回数|未ログイン取得|HTTP 200)/.test(error?.message ?? '') ? error.message : 'Drive認証・権限照会または未ログイン取得に失敗しました';
    } finally { clearTimeout(timer); }
    checks.push(check);
  }
  const failures = checks.filter(x => !x.ok);
  return { decision: failures.length ? 'block' : 'pass', checks, ...(failures.length ? { reason: failures.map(x => `${x.url}: ${x.reason}`).join('\n') } : {}) };
}

export async function assertExternalLinks(text, dependencies) {
  const result = await checkExternalLinks(text, dependencies);
  if (result.decision === 'block') throw Error(`[SHARE-BEFORE-SEND] ${result.reason}`);
  return result;
}

export async function externalBodyFileMain(argv, dependencies) {
  try {
    if (argv.length !== 2 || argv[0] !== '--external-body-file' || !argv[1]) throw Error('Usage: --external-body-file <file>');
    const result = await checkExternalLinks(fs.readFileSync(argv[1], 'utf8'), dependencies);
    console.log(JSON.stringify(result));
    return result.decision === 'block' ? 2 : 0;
  } catch { console.error('[SHARE-BEFORE-SEND] 社外本文を検証できませんでした'); return 2; }
}
function tokens(command) {
  return (command.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) ?? []).map(t => t.replace(/(["'])(.*?)\1/g, '$2'));
}
function transcriptIds(raw) {
  const ids = new Set();
  for (const line of raw.split(/\r?\n/).filter(l => l.trim())) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.type !== 'assistant' && row.message?.role !== 'assistant') continue;
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type !== 'tool_use') continue;
      const input = block.input ?? {};
      if (/^mcp__claude_ai_Google_Drive(?:_\d+)?__share_file$/.test(block.name)) {
        for (const value of Object.values(input)) {
          if (typeof value === 'string') {
            const id = extractFileId(value);
            if (id) ids.add(id);
          }
        }
      } else if (SHELL.test(block.name)) {
        const command = String(input.command ?? '');
        if (/\s--dry(?:-run)?(?:\s|$)/.test(command)) continue;
        if (!/\bdrive-share\.mjs\b/.test(command) && !/\b(?:gdoc-create|gdoc-publish|drive-upload)\.mjs\b[\s\S]*\s--share(?:\s|=)/.test(command)) continue;
        for (const id of fileIds(command)) ids.add(id);
        const args = tokens(command);
        for (let i = 0; i < args.length; i++) if (['--id', '--update'].includes(args[i])) {
          const id = extractFileId(args[i + 1]);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

/**
 * checkAnyone(fileId) => Promise<boolean> を並列実行し、
 * { publicIds: string[], publicSet: Set<string>, failures: string[] } を返す。
 * checkFn が throw した fileId は failures に入る。
 */
async function awaitOrThrow(checkFn, fileIds) {
  const results = await Promise.allSettled(fileIds.map(id =>
    checkFn(id).then(isPublic => ({ id, isPublic })).catch(error => { throw { id, error }; })
  ));
  const pub = [], failures = [];
  for (const r of results) {
    if (r.status === 'fulfilled') { if (r.value.isPublic) pub.push(r.value.id); }
    else failures.push(r.reason);
  }
  return { publicIds: pub, publicSet: new Set(pub), failures };
}

export async function judge(input, { ledgerPath = shareLedgerPath(), now = Date.now(), checkAnyone, checkExternal = checkExternalLinks } = {}) {
  if (!input || typeof input !== 'object') throw new Error('hook 入力が不正です');
  if (!TARGET.test(input.tool_name ?? '')) return { decision: 'pass' };
  const args = input.tool_input ?? {};
  let text = JSON.stringify(args);
  if (SHELL.test(input.tool_name)) {
    text = String(args.command ?? '');
    if (!/\b(?:discord-dm|gmail-draft)\.mjs\b/.test(text)) return { decision: 'pass' };
    const argv = tokens(text);
    const externalShell = /\bgmail-draft\.mjs\b/.test(text) && argv.some((arg, i) => /^--(?:to|cc|bcc)(?:=|$)/.test(arg) &&
      (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[i + 1] ?? '').split(/[;,\s]+/).some(e => e.includes('@') && !/@orgiast\.jp$/i.test(e)));
    for (let i = 0; i < argv.length; i++) {
      const match = argv[i].match(/^--(?:body-file|message-file|content-file|text-file)(?:=(.*))?$/);
      if (!match) continue;
      const file = match[1] ?? argv[++i];
      try {
        if (!file) throw new Error('本文ファイル指定が不正です');
        text += '\n' + fs.readFileSync(path.resolve(input.cwd || process.cwd(), file), 'utf8');
      } catch (error) {
        if (externalShell) return { decision: 'block', checks: [], reason: '社外本文ファイルを読み取れないため送信を止めました' };
        throw error;
      }
    }
    if (externalShell) return checkExternal(text);
  } else if (/Gmail/.test(input.tool_name)) {
    const recipients = extractAddresses(args);
    if (recipients.length && recipients.every(e => e === 'kim@orgiast.jp')) return { decision: 'pass' };
    if (recipients.some(e => !/@orgiast\.jp$/i.test(e))) return checkExternal(Object.values(args).filter(x => typeof x === 'string').join('\n'));
  }
  const ids = fileIds(text);
  if (!ids.length) return { decision: 'pass' };
  // Evidence files are read only after finding a target link. I/O/parse failures
  // propagate to the entrypoint's fail-open handler, as with existing guards.
  // 共有記録がまだ無いPCでも判定する（fail-open で素通りさせない）。壊れた行だけ捨てる。
  const ledger = (fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, 'utf8') : '').split(/\r?\n/)
    .filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  const recorded = new Set(ledger.filter(r => {
    const age = now - Date.parse(r.ts);
    return age >= 0 && age <= 30 * 86400000 && Array.isArray(r.emails) && r.emails.length;
  }).map(r => r.fileId));
  const pending = ids.filter(id => !recorded.has(id));
  if (!pending.length) return { decision: 'pass' };
  const shared = input.transcript_path && fs.existsSync(input.transcript_path) ? transcriptIds(fs.readFileSync(input.transcript_path, 'utf8')) : new Set();
  const missing = pending.filter(id => !shared.has(id));
  if (!missing.length) return { decision: 'pass' };
  // Anyone-link check: 既に「リンクを知っている全員が閲覧可」なら毎回の個別共有は不要。
  // 照会失敗は fail-closed（block）だが、理由に「リンク公開かの確認に失敗」を追加する。
  if (checkAnyone) {
    const anyoneChecks = await awaitOrThrow(checkAnyone, missing);
    if (anyoneChecks.failures.length) {
      return { decision: 'block', reason: anyoneChecks.failures.map(({ id, error }) => `リンク公開かの確認に失敗（${String(error?.message ?? error)}）: node tools/drive-share.mjs --id ${id} --to <相手のメール>（社内は編集者・社外はコメント可が既定）。社員宛てなら --to syain@orgiast.jp で全社員に共有できます。共有済みのファイルなら同コマンドで記録されます（既存権限はスキップ）。`).join('\n') };
    }
    const anyoneIds = anyoneChecks.publicIds;
    if (anyoneIds.length) {
      // Cache に anyone 公開判定を追記
      const row = anyoneIds.map(fileId => JSON.stringify({ ts: new Date(now).toISOString(), fileId, emails: ['anyone-with-link'], via: 'anyone-link-check' }) + '\n').join('');
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, row);
    }
    const afterAnyone = missing.filter(id => !anyoneChecks.publicSet.has(id));
    if (!afterAnyone.length) return { decision: 'pass' };
    return { decision: 'block', reason: afterAnyone.map(id => `送信前に相手へ共有してください: node tools/drive-share.mjs --id ${id} --to <相手のメール>（社内は編集者・社外はコメント可が既定）。社員宛てなら --to syain@orgiast.jp で全社員に共有できます。共有済みのファイルなら同コマンドで記録されます（既存権限はスキップ）。`).join('\n') };
  }
  return { decision: 'block', reason: missing.map(id => `送信前に相手へ共有してください: node tools/drive-share.mjs --id ${id} --to <相手のメール>（社内は編集者・社外はコメント可が既定）。社員宛てなら --to syain@orgiast.jp で全社員に共有できます。共有済みのファイルなら同コマンドで記録されます（既存権限はスキップ）。`).join('\n') };
}
/**
 * DWD で所有者を特定して permissions を取得する。API で確認できない場合は
 * 匿名の Drive 閲覧 URL も確認する。全体で8秒、判定不能は fail-closed。
 */
export async function checkAnyoneOnDrive(fileId, dependencies = {}) {
  const { getDriveToken } = await import('./lib/drive-auth.mjs');
  const { gwsFetch } = await import('./lib/gws-proxy.mjs');
  const getToken = dependencies.getToken ?? getDriveToken;
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  // getDriveToken may return a GWS routing marker instead of a Google token.
  const apiFetch = dependencies.apiFetch ?? ((url, options) => gwsFetch(url, options, { fetchImpl }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 8000);
  const attempts = [];
  const failure = error => {
    const status = error?.status ?? /\bHTTP (\d{3})\b/.exec(error?.message ?? '')?.[1];
    return status ? `HTTP ${status}` : controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'error';
  };
  const tokenFor = (impersonate, label) => getToken({
    impersonate, signal: controller.signal,
    fetchImpl: async (...args) => {
      const res = await fetchImpl(...args);
      if (!res.ok) attempts.push(`${label}=HTTP ${res.status}`);
      return res;
    },
  });
  const request = async (label, url, options = {}) => {
    try {
      const fetcher = options.headers ? apiFetch : fetchImpl;
      const res = await fetcher(url, { ...options, signal: controller.signal });
      attempts.push(`${label}=HTTP ${res.status}`);
      return res;
    } catch (error) {
      attempts.push(`${label}=${failure(error)}`);
      return null;
    }
  };
  try {
    try {
      const readerToken = await tokenFor('seisaku-team@orgiast.jp', 'reader-token');
      const metaRes = await request('dwd-files.get', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?fields=owners(emailAddress)&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${readerToken}` } });
      if (metaRes?.ok) {
        const meta = await metaRes.json();
        const owner = meta.owners?.map(o => o.emailAddress).find(email => /@orgiast\.jp$/i.test(email));
        if (owner) {
          const ownerToken = owner === 'seisaku-team@orgiast.jp' ? readerToken : await tokenFor(owner, 'owner-token');
          const permissionRes = await request('owner-permissions.list', `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions?fields=permissions(type,role)&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${ownerToken}` } });
          if (permissionRes?.ok) {
            const data = await permissionRes.json();
            return (data.permissions ?? []).some(p => p.type === 'anyone');
          }
        } else attempts.push('owner=external-or-missing');
      }
    } catch (error) {
      attempts.push(`dwd=${failure(error)}`);
    }

    for (const [label, url] of [
      ['anonymous-file', `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/view`],
      ['anonymous-folder', `https://drive.google.com/drive/folders/${encodeURIComponent(fileId)}`],
    ]) {
      const res = await request(label, url, { redirect: 'manual' });
      const location = res?.headers.get('location');
      const loginRedirect = location && /(?:^|\.)accounts\.google\.com$/i.test(new URL(location, url).hostname);
      if (res?.status === 200 && !loginRedirect) return true;
    }
    throw new Error(attempts.join(', '));
  } catch (error) {
    if (error?.message === attempts.join(', ')) throw error;
    throw new Error(attempts.length ? attempts.join(', ') : `all-methods=${error?.name === 'AbortError' ? 'timeout' : 'error'}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const result = await judge(JSON.parse(raw), { checkAnyone: checkAnyoneOnDrive });
    if (result.decision === 'block') {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
      if (result.checks) process.exitCode = 2;
    }
  } catch (error) { console.error(`[SHARE-BEFORE-SEND] 判定をスキップ: ${String(error.message).replace(/[\r\n]+/g, ' ')}`); }
}
if (isEntry(import.meta.url)) {
  if (process.argv.length > 2) process.exitCode = await externalBodyFileMain(process.argv.slice(2));
  else await main();
}
