#!/usr/bin/env node
/**
 * 古い下書き（送ると事故になる下書き）を見つける。
 *   - 下書きの最終保存より後に、同じ社外宛先へ別のメールを送信済み
 *   - 初回挨拶（名刺交換の御礼など）の下書きなのに、その宛先へ既に送信済み
 * 2026-10-26 三昌商事様: 9/13 に名刺 OCR から自動生成された御礼の下書きが、挨拶・提案メール送信後も残っていた。
 *
 *   node tools/mail-stale-draft.mjs [--user seisaku-team@orgiast.jp] [--apply] [--notify] [--json]
 *     --apply  : 古い下書きに Gmail ラベル「⚠送信前に確認_古い下書き」を付ける（gmail.modify）
 *     --notify : 今回新たにラベルを付けた下書きを notify-kim で警告 DM する（--apply 時のみ）
 * gmail-draft.mjs --send も mail-consistency-check 経由で同じ判定を通す（古い下書きは block）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDriveToken, defaultDriveKeyPath } from './lib/drive-auth.mjs';
import { relayStatePath } from './lib/seisaku-gmail-token.mjs';
import { isEntry } from './is-entry.mjs';

export function hasAnyCredential({ env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  return Boolean(env.GOOGLE_SA_KEY)
    || exists(defaultDriveKeyPath())
    || exists(path.join(home, '.claude', 'keys', 'aujust-sheets-reader.json'))
    || exists(relayStatePath());
}

export function resolveKeyPath({ env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  const candidates = [
    env.GOOGLE_SA_KEY,
    defaultDriveKeyPath(),
    path.join(home, '.claude', 'keys', 'aujust-sheets-reader.json'),
  ].filter(Boolean);
  const found = candidates.find(p => exists(p));
  return found ?? candidates[0];
}

const defaultToken = options => getDriveToken({ ...options, keyPath: resolveKeyPath() });

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
export const LABEL = '⚠送信前に確認_古い下書き';
export const DEFAULT_USERS = ['seisaku-team@orgiast.jp'];
const INTERNAL = /@orgiast\.jp$/iu;
const GREETING = /名刺交換|ご挨拶(?:させて|のお礼|の御礼)|はじめまして|初めまして|名刺を頂戴|ご縁とし/u;
const READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

export function addresses(value) {
  return [...String(value ?? '').matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu)].map(m => m[0].toLowerCase());
}
const header = (payload, name) => payload?.headers?.find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value ?? '';
export function externalRecipients(payload) {
  return [...new Set(addresses(`${header(payload, 'To')},${header(payload, 'Cc')}`).filter(a => !INTERNAL.test(a)))];
}
function plainText(payload) {
  const texts = [];
  const walk = part => {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body?.data) texts.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
    for (const child of part.parts ?? []) walk(child);
  };
  walk(payload);
  return texts.join('\n');
}
const jst = ms => new Date(Number(ms)).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** 純粋関数: draft={messageId,internalDate,subject,body}, sentByAddr={addr:[{id,internalDate,subject}]（新しい順）} */
export function staleFindings({ draft, sentByAddr }) {
  const findings = [];
  const greeting = GREETING.test(`${draft.subject}\n${draft.body}`);
  for (const [addr, sent] of Object.entries(sentByAddr)) {
    const others = (sent ?? []).filter(s => s.id !== draft.messageId);
    const later = others.find(s => Number(s.internalDate) > Number(draft.internalDate));
    if (later) {
      findings.push({ severity: 'block', category: '古い下書き', thread_fact: `${jst(later.internalDate)} に ${addr} へ「${later.subject}」を送信済み（この下書きの最終保存 ${jst(draft.internalDate)} より後）`, thread_ref: null, draft_claim: draft.subject, suggestion: '後から送ったメールで用件が進んでいます。この下書きは送らずに削除するか、最新のやり取りに合わせて作り直してください。' });
    } else if (greeting && others.length) {
      findings.push({ severity: 'block', category: '古い下書き', thread_fact: `${addr} へは既に ${jst(others[0].internalDate)}「${others[0].subject}」などを送信済み`, thread_ref: null, draft_claim: draft.subject, suggestion: '初回の挨拶（名刺交換の御礼など）の下書きですが、この宛先とは既にやり取りがあります。送らずに削除してください。' });
    }
  }
  return findings;
}

