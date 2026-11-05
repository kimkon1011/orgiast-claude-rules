#!/usr/bin/env node
// Read-only: EXAMINE + BODY.PEEK, Gmail metadata GET only. Never log server errors or credentials.
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { isEntry } from './is-entry.mjs';

const DAY = 86_400_000;
// Automated destinations and list/robot headers do not represent a human reply obligation.
export const EXCLUDED_ADDRESSES = /(?:no[._-]?reply|notification|mailer-daemon|postmaster|newsletter|do[._-]?not[._-]?reply)/i;
export const EXCLUDED_HEADERS = /^(?:auto-generated|auto-replied|bulk|list|junk)$/i;
export function normalizeSubject(value = '') {
  return value.replace(/\u3000/g, ' ').trim().replace(/^(?:(?:re|fwd?|fw)\s*:\s*)+/i, '').trim().replace(/\s+/g, ' ');
}
export function addresses(value = '') {
  return [...new Set((value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/gi) || []).map(s => s.toLowerCase()))];
}
// The configured IMAP username is credential material: only a masked account locator is printed.
export function accountLocator(account = '') {
  const [local, domain] = account.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : 'Yahoo! 設定済みアカウント（YAHOO_IMAP_USER）';
}
export function elapsedDays(date, now = Date.now()) { return Math.floor((Number(new Date(now)) - Number(new Date(date))) / DAY); }
export function isExcluded(message, recipient) {
  return EXCLUDED_ADDRESSES.test(recipient) || !!message.listUnsubscribe ||
    EXCLUDED_HEADERS.test((message.autoSubmitted || '').split(';')[0].trim()) || EXCLUDED_HEADERS.test((message.precedence || '').trim());
}
export function isReply(sent, incoming, recipient) {
  if (!(new Date(incoming.date) > new Date(sent.date)) || !addresses(incoming.from).includes(recipient.toLowerCase())) return false;
  const ids = `${incoming.inReplyTo || ''} ${incoming.references || ''}`.match(/<[^<>]+>/g) || [];
  return !!(sent.messageId && ids.includes(sent.messageId.trim())) ||
    (!!normalizeSubject(sent.subject) && normalizeSubject(sent.subject) === normalizeSubject(incoming.subject));
}
export function findWaiting(sent, received, { staleDays = 7, now = Date.now() } = {}) {
  const bySender = new Map();
  for (const mail of received) for (const sender of addresses(mail.from)) {
    if (!bySender.has(sender)) bySender.set(sender, []);
    bySender.get(sender).push(mail);
  }
  return sent.flatMap(mail => addresses(`${mail.to || ''},${mail.cc || ''},${mail.bcc || ''}`).filter(recipient =>
    recipient !== mail.account?.toLowerCase() && !isExcluded(mail, recipient) && elapsedDays(mail.date, now) >= staleDays &&
    !(bySender.get(recipient) || []).some(reply => isReply(mail, reply, recipient))
  ).map(recipient => ({ app: mail.app, account: mail.app === 'Yahoo! メール' ? accountLocator(mail.account) : mail.account, recipient, folder: mail.folder,
    date: mail.date, subject: mail.subject, elapsedDays: elapsedDays(mail.date, now) })));
}
function charsetDecode(bytes, charset = 'utf-8') {
  try { return new TextDecoder(charset).decode(bytes); } catch { return bytes.toString('utf8'); }
}
function transferDecode(value, encoding) {
  if (/^base64$/i.test(encoding)) return Buffer.from(value, 'base64');
  if (/^quoted-printable$/i.test(encoding)) return Buffer.from(value.replace(/=\r?\n/g, '').replace(/=([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'latin1');
  return Buffer.from(value, 'latin1');
}
export function decodeHeader(value = '') {
  return value.replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_, charset, encoding, text) => charsetDecode(transferDecode(encoding.toLowerCase() === 'q' ? text.replace(/_/g, ' ') : text,
      encoding.toLowerCase() === 'b' ? 'base64' : 'quoted-printable'), charset));
}
function headers(raw) {
  const result = {};
  for (const line of raw.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon > 0) { const key = line.slice(0, colon).toLowerCase(); result[key] = [result[key], line.slice(colon + 1).trim()].filter(Boolean).join(' '); }
  }
  return result;
}
// Available for mixed MIME bodies; the chase itself downloads only headers to minimize mailbox traffic.
export function decodeBody(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('latin1') : raw;
  const split = /\r?\n\r?\n/.exec(text);
  if (!split) return '';
  const h = headers(text.slice(0, split.index)); const body = text.slice(split.index + split[0].length);
  const type = h['content-type'] || 'text/plain';
  const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  if (/^multipart\//i.test(type) && boundary) {
    return body.split(`--${boundary[1] || boundary[2]}`).slice(1).filter(p => !p.startsWith('--')).map(p => decodeBody(p.replace(/^\r?\n/, ''))).filter(Boolean).join('\n');
  }
  if (!/^text\//i.test(type)) return '';
  const charset = /charset\s*=\s*"?([^";\s]+)/i.exec(type)?.[1] || 'utf-8';
  return charsetDecode(transferDecode(body, h['content-transfer-encoding'] || ''), charset);
}
export function messageFromHeaders(h, context, fallbackDate) {
  const timestamp = Date.parse(h.date);
  return { ...context, date: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallbackDate,
    from: decodeHeader(h.from), to: decodeHeader(h.to), cc: decodeHeader(h.cc), bcc: decodeHeader(h.bcc), subject: decodeHeader(h.subject),
    messageId: h['message-id'], references: h.references, inReplyTo: h['in-reply-to'],
    autoSubmitted: h['auto-submitted'], precedence: h.precedence, listUnsubscribe: h['list-unsubscribe'] };
}
export function parseOptions(args) {
  const options = { staleDays: 7, daysBack: 180, json: false, skipGmail: false, skipYahoo: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--json', '--skip-gmail', '--skip-yahoo'].includes(arg)) options[{ '--json': 'json', '--skip-gmail': 'skipGmail', '--skip-yahoo': 'skipYahoo' }[arg]] = true;
    else if (arg === '--stale-days' || arg === '--days-back') {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < (arg === '--days-back' ? 1 : 0)) throw new Error('日数には有効な整数を指定してください');
      options[arg === '--stale-days' ? 'staleDays' : 'daysBack'] = value;
    } else throw new Error('不明なオプションです');
  }
  return options;
}

