#!/usr/bin/env node
/**
 * gmail-draft.mjs — 共有アカウントの外部宛 Gmail 下書きを作る常設経路。
 * なぜ要るか: アドホックなコードや手作業をなくし、内部宛はチャット表示に戻す。
 * 方式: DWD + 自己署名 JWT（Node 18+ / 標準 crypto と fetch、依存なし）。
 *       内部宛は認証前に停止。送信機能は持たない。
 * 使い方:
 *   node tools/gmail-draft.mjs --check [--user <addr>] [--json]
 *   node tools/gmail-draft.mjs --delete <draftId> [--user <addr>] [--json]
 *   node tools/gmail-draft.mjs --to <addr> [--cc <addr>] --subject <件名>
 *     (--body <本文> | --body-file <path>) [--user <addr>] [--dry-run] [--json]
 *   宛先は裸のメールアドレス（複数はカンマ区切り、またはオプションを反復）。
 *   --check はトークン取得だけ。--dry-run は認証も API 呼び出しもしない。
 * 終了コード: 0 成功 / 3 内部宛 / 2 設定エラー / 1 その他。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';
import { loadLedger, isInternal } from './internal-recipient-gmail-guard.mjs';

export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const DEFAULT_USER = 'seisaku-team@orgiast.jp';
const DEFAULT_KEY = process.env.GOOGLE_SA_KEY ??
  'C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json';
const SCOPES = ['gmail.readonly', 'gmail.compose', 'gmail.send'].map(s => `https://www.googleapis.com/auth/${s}`);
const b64url = value => Buffer.from(value).toString('base64url');
const configError = () => Object.assign(new Error('設定を確認してください（引数・入力ファイル・SA キー）。'), { errorKind: 'configuration_error' });

function addresses(value, required = false) {
  const list = (Array.isArray(value) ? value : [value ?? '']).flatMap(v => {
    if (typeof v !== 'string' || /[\r\n]/u.test(v)) throw configError();
    return v.split(',').map(s => s.trim());
  });
  if (!required && list.length === 1 && !list[0]) return [];
  if (!list.length || list.some(s => !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/iu.test(s))) throw configError();
  return list;
}

export function buildRawMessage({ from, to, cc, subject, body }) {
  const sender = addresses(from, true);
  if (sender.length !== 1 || typeof subject !== 'string' || /[\r\n]/u.test(subject) || typeof body !== 'string') throw configError();
  // encoded-word は UTF-8 文字の途中で切らず、RFC の 75 文字制限内で折り返す。
  const chunks = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  chunks.push(chunk);
  const encodedSubject = chunks.map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
  const copy = addresses(cc);
  const headers = [
    `From: ${sender[0]}`, `To: ${addresses(to, true).join(', ')}`,
    ...(copy.length ? [`Cc: ${copy.join(', ')}`] : []),
    `Subject: ${encodedSubject}`, 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = Buffer.from(body.replace(/\r\n|\r|\n/gu, '\r\n')).toString('base64');
  return b64url(`${headers.join('\r\n')}\r\n\r\n${(encodedBody.match(/.{1,76}/gu) ?? []).join('\r\n')}\r\n`);
}

export function renderChatDisplay({ to, cc, subject = '', body = '' }) {
  const copy = addresses(cc);
  return `宛先：${addresses(to, true).join(', ')}${copy.length ? `\nCc：${copy.join(', ')}` : ''}\n用件：${subject}\n本文：\n${body}`;
}

export function guardRecipients(input, ledger) {
  const internal = [...new Set([...addresses(input.to, true), ...addresses(input.cc)].map(s => s.toLowerCase()))]
    .filter(addr => isInternal(addr, ledger));
  return internal.length ? { blocked: true, internal, chatDisplay: renderChatDisplay(input) } : { blocked: false, internal: [] };
}

export function classifyTokenError(json) {
  return ['invalid_client', 'invalid_grant', 'unauthorized_client'].includes(json?.error) ? 'scope_not_delegated' : 'error';
}

function safeFailure(error) {
  const errorKind = error?.errorKind === 'configuration_error' ? 'configuration_error'
    : error?.tokenError ? classifyTokenError(error.detail)
      : ['scope_not_delegated', 'forbidden_no_access', 'unauthorized'].includes(error?.errorKind) ? error.errorKind : 'error';
  const messages = {
    configuration_error: '設定を確認してください（引数・入力ファイル・SA キー）。',
    scope_not_delegated: 'DWD にこのスコープが未登録。Admin Console で SA client_id に追加が要る',
    forbidden_no_access: 'Gmail API へのアクセス権限がありません。',
    unauthorized: 'Gmail API の認証に失敗しました。',
    error: '処理に失敗しました（認証・通信・API 応答を確認してください）。',
  };
  return { errorKind, error: messages[errorKind] };
}

function readKey(keyPath) {
  try {
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (typeof key.client_email !== 'string' || !key.client_email || typeof key.private_key !== 'string') throw configError();
    const privateKey = crypto.createPrivateKey(key.private_key);
    if (privateKey.asymmetricKeyType !== 'rsa') throw configError();
    return { client_email: key.client_email, privateKey };
  } catch { throw configError(); }
}

async function mintDwdToken({ user, keyPath = DEFAULT_KEY, scope, fetchImpl = globalThis.fetch }) {
  const key = readKey(keyPath);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: key.client_email, sub: user, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }))}`;
  try {
    const assertion = `${unsigned}.${crypto.sign('RSA-SHA256', Buffer.from(unsigned), key.privateKey).toString('base64url')}`;
    const res = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || typeof json?.access_token !== 'string' || !json.access_token) {
      throw Object.assign(new Error('トークン取得失敗'), { errorKind: classifyTokenError(json) });
    }
    return json.access_token;
  } catch (error) { throw Object.assign(new Error(safeFailure(error).error), safeFailure(error)); }
}

export async function probeScopes({ user = DEFAULT_USER, keyPath = DEFAULT_KEY, scopes = SCOPES, mintToken = mintDwdToken }) {
  const results = [];
  for (const scope of scopes) {
    try {
      await mintToken({ user, keyPath, scope });
      results.push({ scope, ok: true });
    } catch (error) { results.push({ scope, ok: false, ...safeFailure(error) }); }
  }
  return results;
}

export async function createDraft({ user = DEFAULT_USER, raw, fetchImpl = globalThis.fetch, getToken }) {
  try {
    const token = await (getToken ?? (args => mintDwdToken({ ...args, fetchImpl })))({ user, scope: GMAIL_COMPOSE_SCOPE });
    const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw } }),
    });
    if (!res.ok) throw Object.assign(new Error('Gmail API 失敗'), {
      errorKind: res.status === 403 ? 'forbidden_no_access' : res.status === 401 ? 'unauthorized' : 'error',
    });
    const json = await res.json();
    if (typeof json?.id !== 'string' || !json.id) throw new Error('下書き ID がありません');
    return { id: json.id, messageId: json.message?.id, threadId: json.message?.threadId };
  } catch (error) { throw Object.assign(new Error(safeFailure(error).error), safeFailure(error)); }
}

export async function deleteDraft({ user = DEFAULT_USER, id, fetchImpl = globalThis.fetch, getToken }) {
  try {
    // ID を単一の URL パス要素に限定し、別エンドポイントへの遷移を防ぐ。
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id)) throw configError();
    const token = await (getToken ?? (args => mintDwdToken({ ...args, fetchImpl })))({ user, scope: GMAIL_COMPOSE_SCOPE });
    const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}`, {
      method: 'DELETE', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 204) return { deleted: true, id };
    if (res.status === 404) return { deleted: false, id, errorKind: 'not_found' };
    throw Object.assign(new Error('Gmail API 失敗'), {
      errorKind: res.status === 403 ? 'forbidden_no_access' : res.status === 401 ? 'unauthorized' : 'error',
    });
  } catch (error) { throw Object.assign(new Error(safeFailure(error).error), safeFailure(error)); }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (['--check', '--json', '--dry-run'].includes(name)) { args[name.slice(2)] = true; continue; }
    if (!['--to', '--cc', '--subject', '--body', '--body-file', '--user', '--delete'].includes(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw configError();
    const field = name.slice(2);
    const value = argv[++i];
    if (field === 'to' || field === 'cc') (args[field] ??= []).push(value);
    else { if (Object.hasOwn(args, field)) throw configError(); args[field] = value; }
  }
  return args;
}

/** deps: stdout(text), loadLedger(), readFile(path), mintToken(options), getToken(options), fetchImpl. */
export async function runCli({ argv = process.argv.slice(2), deps = {} } = {}) {
  const stdout = deps.stdout ?? (text => console.log(text));
  const jsonMode = argv.includes('--json');
  let user = DEFAULT_USER;
  let action = argv.includes('--delete') ? 'delete' : argv.includes('--check') ? 'check' : argv.includes('--dry-run') ? 'dry-run' : 'create-draft';
  let deletionId;
  const emit = (report, human) => stdout(jsonMode ? JSON.stringify({ action, user, ...report }) : human);
  try {
    const args = parseArgs(argv);
    deletionId = args.delete;
    const senders = addresses(args.user ?? DEFAULT_USER, true);
    if (senders.length !== 1) throw configError();
    user = senders[0];
    const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
    const mintToken = deps.mintToken ?? (options => mintDwdToken({ ...options, fetchImpl }));
    if (Object.hasOwn(args, 'delete')) {
      if (['check', 'to', 'cc', 'subject', 'body', 'body-file', 'dry-run'].some(k => Object.hasOwn(args, k))) throw configError();
      const result = await deleteDraft({ user, id: args.delete, fetchImpl,
        getToken: deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY })),
      });
      emit({ ok: true, ...result }, result.deleted
        ? `下書きを削除しました: ${result.id} (${user})`
        : `下書きは既にありません: ${result.id} (${user})`);
      return 0;
    }
    if (args.check) {
      if (['to', 'cc', 'subject', 'body', 'body-file', 'dry-run'].some(k => Object.hasOwn(args, k))) throw configError();
      const results = await probeScopes({ user, keyPath: DEFAULT_KEY, scopes: SCOPES, mintToken });
      const failed = results.filter(r => !r.ok);
      emit({ ok: !failed.length, results, ...(failed.length ? { errorKind: failed[0].errorKind } : {}) },
        results.map(r => `${r.ok ? 'OK' : 'NG'} ${r.scope}${r.ok ? '' : ` ${r.errorKind}: ${r.error}`}`).join('\n'));
      return failed.some(r => r.errorKind === 'configuration_error') ? 2 : failed.length ? 1 : 0;
    }
    if (!Object.hasOwn(args, 'subject') || Object.hasOwn(args, 'body') === Object.hasOwn(args, 'body-file')) throw configError();
    let body = args.body;
    if (args['body-file'] !== undefined) {
      try { body = (deps.readFile ?? (p => fs.readFileSync(p, 'utf8')))(args['body-file']); }
      catch { throw configError(); }
    }
    const input = { from: user, to: args.to, cc: args.cc, subject: args.subject, body };
    const guard = guardRecipients(input, (deps.loadLedger ?? loadLedger)());
    if (guard.blocked) {
      action = 'chat-display';
      emit({ ok: false, errorKind: 'internal_recipient', internal: guard.internal, chatDisplay: guard.chatDisplay }, guard.chatDisplay);
      return 3;
    }
    const raw = buildRawMessage(input);
    if (args['dry-run']) {
      const headers = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
      emit({ ok: true, raw, headers }, `${headers}\n\nraw: ${raw}`);
      return 0;
    }
    const result = await createDraft({ user, raw, fetchImpl,
      getToken: deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY })),
    });
    emit({ ok: true, ...result }, `下書きを作成しました: ${result.id} (${user})`);
    return 0;
  } catch (error) {
    const failure = safeFailure(error);
    emit({ ok: false, ...(action === 'delete' ? { deleted: false, id: deletionId } : {}), ...failure }, failure.error);
    return failure.errorKind === 'configuration_error' ? 2 : 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli();