async function gmail(token, endpoint, { fetchImpl = globalThis.fetch, method = 'GET', body, retryDelayMs = 2000, sleepImpl = sleep } = {}) {
  const execute = () => fetchImpl(`${API}${endpoint}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  let res = await execute();
  if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
    if (retryDelayMs > 0) await sleepImpl(retryDelayMs);
    res = await execute();
  }
  if (!res.ok) throw new Error(`Gmail API ${res.status} ${endpoint.split('?')[0]}`);
  return res.json();
}
export async function sentTo(token, addr, fetchImpl, { draftMessageId, sleepImpl = sleep, retryDelayMs = 2000 } = {}) {
  const q = encodeURIComponent(`in:sent {to:${addr} cc:${addr} bcc:${addr}}`);
  const list = await gmail(token, `/messages?q=${q}&maxResults=5`, { fetchImpl, sleepImpl, retryDelayMs });
  const messages = list.messages ?? [];
  if (!messages.length) return [];
  const target = (messages[0].id === draftMessageId && messages.length > 1) ? messages[1] : messages[0];
  const msg = await gmail(token, `/messages/${target.id}?format=metadata&metadataHeaders=Subject`, { fetchImpl, sleepImpl, retryDelayMs });
  const detail = { id: msg.id, internalDate: msg.internalDate, subject: header(msg.payload, 'Subject') };
  const out = [];
  for (const m of messages) {
    out.push(m.id === target.id ? detail : { id: m.id, internalDate: '0', subject: '' });
  }
  return out.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
}
/** draft API の JSON（format=full または format=metadata）から判定する。宛先が社内だけなら []。 */
export async function staleFindingsForDraft(token, draftJson, { fetchImpl, sentCache, sleepImpl = sleep, retryDelayMs = 2000 } = {}) {
  const message = draftJson?.message;
  const recipients = externalRecipients(message?.payload);
  if (!recipients.length) return [];
  const cache = sentCache ?? new Map();
  const sentByAddr = {};
  for (const addr of recipients) {
    if (!cache.has(addr)) {
      cache.set(addr, sentTo(token, addr, fetchImpl, { draftMessageId: message?.id, sleepImpl, retryDelayMs }));
    }
    sentByAddr[addr] = await cache.get(addr);
  }
  const text = plainText(message?.payload);
  const body = text.trim() ? text : (message?.snippet ?? '');
  return staleFindings({ draft: { messageId: message?.id, internalDate: message?.internalDate, subject: header(message?.payload, 'Subject'), body }, sentByAddr });
}

export async function ensureLabel(token, fetchImpl, { sleepImpl = sleep, retryDelayMs = 2000 } = {}) {
  const labels = await gmail(token, '/labels', { fetchImpl, sleepImpl, retryDelayMs });
  const found = (labels.labels ?? []).find(l => l.name === LABEL);
  if (found) return found.id;
  return (await gmail(token, '/labels', { fetchImpl, method: 'POST', body: { name: LABEL, labelListVisibility: 'labelShow', messageListVisibility: 'show', color: { backgroundColor: '#fb4c2f', textColor: '#ffffff' } }, sleepImpl, retryDelayMs })).id;
}

export async function resolveLabelId(token, fetchImpl, { create = false, sleepImpl = sleep, retryDelayMs = 2000 } = {}) {
  if (create) return ensureLabel(token, fetchImpl, { sleepImpl, retryDelayMs });
  try {
    const labels = await gmail(token, '/labels', { fetchImpl, sleepImpl, retryDelayMs });
    return (labels.labels ?? []).find(l => l.name === LABEL)?.id ?? null;
  } catch {
    return null;
  }
}

export async function scanMailbox({
  user,
  apply = false,
  fetchImpl,
  getToken = defaultToken,
  deadlineMs = 8 * 60 * 1000,
  deadline,
  concurrency = 8,
  sleepImpl = sleep,
  retryDelayMs = 2000,
} = {}) {
  const limit = deadline ?? (Date.now() + deadlineMs);
  const token = await getToken({ scope: apply ? MODIFY_SCOPE : READ_SCOPE, impersonate: user });
  const labelId = await resolveLabelId(token, fetchImpl, { create: apply, sleepImpl, retryDelayMs });

  const allDrafts = [];
  let pageToken = '';
  let truncated = false;
  let isFirstPage = true;

  do {
    if (!isFirstPage && Date.now() >= limit) {
      truncated = true;
      break;
    }
    isFirstPage = false;
    const page = await gmail(token, `/drafts?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`, {
      fetchImpl,
      sleepImpl,
      retryDelayMs,
    });
    for (const d of page.drafts ?? []) allDrafts.push(d);
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);

  if (allDrafts.length === 0) {
    return { user, scanned: 0, stale: [], truncated, unprocessed: 0 };
  }

  const sentCache = new Map();
  const draftResults = new Array(allDrafts.length);
  const errors = [];
  let currentIndex = 0;
  let scannedCount = 0;

  const workerCount = Math.min(concurrency, allDrafts.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (Date.now() >= limit) {
        truncated = true;
        break;
      }
      const i = currentIndex++;
      if (i >= allDrafts.length) break;

      const d = allDrafts[i];
      try {
      const draft = await gmail(
        token,
        `/drafts/${d.id}?format=metadata&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject`,
        { fetchImpl, sleepImpl, retryDelayMs }
      );
      scannedCount++;

      const labelIds = draft.message?.labelIds ?? [];
      const isAlreadyLabeled = Boolean(labelId && labelIds.includes(labelId));

      if (isAlreadyLabeled) {
        draftResults[i] = {
          user,
          draftId: d.id,
          messageId: draft.message.id,
          subject: header(draft.message.payload, 'Subject'),
          to: header(draft.message.payload, 'To'),
          savedAt: jst(draft.message.internalDate),
          newlyLabeled: false,
          alreadyLabeled: true,
          findings: [{
            severity: 'block',
            category: '古い下書き',
            thread_fact: '前回の点検でラベル付与済み',
            thread_ref: null,
            draft_claim: header(draft.message.payload, 'Subject'),
            suggestion: '前回の点検で古い下書きとして判定されています。送らずに削除するか、最新のやり取りに合わせて作り直してください。',
          }],
        };
        continue;
      }

      const findings = await staleFindingsForDraft(token, draft, { fetchImpl, sentCache, sleepImpl, retryDelayMs });
      if (!findings.length) continue;

      let newlyLabeled = false;
      if (apply && labelId && !labelIds.includes(labelId)) {
        await gmail(token, `/messages/${draft.message.id}/modify`, {
          fetchImpl,
          method: 'POST',
          body: { addLabelIds: [labelId] },
          sleepImpl,
          retryDelayMs,
        });
        newlyLabeled = true;
      }

      draftResults[i] = {
        user,
        draftId: d.id,
        messageId: draft.message.id,
        subject: header(draft.message.payload, 'Subject'),
        to: header(draft.message.payload, 'To'),
        savedAt: jst(draft.message.internalDate),
        newlyLabeled,
        alreadyLabeled: false,
        findings,
      };
      } catch (error) {
        errors.push({ draftId: d.id, error: String(error?.message || error) });
      }
    }
  });

  await Promise.all(workers);

  const stale = draftResults.filter(Boolean);
  const unprocessed = allDrafts.length - scannedCount;

  return {
    user,
    scanned: scannedCount,
    stale,
    truncated,
    unprocessed,
    errors,
  };
}

export function render(results) {
  const lines = [];
  for (const r of results) {
    const status = [
      r.truncated ? `打ち切り: 未処理 ${r.unprocessed ?? 0} 件` : '',
      r.error ? `取得失敗: ${r.error}` : '',
      r.errors?.length ? `取得失敗 ${r.errors.length} 件` : '',
    ].filter(Boolean).join('、');
    lines.push(`■ ${r.user}: 下書き ${r.scanned ?? 0} 件中、古い下書き ${r.stale?.length ?? 0} 件${status ? `（${status}）` : ''}`);
    for (const s of r.stale ?? []) lines.push(`- 件名「${s.subject}」 宛先 ${s.to} 最終保存 ${s.savedAt}${s.newlyLabeled ? '（今回ラベル付与）' : ''}\n  ${s.findings[0].thread_fact}`);
  }
  return lines.join('\n');
}
function notifyText(results) {
  const fresh = results.flatMap(r => r.stale.filter(s => s.newlyLabeled));
  if (!fresh.length) return '';
  return [`⚠ 送ると事故になる古い下書きが ${fresh.length} 件あります（Gmail の下書きにラベル「${LABEL}」を付けました）。送らずに削除してください。`,
    ...fresh.slice(0, 15).map(s => `・${s.user} の下書き「${s.subject}」（宛先 ${s.to}・最終保存 ${s.savedAt}）\n  理由: ${s.findings[0].thread_fact}`),
    ...(fresh.length > 15 ? [`…ほか ${fresh.length - 15} 件（node tools/mail-stale-draft.mjs で一覧）`] : [])].join('\n');
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const users = []; let apply = false, notify = false, json = false;
  let deadlineMin = 8;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true; else if (a === '--notify') notify = true; else if (a === '--json') json = true;
    else if (a === '--user' && argv[i + 1]) users.push(argv[++i]);
    else if (a === '--deadline-min' && argv[i + 1]) deadlineMin = Number(argv[++i]);
    else { (deps.stdout ?? console.log)('使い方: node tools/mail-stale-draft.mjs [--user addr]... [--apply] [--notify] [--json] [--deadline-min N]'); return 64; }
  }
  if (!(deps.hasCredential ?? hasAnyCredential)()) {
    (deps.stdout ?? console.log)('■ Gmail の認証情報(鍵・リレー)が無いPCのためスキップ（何もしない）');
    return 0;
  }
  const deadlineMs = deadlineMin * 60 * 1000;
  const results = [];
  for (const user of users.length ? users : DEFAULT_USERS) {
    try { results.push(await (deps.scanMailbox ?? scanMailbox)({ user, apply, fetchImpl: deps.fetchImpl, getToken: deps.getToken, deadlineMs })); }
    catch (error) { results.push({ user, scanned: 0, stale: [], error: String(error.message || error) }); }
  }
  const text = notify && apply ? notifyText(results) : '';
  if (text) {
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'notify-kim.mjs');
    (deps.notify ?? (t => spawnSync(process.execPath, [script, t], { encoding: 'utf8', timeout: 60000, windowsHide: true })))(text);
  }
  (deps.stdout ?? console.log)(json ? JSON.stringify({ results, notified: Boolean(text) }) : render(results));
  if (results.every(r => r.error)) return 3;
  return results.some(r => r.stale.length) ? 2 : 0;
}
if (isEntry(import.meta.url)) process.exitCode = await runCli();
