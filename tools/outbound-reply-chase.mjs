#!/usr/bin/env node
// Mail is read-only; only the manual ledger is written. EXAMINE + BODY.PEEK, Gmail metadata GET only. Never log server errors or credentials.
import tls from 'node:tls';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// Manual CLI (never connects to mail):
// --add --who <name> --channel <LINE|電話|FAX|対面|メール> --sent YYYY-MM-DD
//   --subject <text> [--note <text>] [--stale-days N] [--reading <romaji/kana>]
// --done <id> / --list-manual (all waiting entries, including those not yet stale)
// --ledger <file> overrides ORGIAST_HOME/.claude/reply-waiting.json.
// Default scan includes only stale entries. Omitted entry thresholds follow --stale-days.
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
    if (['--add', '--list-manual'].includes(arg)) options[arg === '--add' ? 'add' : 'listManual'] = true;
    else if (['--who', '--channel', '--sent', '--subject', '--note', '--done', '--ledger', '--reading'].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('オプションの値が必要です');
      options[arg.slice(2)] = value;
    }
    else if (['--json', '--skip-gmail', '--skip-yahoo'].includes(arg)) options[{ '--json': 'json', '--skip-gmail': 'skipGmail', '--skip-yahoo': 'skipYahoo' }[arg]] = true;
    else if (arg === '--stale-days' || arg === '--days-back') {
      const value = Number(args[++i]);
      if (!Number.isSafeInteger(value) || value < (arg === '--days-back' ? 1 : 0)) throw new Error('日数には有効な整数を指定してください');
      options[arg === '--stale-days' ? 'staleDays' : 'daysBack'] = value;
    } else throw new Error('不明なオプションです');
  }
  if ([options.add, options.done, options.listManual].filter(Boolean).length > 1) throw new Error('操作は一つだけ指定してください');
  if (!options.add && ['who', 'channel', 'sent', 'subject', 'note', 'reading'].some(key => key in options)) throw new Error('--add が必要です');
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
// Manual entries use Tokyo calendar days; a date-only promise has no time of day.
export function manualLedgerPath() {
  return path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'reply-waiting.json');
}
function validDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0; }
function validManual(entry) {
  return entry && nonempty(entry.id) && nonempty(entry.who) && nonempty(entry.channel) &&
    nonempty(entry.subject) && validDay(entry.sentAt) && ['waiting', 'done'].includes(entry.status) &&
    (entry.note === undefined || typeof entry.note === 'string') &&
    (entry.staleDays === undefined || (Number.isSafeInteger(entry.staleDays) && entry.staleDays >= 0));
}
export function readManualLedger(file = manualLedgerPath()) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { entries: [] }; throw error; }
  const ledger = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!ledger || !Array.isArray(ledger.entries) || !ledger.entries.every(validManual) ||
      new Set(ledger.entries.map(entry => entry.id)).size !== ledger.entries.length) throw new Error('手動台帳が不正です');
  return ledger;
}
// Kanji readings cannot be inferred reliably without a dictionary. Use --reading
// for other kanji names; preserve this explicitly supplied contact's reading.
export function manualSlug(who, reading) {
  const known = { '日栄工業 黒崎直人': 'nichiei-kogyo-kurosaki-naoto' };
  let text = (reading || known[who] || who).normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const kana = {};
  for (const [chars, values] of [
    ['あいうえお', 'a i u e o'], ['かきくけこ', 'ka ki ku ke ko'], ['さしすせそ', 'sa shi su se so'],
    ['たちつてと', 'ta chi tsu te to'], ['なにぬねの', 'na ni nu ne no'], ['はひふへほ', 'ha hi fu he ho'],
    ['まみむめも', 'ma mi mu me mo'], ['やゆよ', 'ya yu yo'], ['らりるれろ', 'ra ri ru re ro'],
    ['わをん', 'wa o n'], ['がぎぐげご', 'ga gi gu ge go'], ['ざじずぜぞ', 'za ji zu ze zo'],
    ['だぢづでど', 'da ji zu de do'], ['ばびぶべぼ', 'ba bi bu be bo'], ['ぱぴぷぺぽ', 'pa pi pu pe po'],
    ['ぁぃぅぇぉ', 'a i u e o'],
  ]) [...chars].forEach((c, i) => { kana[c] = values.split(' ')[i]; });
  text = text.replace(/([きぎしじちにひびぴみり])([ゃゅょ])/g, (_, a, b) => {
    const stem = { し: 'sh', じ: 'j', ち: 'ch' }[a] || kana[a].slice(0, -1) + 'y';
    return stem + { ゃ: 'a', ゅ: 'u', ょ: 'o' }[b];
  }).replace(/[ぁ-ん]/g, c => kana[c] || c)
    .replace(/っ([bcdfghjklmnpqrstvwxyz])/g, '$1$1').replace(/([aeiou])ー/g, '$1');
  text = text.normalize('NFD').replace(/\p{M}/gu, '');
  if (/[^a-z0-9\s._-]/.test(text)) throw new Error('漢字名などには --reading でローマ字またはかなの読みを指定してください');
  const slug = text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('相手の読みを指定してください');
  return slug;
}
export function addManual(ledger, options) {
  if (!nonempty(options.who) || !nonempty(options.subject) || !validDay(options.sent) ||
      !['LINE', '電話', 'FAX', '対面', 'メール'].includes(options.channel)) throw new Error('相手・チャネル・送信日・用件を確認してください');
  const base = `${manualSlug(options.who, options.reading)}-${options.sent.replaceAll('-', '')}`;
  let id = base, suffix = 2;
  const ids = new Set(ledger.entries.map(entry => entry.id));
  while (ids.has(id)) id = `${base}-${suffix++}`;
  const entry = { id, who: options.who, channel: options.channel, sentAt: options.sent,
    subject: options.subject, note: options.note || '', status: 'waiting' };
  // Omission means follow the scan's --stale-days, not the registration default.
  if (options.explicitStaleDays) entry.staleDays = options.staleDays;
  ledger.entries.push(entry);
  return entry;
}
export function completeManual(ledger, id) {
  const entry = ledger.entries.find(entry => entry.id === id);
  if (!entry) throw new Error('指定したIDが台帳にありません');
  entry.status = 'done';
  return entry;
}
export function findManualWaiting(entries, { staleDays = 7, now = Date.now(), includeFresh = false } = {}) {
  const today = formatDate(now).slice(0, 10);
  return entries.filter(entry => entry.status === 'waiting').map(entry => ({ ...entry, manual: true,
    elapsedDays: elapsedDays(entry.sentAt, today) })).filter(entry => includeFresh || entry.elapsedDays >= (entry.staleDays ?? staleDays));
}
export function formatManual(item) {
  const clean = value => String(value).replace(/[\r\n\x00-\x1f\x7f]/g, ' ');
  return `手動 ID: ${clean(item.id)} | チャネル: ${clean(item.channel)} | 相手: ${clean(item.who)} | 用件: ${clean(item.subject)} | 送った日: ${item.sentAt} | 経過: ${item.elapsedDays}日 | メモ: ${clean(item.note || '（なし）')}`;
}

