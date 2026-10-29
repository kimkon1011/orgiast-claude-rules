#!/usr/bin/env node
import { tryRelayToken } from './lib/seisaku-gmail-token.mjs';
/**
 * gmail-draft.mjs — 共有アカウントの外部宛 Gmail 下書きを作る常設経路。
 * なぜ要るか: アドホックなコードや手作業をなくし、内部宛はチャット表示に戻す。
 * 方式: DWD + 自己署名 JWT（Node 18+ / 標準 crypto と fetch、依存なし）。
 *       作成時の内部宛は認証前に停止。送信時は下書きの宛先を再検査。
 * 使い方:
 *   node tools/gmail-draft.mjs --check [--user <addr>] [--json]
 *   node tools/gmail-draft.mjs --send <draftId> [--user <addr>] [--ack-consistency <理由>] [--json]
 *   node tools/gmail-draft.mjs --forward <messageId> --to <addr> [--cc <addr>] [--body <前置き> | --body-file <path>] [--user <addr>] [--dry-run] [--json]
 *   返信作成: --thread-id <threadId>（返信先ヘッダ・省略時の件名を自動取得）
 *   node tools/gmail-draft.mjs --delete <draftId> [--user <addr>] [--json]
 *   node tools/gmail-draft.mjs --to <addr> [--cc <addr>] --subject <件名>
 *     (--body <本文> | --body-file <path>) [--attach <path>]... [--thread-id <threadId>] [--user <addr>] [--dry-run] [--json]
 *   宛先は裸のメールアドレス（複数はカンマ区切り、またはオプションを反復）。
 *   --check はトークン取得だけ。--send はスレッド全体との整合性を自動検査する。
 * 終了コード: 0 成功 / 3 内部宛 / 2 設定エラー / 1 その他。
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { loadLedger, isInternal, extractAddresses } from './internal-recipient-gmail-guard.mjs';
import { bodyHash, checkConsistency, statePath, mimeText, render as renderConsistency } from './mail-consistency-check.mjs';

export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';
export const DEFAULT_USER = 'seisaku-team@orgiast.jp';
// 既定パスはハードコードしない（旧既定値はディレクトリ名の打ち間違いで鍵を見失っていた。2026-10-23 実測）。
const DEFAULT_KEY = process.env.GOOGLE_SA_KEY ?? defaultDriveKeyPath();
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

const MIME_TYPES = { '.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.csv':'text/csv','.txt':'text/plain','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
function encodedWord(value) { return `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`; }
export function buildRawMessage({ from, to, cc, subject, body, inReplyTo, references, attachments = [], extraHeaders = [] }) {
  if (inReplyTo !== undefined && (typeof inReplyTo !== 'string' || !/^<[^<>\s]+@[^<>\s]+>$/u.test(inReplyTo))) throw configError();
  if (references !== undefined && (typeof references !== 'string' || /[\r\n]/u.test(references))) throw configError();
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
    `Subject: ${encodedSubject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    ...extraHeaders.map(([name, value]) => {
      if (!/^X-[A-Za-z0-9-]+$/u.test(name) || typeof value !== 'string' || /[\r\n]/u.test(value)) throw configError();
      return `${name}: ${value}`;
    }), 'MIME-Version: 1.0',
  ];
  const encodedBody = Buffer.from(body.replace(/\r\n|\r|\n/gu, '\r\n')).toString('base64');
  if (!attachments.length) return b64url(`${[...headers, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64'].join('\r\n')}\r\n\r\n${(encodedBody.match(/.{1,76}/gu) ?? []).join('\r\n')}\r\n`);
  const boundary = `orgiast_${crypto.randomBytes(12).toString('hex')}`;
  const parts = [`--${boundary}`, 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', (encodedBody.match(/.{1,76}/gu) ?? []).join('\r\n')];
  for (const attachment of attachments) {
    const name = attachment.name; const type = attachment.type ?? MIME_TYPES[(name.match(/\.[^.]+$/u)?.[0] ?? '').toLowerCase()] ?? 'application/octet-stream';
    const data = Buffer.from(attachment.data).toString('base64').match(/.{1,76}/gu)?.join('\r\n') ?? '';
    parts.push(`--${boundary}`, `Content-Type: ${type}; name="${encodedWord(name)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${encodedWord(name)}"`, '', data);
  }
  parts.push(`--${boundary}--`, '');
  return b64url(`${[...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`].join('\r\n')}\r\n\r\n${parts.join('\r\n')}`);
}

function decodeHeader(value = '') {
  return value.replace(/=\?UTF-8\?B\?([^?]+)\?=/giu, (_m, data) => Buffer.from(data, 'base64').toString('utf8'));
}
function parseHeaders(text) {
  const unfolded = text.replace(/\r?\n[ \t]+/gu, ' ');
  const map = new Map();
  for (const line of unfolded.split(/\r?\n/u)) {
    const match = line.match(/^([^:]+):\s*(.*)$/u);
    if (match) map.set(match[1].toLowerCase(), match[2]);
  }
  return map;
}
function decodePart(body, encoding = '') {
  if (/base64/iu.test(encoding)) return Buffer.from(body.replace(/\s/gu, ''), 'base64').toString('utf8');
  if (/quoted-printable/iu.test(encoding)) return body.replace(/=\r?\n/gu, '').replace(/=([0-9A-F]{2})/giu, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return body;
}
function findPlainText(source) {
  const split = source.search(/\r?\n\r?\n/u);
  if (split < 0) return '';
  const separator = source.slice(split).match(/^\r?\n\r?\n/u)?.[0] ?? '\r\n\r\n';
  const headers = parseHeaders(source.slice(0, split));
  const body = source.slice(split + separator.length);
  const contentType = headers.get('content-type') ?? 'text/plain';
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/iu)?.slice(1).find(Boolean);
  if (/^multipart\//iu.test(contentType) && boundary) {
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith('--')) break;
      const text = findPlainText(part.replace(/^\r?\n/u, ''));
      if (text) return text;
    }
    return '';
  }
  return /^text\/plain/iu.test(contentType) ? decodePart(body, headers.get('content-transfer-encoding')) : '';
}
export function buildForwardRaw({ from, to, cc, preface = '', messageId, originalRaw }) {
  if (typeof messageId !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(messageId)) throw configError();
  const original = Buffer.from(originalRaw, 'base64url');
  const source = original.toString('utf8');
  const split = source.search(/\r?\n\r?\n/u);
  const headers = parseHeaders(split < 0 ? source : source.slice(0, split));
  const subject = decodeHeader(headers.get('subject') ?? '(件名なし)');
  const forwardedSubject = /^Fwd:/iu.test(subject) ? subject : `Fwd: ${subject}`;
  const fields = [['From', 'from'], ['Date', 'date'], ['Subject', 'subject'], ['To', 'to'], ['Cc', 'cc']]
    .flatMap(([label, key]) => headers.has(key) ? [`${label}: ${decodeHeader(headers.get(key))}`] : []);
  const body = `${preface ? `${preface.replace(/\r\n|\r|\n/gu, '\n')}\n\n` : ''}---------- Forwarded message ---------\n${fields.join('\n')}\n\n${findPlainText(source)}`;
  const safeName = subject.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '_').slice(0, 120) || 'forwarded-message';
  const raw = buildRawMessage({ from, to, cc, subject: forwardedSubject, body,
    attachments: [{ name: `${safeName}.eml`, type: 'message/rfc822', data: original }],
    extraHeaders: [['X-Orgiast-Forward', messageId]],
  });
  if (Buffer.from(raw, 'base64url').byteLength > 25 * 1024 * 1024) throw Object.assign(new Error('転送メールが25MBを超えています。'), { errorKind: 'too_large' });
  return raw;
}

async function fetchMessageRaw({ user, id, fetchImpl, getToken }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id)) throw configError();
  const token = await getToken({ user, scope: SCOPES[0] });
  const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=raw`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('Gmail API 失敗');
  const json = await res.json();
  if (typeof json.raw !== 'string' || !json.raw) throw new Error('元メールを取得できません');
  return json.raw;
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
  if (error?.errorKind === 'seisaku_relay') return { errorKind: 'seisaku_relay', error: error.message };
  const errorKind = error?.errorKind === 'configuration_error' ? 'configuration_error'
    : error?.errorKind === 'too_large' ? 'too_large'
    : error?.tokenError ? classifyTokenError(error.detail)
      : ['scope_not_delegated', 'forbidden_no_access', 'unauthorized'].includes(error?.errorKind) ? error.errorKind : 'error';
  const messages = {
    configuration_error: '設定を確認してください（引数・入力ファイル・SA キー）。',
    scope_not_delegated: 'DWD にこのスコープが未登録。Admin Console で SA client_id に追加が要る',
    forbidden_no_access: 'Gmail API へのアクセス権限がありません。',
    unauthorized: 'Gmail API の認証に失敗しました。',
    too_large: '転送メールが25MBを超えています。',
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

export async function mintDwdToken({ user, keyPath = DEFAULT_KEY, scope, fetchImpl = globalThis.fetch, statePath }) {
  const relay = await tryRelayToken({ keyPath, impersonate: user, scope, fetchImpl, statePath });
  if (relay !== null) return relay;
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

async function getReplyHeaders({ user, threadId, fetchImpl, getToken }) {
  const token = await getToken({ user, scope: SCOPES[0] });
  const query = new URLSearchParams({ format: 'metadata' });
  for (const name of ['Message-ID', 'References', 'Subject']) query.append('metadataHeaders', name);
  const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?${query}`, {
    method: 'GET', signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw Object.assign(new Error('Gmail API 失敗'), {
    errorKind: res.status === 403 ? 'forbidden_no_access' : res.status === 401 ? 'unauthorized' : 'error',
  });
  const thread = await res.json();
  const parent = thread.messages?.findLast(message => !message.labelIds?.includes('DRAFT'));
  const headers = parent?.payload?.headers;
  if (!Array.isArray(headers)) throw new Error('返信先がありません');
  const header = name => headers.find(h => String(h.name).toLowerCase() === name)?.value;
  const inReplyTo = header('message-id');
  if (!inReplyTo) throw new Error('返信先の Message-ID がありません');
  const references = header('references');
  return { inReplyTo, references: references ? `${references} ${inReplyTo}` : inReplyTo, subject: header('subject') ?? '' };
}

export async function createDraft({ user = DEFAULT_USER, raw, threadId, fetchImpl = globalThis.fetch, getToken }) {
  try {
    const token = await (getToken ?? (args => mintDwdToken({ ...args, fetchImpl })))({ user, scope: GMAIL_COMPOSE_SCOPE });
    const res = await fetchImpl('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST', signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw, ...(threadId ? { threadId } : {}) } }),
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

async function fetchDraftBody({ user, id, fetchImpl, getToken }) {
  const token = await getToken({ user, scope: GMAIL_COMPOSE_SCOPE });
  const res = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error('Gmail API 失敗');
  return mimeText((await res.json())?.message?.payload).text;
}

/** Read the existing MIME headers before sending; include hidden Bcc recipients. */
export async function sendDraft({ user = DEFAULT_USER, id, ledger = loadLedger(), fetchImpl = globalThis.fetch, getToken, draft: suppliedDraft }) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(id)) throw configError();
  const token = await (getToken ?? (args => mintDwdToken({ ...args, fetchImpl })))({ user, scope: GMAIL_COMPOSE_SCOPE });
  const request = async (url, options = {}) => {
    const res = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    if (!res.ok) throw Object.assign(new Error('Gmail API 失敗'), {
      errorKind: res.status === 403 ? 'forbidden_no_access' : res.status === 401 ? 'unauthorized' : 'error',
    });
    return res.json();
  };
  const draft = suppliedDraft ?? await request(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}?format=full`);
  const headers = draft?.message?.payload?.headers;
  if (!Array.isArray(headers)) throw new Error('下書きの宛先を取得できません');
  const values = name => headers.filter(h => String(h.name).toLowerCase() === name).map(h => h.value);
  const recipients = extractAddresses({ to: values('to'), cc: values('cc'), bcc: values('bcc') });
  if (!recipients.length) throw new Error('下書きの宛先がありません');
  const internal = recipients.filter(addr => isInternal(addr, ledger));
  const isForward = values('x-orgiast-forward').some(value => /^[A-Za-z0-9_-]+$/u.test(value));
  if (internal.length && !isForward) throw Object.assign(new Error('内部宛は Discord で連絡してください。'), { errorKind: 'internal_recipient', internal });
  const sent = await request('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', {
    method: 'POST', body: JSON.stringify({ id }),
  });
  if (!sent?.id || !sent?.threadId) throw new Error('送信結果の ID がありません');
  return { sentMessageId: sent.id, threadId: sent.threadId, to: values('to').join(', '), subject: values('subject').join(' ') };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (['--check', '--json', '--dry-run'].includes(name)) { args[name.slice(2)] = true; continue; }
    if (!['--to', '--cc', '--subject', '--body', '--body-file', '--user', '--delete', '--send', '--forward', '--thread-id', '--in-reply-to', '--attach', '--ack-consistency'].includes(name) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw configError();
    const field = name.slice(2);
    const value = argv[++i];
    if (field === 'to' || field === 'cc' || field === 'attach') (args[field] ??= []).push(value);
    else { if (Object.hasOwn(args, field)) throw configError(); args[field] = value; }
  }
  return args;
}

/** deps: stdout(text), loadLedger(), readFile(path), mintToken(options), getToken(options), fetchImpl. */
export async function runCli({ argv = process.argv.slice(2), deps = {} } = {}) {
  const stdout = deps.stdout ?? (text => console.log(text));
  const jsonMode = argv.includes('--json');
  let user = DEFAULT_USER;
  let action = argv.includes('--send') ? 'send' : argv.includes('--forward') ? 'forward' : argv.includes('--delete') ? 'delete' : argv.includes('--check') ? 'check' : argv.includes('--dry-run') ? 'dry-run' : 'create-draft';
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
    if (Object.hasOwn(args, 'forward')) {
      if (['send', 'delete', 'check', 'subject', 'thread-id', 'in-reply-to', 'attach', 'ack-consistency'].some(k => Object.hasOwn(args, k)) || !Object.hasOwn(args, 'to') || (Object.hasOwn(args, 'body') && Object.hasOwn(args, 'body-file'))) throw configError();
      let preface = args.body ?? '';
      if (args['body-file'] !== undefined) { try { preface = (deps.readFile ?? (p => fs.readFileSync(p, 'utf8')))(args['body-file']); } catch { throw configError(); } }
      const getToken = deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY }));
      const originalRaw = await (deps.fetchMessageRaw ?? (options => fetchMessageRaw({ ...options, fetchImpl, getToken })))({ user, id: args.forward });
      const raw = buildForwardRaw({ from: user, to: args.to, cc: args.cc, preface, messageId: args.forward, originalRaw });
      if (args['dry-run']) { emit({ ok: true, raw, headers: Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0] }, `raw: ${raw}`); return 0; }
      const result = await createDraft({ user, raw, fetchImpl, getToken });
      emit({ ok: true, ...result }, `転送下書きを作成しました: ${result.id} (${user})`);
      return 0;
    }
    if (Object.hasOwn(args, 'send')) {
      if (['delete', 'check', 'to', 'cc', 'subject', 'body', 'body-file', 'dry-run', 'thread-id', 'in-reply-to', 'attach'].some(k => Object.hasOwn(args, k))) throw configError();
      if (!/^[A-Za-z0-9_-]+$/u.test(args.send)) throw configError();
      const getToken = deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY }));
      const token = await getToken({ user, scope: GMAIL_COMPOSE_SCOPE });
      const draftResponse = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${args.send}?format=full`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(25000),
      });
      if (!draftResponse.ok) throw new Error('Gmail API 失敗');
      const draft = await draftResponse.json();
      const headers = draft?.message?.payload?.headers;
      const isForward = Array.isArray(headers) && headers.some(header => String(header.name).toLowerCase() === 'x-orgiast-forward'
        && /^[A-Za-z0-9_-]+$/u.test(header.value));
      const inspect = deps.inspectDraft ?? (async () => {
        const result = await checkConsistency({ target: args.send, draftId: args.send, user, deps: { fetchImpl, getToken: deps.readonlyToken, llm: deps.llm } });
        return result;
      });
      let consistency = 'skipped_forward';
      if (!isForward) try {
        const file = statePath(args.send, deps.home);
        const cached = (deps.readState ?? (p => JSON.parse(fs.readFileSync(p, 'utf8'))))(file);
        const age = Date.now() - Date.parse(cached.checkedAt);
        const current = await (deps.getDraftBody ?? (options => fetchDraftBody({ ...options, fetchImpl, getToken })))({ user, id: args.send });
        consistency = age <= 86400000 && cached.bodyHash === bodyHash(current) ? cached : await inspect();
      } catch { consistency = await inspect(); }
      if (!isForward && !consistency.ok && !args['ack-consistency']) { emit({ ok: false, errorKind: 'consistency_block', findings: consistency.findings }, renderConsistency(consistency)); return 2; }
      if (!isForward && args['ack-consistency']) {
        const record = { t: new Date().toISOString(), draftId: args.send, user, reason: args['ack-consistency'], findings: consistency.findings };
        const ledgerFile = path.join(deps.home ?? os.homedir(), '.claude', 'state', 'mail-consistency', 'ack-ledger.jsonl');
        (deps.appendLedger ?? ((p,s) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.appendFileSync(p,s); }))(ledgerFile, JSON.stringify(record)+'\n');
        stdout(`整合性 block を理由付きで承認: ${args['ack-consistency']}`);
      }
      const result = await sendDraft({ user, id: args.send, ledger: (deps.loadLedger ?? loadLedger)(), fetchImpl, getToken, draft,
      });
      emit({ ok: true, ...(isForward ? { consistency } : {}), ...result }, `送信しました: ${result.sentMessageId} (${user})`);
      return 0;
    }
    if (Object.hasOwn(args, 'delete')) {
      if (['check', 'to', 'cc', 'subject', 'body', 'body-file', 'dry-run', 'thread-id', 'in-reply-to', 'attach', 'ack-consistency'].some(k => Object.hasOwn(args, k))) throw configError();
      const result = await deleteDraft({ user, id: args.delete, fetchImpl,
        getToken: deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY })),
      });
      emit({ ok: true, ...result }, result.deleted
        ? `下書きを削除しました: ${result.id} (${user})`
        : `下書きは既にありません: ${result.id} (${user})`);
      return 0;
    }
    if (args.check) {
      if (['to', 'cc', 'subject', 'body', 'body-file', 'dry-run', 'thread-id', 'in-reply-to', 'attach', 'ack-consistency'].some(k => Object.hasOwn(args, k))) throw configError();
      const results = await probeScopes({ user, keyPath: DEFAULT_KEY, scopes: SCOPES, mintToken });
      const failed = results.filter(r => !r.ok);
      emit({ ok: !failed.length, results, ...(failed.length ? { errorKind: failed[0].errorKind } : {}) },
        results.map(r => `${r.ok ? 'OK' : 'NG'} ${r.scope}${r.ok ? '' : ` ${r.errorKind}: ${r.error}`}`).join('\n'));
      return failed.some(r => r.errorKind === 'configuration_error') ? 2 : failed.length ? 1 : 0;
    }
    if (Object.hasOwn(args, 'ack-consistency') || (!Object.hasOwn(args, 'subject') && !Object.hasOwn(args, 'thread-id')) || Object.hasOwn(args, 'body') === Object.hasOwn(args, 'body-file')) throw configError();
    let body = args.body;
    if (args['body-file'] !== undefined) {
      try { body = (deps.readFile ?? (p => fs.readFileSync(p, 'utf8')))(args['body-file']); }
      catch { throw configError(); }
    }
    if (args['thread-id'] !== undefined && !/^[A-Za-z0-9_-]+$/u.test(args['thread-id'])) throw configError();
    const attachments = (args.attach ?? []).map(file => { try { return { name: path.basename(file), data: (deps.readAttachment ?? fs.readFileSync)(file) }; } catch { throw configError(); } });
    const input = { inReplyTo: args['in-reply-to'], from: user, to: args.to, cc: args.cc, subject: args.subject ?? 'Re: (取得予定)', body, attachments };
    const guard = guardRecipients(input, (deps.loadLedger ?? loadLedger)());
    if (guard.blocked) {
      action = 'chat-display';
      emit({ ok: false, errorKind: 'internal_recipient', internal: guard.internal, chatDisplay: guard.chatDisplay }, guard.chatDisplay);
      return 3;
    }
    // 入力の検証と内部宛の停止を、認証・スレッド取得より先に行う。
    let raw = buildRawMessage(input);
    if (args['dry-run']) {
      let headers = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0];
      if (args['thread-id']) {
        headers = headers.replace(/\r\n(?:In-Reply-To|References):[^\r\n]*/gu, '');
        headers += '\r\nIn-Reply-To: (取得予定)\r\nReferences: (返信先の References を取得予定) (取得予定)';
      }
      emit({ ok: true, raw, headers, ...(args['thread-id'] ? { threadId: args['thread-id'] } : {}) },
        `${args['thread-id'] ? `threadId: ${args['thread-id']}\n` : ''}${headers}\n\nraw: ${raw}`);
      return 0;
    }
    const getToken = deps.getToken ?? (options => mintToken({ ...options, keyPath: DEFAULT_KEY }));
    if (args['thread-id']) {
      const reply = await getReplyHeaders({ user, threadId: args['thread-id'], fetchImpl, getToken });
      raw = buildRawMessage({ ...input, ...reply,
        subject: args.subject ?? (/^Re:/iu.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`),
      });
    }
    const result = await createDraft({ user, raw, threadId: args['thread-id'], fetchImpl,
      getToken,
    });
    emit({ ok: true, ...result }, `下書きを作成しました: ${result.id} (${user})`);
    return 0;
  } catch (error) {
    if (error?.errorKind === 'internal_recipient') {
      emit({ ok: false, errorKind: error.errorKind, internal: error.internal }, error.message);
      return 3;
    }
    const failure = safeFailure(error);
    emit({ ok: false, ...(action === 'delete' ? { deleted: false, id: deletionId } : {}), ...failure }, failure.error);
    return failure.errorKind === 'configuration_error' ? 2 : 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await runCli();