// Byte-oriented framing: literal content is never parsed as IMAP response lines.
export class ImapReader {
  constructor(socket) {
    this.socket = socket; this.buffer = Buffer.alloc(0); this.wake = null; this.failure = null; this.tag = 0;
    socket.on('data', data => { this.buffer = Buffer.concat([this.buffer, data]); this.wake?.(); });
    const fail = () => { this.failure = new Error('IMAP接続が終了しました'); this.wake?.(); };
    socket.on('error', fail); socket.on('close', fail);
    socket.setTimeout(60_000, () => socket.destroy());
  }
  async wait() { if (this.failure) throw this.failure; await new Promise(resolve => { this.wake = resolve; }); this.wake = null; }
  async line() {
    let end;
    while ((end = this.buffer.indexOf('\r\n')) < 0) await this.wait();
    const value = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 2); return value;
  }
  async bytes(length) {
    while (this.buffer.length < length) await this.wait();
    const value = this.buffer.subarray(0, length); this.buffer = this.buffer.subarray(length); return value;
  }
  async command(command) {
    const tag = `C${++this.tag}`; this.socket.write(`${tag} ${command}\r\n`);
    const lines = [], literals = [], literalLines = [];
    while (true) {
      const line = await this.line();
      if (line.startsWith(`${tag} `)) {
        if (!line.startsWith(`${tag} OK`)) throw new Error('IMAP操作が拒否されました');
        return { lines, literals, literalLines };
      }
      if (/^\* BYE/i.test(line)) throw new Error('IMAPセッションが終了しました');
      lines.push(line);
      const literal = /\{(\d+)\+?\}$/.exec(line);
      if (literal) { literalLines.push(line); literals.push(await this.bytes(Number(literal[1]))); }
    }
  }
}
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error('IMAP設定が不正です');
  return '"' + value.replace(/[\\"]/g, '\\$&') + '"';
}
function imapDate(date) { return `${date.getUTCDate()}-${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][date.getUTCMonth()]}-${date.getUTCFullYear()}`; }
async function yahoo(options, now) {
  const env = {};
  for (const line of readFileSync('C:/Users/uers/orgiast-main/.env.local', 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?(YAHOO_IMAP_\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!['HOST','PORT','USER','PASS'].every(key => env[`YAHOO_IMAP_${key}`])) throw new Error('IMAP設定不足');
  const socket = tls.connect({ host: env.YAHOO_IMAP_HOST, port: Number(env.YAHOO_IMAP_PORT), servername: env.YAHOO_IMAP_HOST, rejectUnauthorized: true });
  const client = new ImapReader(socket);
  let stage = '接続';
  try {
    const greeting = await client.line();
    if (!/^\* (?:OK|PREAUTH)\b/i.test(greeting)) throw new Error('IMAP接続失敗');
    stage = '認証';
    if (!/^\* PREAUTH\b/i.test(greeting)) await client.command(`LOGIN ${quote(env.YAHOO_IMAP_USER)} ${quote(env.YAHOO_IMAP_PASS)}`);
    const since = imapDate(new Date(now - options.daysBack * DAY));
    const sent = [], received = [];
    for (const folder of ['Sent', 'Inbox', '&MKIw,DCrMKQw1g-']) {
      stage = `${folder}を開く`;
      await client.command(`EXAMINE ${quote(folder)}`);
      stage = `${folder}の検索`;
      const search = await client.command(`UID SEARCH SINCE ${since}`);
      const ids = search.lines.filter(line => /^\* SEARCH(?: |$)/.test(line)).flatMap(line => line.slice(8).trim().split(/\s+/).filter(id => /^\d+$/.test(id)));
      stage = `${folder}のヘッダ取得`;
      for (let i = 0; i < ids.length; i += 200) {
        const result = await client.command(`UID FETCH ${ids.slice(i, i + 200).join(',')} (INTERNALDATE BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC BCC SUBJECT MESSAGE-ID REFERENCES IN-REPLY-TO AUTO-SUBMITTED PRECEDENCE LIST-UNSUBSCRIBE)])`);
        for (const [index, raw] of result.literals.entries()) {
          const internal = /INTERNALDATE "([^"]+)"/i.exec(result.literalLines[index])?.[1];
          const fallback = Number.isFinite(Date.parse(internal)) ? new Date(internal).toISOString() : undefined;
          const message = messageFromHeaders(headers(raw.toString('utf8')), { app: 'Yahoo! メール', account: env.YAHOO_IMAP_USER, folder }, fallback);
          if (!message.date) throw new Error('日時を取得できないメールがあります');
          if (Date.parse(message.date) >= now - options.daysBack * DAY) (folder === 'Sent' ? sent : received).push(message);
        }
      }
    }
    return findWaiting(sent, received, { ...options, now });
  } catch (error) {
    const safeReason = ['IMAP操作が拒否されました', 'IMAP接続が終了しました', 'IMAPセッションが終了しました', '日時を取得できないメールがあります'].includes(error.message) ? error.message : '取得エラー';
    throw Object.assign(new Error('Yahoo取得失敗'), { safeStage: `${stage}: ${safeReason}` });
  } finally { socket.destroy(); }
}
async function gmail(options, now, account) {
  // Reuse the repository's DWD/relay authentication and workspace transport.
  const { getDriveToken } = await import('./lib/drive-auth.mjs');
  const { gwsFetch } = await import('./lib/gws-proxy.mjs');
  const waiting = [];
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: account, signal: AbortSignal.timeout(30_000) });
  const get = async path => {
    const response = await gwsFetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Gmail取得失敗');
    return response.json();
  };
  const sent = [], received = [];
  let pageToken;
  do {
    const query = `after:${Math.floor((now - options.daysBack * DAY) / 1000)} -in:trash -in:spam`;
    const page = await get(`/messages?maxResults=500&q=${encodeURIComponent(query)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    for (const stub of page.messages || []) {
      const message = await get(`/messages/${stub.id}?format=metadata`);
      const h = Object.fromEntries((message.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      if (message.labelIds?.includes('DRAFT')) continue;
      const isSent = message.labelIds?.includes('SENT');
      (isSent ? sent : received).push(messageFromHeaders(h, { app: 'Gmail', account, folder: isSent ? '送信済み' : '受信トレイ/アーカイブ' }, new Date(Number(message.internalDate)).toISOString()));
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  waiting.push(...findWaiting(sent, received, { ...options, now }));
  return waiting;
}
export function formatDate(date) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(date));
  return parts;
}
export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args), now = Date.now(), waiting = [], errors = [];
  for (const [name, skip, scan] of [['Yahoo! メール', options.skipYahoo, yahoo], ...['kim@orgiast.jp', 'seisaku-team@orgiast.jp'].map(account => [`Gmail (${account})`, options.skipGmail, (opts, time) => gmail(opts, time, account)])]) {
    if (skip) continue;
    try { waiting.push(...await scan(options, now)); }
    catch (error) { errors.push(`${name}: 取得に失敗しました${error.safeStage ? `（${error.safeStage}）` : ''}。接続・認証設定を確認してください（認証情報とサーバー応答は非表示）。`); }
  }
  waiting.sort((a, b) => b.elapsedDays - a.elapsedDays);
  if (options.json) console.log(JSON.stringify({ waiting, errors }, null, 2));
  else {
    for (const item of waiting) console.log(`アプリ: ${item.app} | 開くアカウント: ${item.account} | 相手: ${item.recipient} | フォルダ: ${item.folder} | 日時: ${formatDate(item.date)} JST | 件名: ${item.subject.replace(/[\r\n]/g, ' ')} | 経過: ${item.elapsedDays}日`);
    if (!waiting.length && !errors.length) console.log('返信待ちはありません');
    for (const error of errors) console.error(error);
  }
  // Retrieval failures must never look like an empty successful scan.
  process.exitCode = errors.length ? 2 : waiting.length ? 1 : 0;
}
if (isEntry(import.meta.url)) main().catch(() => {
  console.error('実行できませんでした。オプションと設定を確認してください。'); process.exitCode = 2;
});