export async function main(args = process.argv.slice(2), { now = Date.now(), scans } = {}) {
  const options = parseOptions(args), waiting = [], errors = [], warnings = [];
  const ledgerPath = options.ledger || manualLedgerPath();
  if (options.add || options.done) {
    const ledger = readManualLedger(ledgerPath);
    const entry = options.add ? addManual(ledger, { ...options, explicitStaleDays: args.includes('--stale-days') }) : completeManual(ledger, options.done);
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
    console.log(options.json ? JSON.stringify(entry) : `${options.add ? '登録' : '完了'}: ${entry.id}`);
    process.exitCode = 0;
    return;
  }
  try { waiting.push(...findManualWaiting(readManualLedger(ledgerPath).entries, { ...options, now, includeFresh: options.listManual })); }
  catch { warnings.push('手動台帳を読み込めませんでした。JSONとエントリを確認してください。'); }
  for (const [name, skip, scan] of (options.listManual ? [] : scans || [['Yahoo! メール', options.skipYahoo, yahoo], ...['kim@orgiast.jp', 'seisaku-team@orgiast.jp'].map(account => [`Gmail (${account})`, options.skipGmail, (opts, time) => gmail(opts, time, account)])])) {
    if (skip) continue;
    try { waiting.push(...await scan(options, now)); }
    catch (error) { errors.push(`${name}: 取得に失敗しました${error.safeStage ? `（${error.safeStage}）` : ''}。接続・認証設定を確認してください（認証情報とサーバー応答は非表示）。`); }
  }
  waiting.sort((a, b) => b.elapsedDays - a.elapsedDays);
  if (options.json) console.log(JSON.stringify({ waiting, errors, warnings }, null, 2));
  else {
    for (const item of waiting) if (item.manual) console.log(formatManual(item)); else console.log(`アプリ: ${item.app} | 開くアカウント: ${item.account} | 相手: ${item.recipient} | フォルダ: ${item.folder} | 日時: ${formatDate(item.date)} JST | 件名: ${item.subject.replace(/[\r\n]/g, ' ')} | 経過: ${item.elapsedDays}日`);
    if (!waiting.length && !errors.length) console.log('返信待ちはありません');
    for (const error of [...errors, ...warnings]) console.error(error);
  }
  // Retrieval failures must never look like an empty successful scan.
  process.exitCode = waiting.length ? 1 : errors.length || (options.listManual && warnings.length) ? 2 : 0;
}
if (isEntry(import.meta.url)) main().catch(() => {
  console.error('実行できませんでした。オプション・台帳・設定を確認してください。漢字名などには --reading で読みを指定してください。'); process.exitCode = 2;
});
