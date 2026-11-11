#!/usr/bin/env node
// Historical tl;dv -> Google Docs. Only tl;dv and Drive; no LLM or deletion.
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

export const CUTOFF = '2026-11-05T07:20:00Z';
export const FOLDER_ID = '1-X9Q3tD2BaGONEbYDn6LShgLpeO2rMJX';
export const IMPERSONATE = 'seisaku-team@orgiast.jp';
const TLDV_BASE = 'https://pasta.tldv.io';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const DOC_MIME = 'application/vnd.google-apps.document';
const AUTH_URL = 'file:///C:/Users/uers/Downloads/orgiast-claude-rules/tools/lib/drive-auth.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class BackfillError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// Never surface upstream bodies/errors: they may contain credentials or meeting text.
export function safeReason(error) {
  return error instanceof BackfillError ? error.code : 'unexpected-error';
}

export function parseArgs(argv) {
  const options = { limit: Infinity, dryRun: false, all: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') options.dryRun = true;
    else if (argv[i] === '--all') options.all = true;
    else if (argv[i] === '--limit') {
      const value = argv[++i];
      if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new BackfillError('limit-must-be-a-positive-integer');
      }
      options.limit = Number(value);
    } else throw new BackfillError('unknown-argument');
  }
  return options;
}

/** Five attempts total, honoring Retry-After as well as exponential backoff. */
export async function requestJson(url, init = {}, {
  fetchImpl = fetch, sleepImpl = sleep, beforeRetry, label = 'api',
} = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt && beforeRetry) {
      const recovered = await beforeRetry();
      if (recovered) return recovered;
    }
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      if (attempt === 4) throw new BackfillError(`${label}-network-error`);
      await sleepImpl(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      if (response.status === 204) return null;
      try { return await response.json(); }
      catch { throw new BackfillError(`${label}-invalid-json`); }
    }
    const status = response.status;
    const retryAfter = response.headers?.get('retry-after');
    await response.body?.cancel();
    if ((status !== 429 && (status < 500 || status > 599)) || attempt === 4) {
      throw new BackfillError(`${label}-http-${status}`);
    }
    const retryMs = retryAfter == null ? 0 : /^\d+(\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now()) || 0;
    await sleepImpl(Math.max(1000 * 2 ** attempt, retryMs));
  }
}

export function japanDate(value) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new BackfillError('invalid-meeting-date');
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

export function transcriptText(payload) {
  if (payload === null) return '';
  if (!Array.isArray(payload?.data)) throw new BackfillError('transcript-invalid-format');
  return payload.data.flatMap(item => {
    if (typeof item?.text !== 'string') throw new BackfillError('transcript-invalid-format');
    return item.text.trim() ? [`${item.speaker || '話者不明'}: ${item.text}`] : [];
  }).join('\n');
}

export function notesText(payload) {
  if (payload === null) return '（メモなし）';
  if (typeof payload?.markdownContent === 'string' && payload.markdownContent.trim()) return payload.markdownContent;
  if (Array.isArray(payload?.structuredNotes)) {
    return payload.structuredNotes.map(note => {
      if (typeof note?.text !== 'string') throw new BackfillError('notes-invalid-format');
      const topic = payload.topics?.find(topic => topic.id === note.topicId)?.title;
      return topic ? `${topic}: ${note.text}` : note.text;
    }).join('\n') || '（メモなし）';
  }
  if (payload?.markdownContent === '') return '（メモなし）';
  throw new BackfillError('notes-invalid-format');
}

export function documentContent(meeting, transcript, notes) {
  const name = `${japanDate(meeting.happenedAt)}（日本時間） ${meeting.name || '無題の会議'}`;
  const participants = (meeting.invitees || []).map(person => [person.name, person.email].filter(Boolean).join(' / '));
  const body = [meeting.name || '無題の会議', `日時: ${japanDate(meeting.happenedAt)}（日本時間）`,
    `参加者: ${participants.join('、') || '（記録なし）'}`, `tl;dv: ${meeting.url || `https://tldv.io/app/meetings/${encodeURIComponent(meeting.id)}`}`,
    '', 'メモ', notes, '', '文字起こし', transcript, ''].join('\n');
  return { name, body };
}

const queryLiteral = value => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function createClient({ apiKey, getToken, fetchImpl = fetch, driveFetch = fetchImpl, sleepImpl = sleep }) {
  const tldv = endpoint => requestJson(`${TLDV_BASE}/v1alpha1${endpoint}`, { headers: { 'x-api-key': apiKey } },
    { fetchImpl, sleepImpl, label: 'tldv' });
  // Refresh ahead of Google's one-hour expiry; concurrent workers share the refresh.
  let tokenPromise, tokenAt = 0;
  async function token() {
    if (!tokenPromise || Date.now() - tokenAt > 50 * 60_000) {
      tokenAt = Date.now();
      tokenPromise = Promise.resolve().then(() => getToken({ impersonate: IMPERSONATE })).catch(() => {
        tokenPromise = undefined;
        throw new BackfillError('drive-auth-failed');
      });
    }
    return tokenPromise;
  }
  async function drive(url, init = {}, beforeRetry) {
    return requestJson(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await token()}` } },
      { fetchImpl: driveFetch, sleepImpl, beforeRetry, label: 'drive' });
  }
  async function findExisting(id) {
    const q = `trashed = false and '${queryLiteral(FOLDER_ID)}' in parents and appProperties has { key='tldvMeetingId' and value='${queryLiteral(id)}' }`;
    const params = new URLSearchParams({ q, fields: 'files(id,name,mimeType,appProperties,webViewLink)', pageSize: '1' });
    const result = await drive(`${DRIVE_BASE}?${params}`);
    if (!Array.isArray(result.files)) throw new BackfillError('drive-invalid-file-list');
    return result.files[0];
  }
  return {
    async listMeetings() {
      const meetings = new Map();
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        const result = await tldv(`/meetings?page=${page}&limit=100`);
        if (!Array.isArray(result.results) || !Number.isInteger(result.pages) || result.pages < 0 ||
            (result.pages === 0 && result.results.length) || (result.page != null && result.page !== page)) {
          throw new BackfillError('tldv-invalid-pagination');
        }
        pages = result.pages;
        for (const meeting of result.results) {
          if (typeof meeting.id !== 'string' || !meeting.id || !Number.isFinite(Date.parse(meeting.happenedAt))) {
            throw new BackfillError('tldv-invalid-meeting');
          }
          meetings.set(meeting.id, meeting);
        }
      }
      return [...meetings.values()];
    },
    /** --all mode: iterate pages newest-first, skip meetings not yet ended, stop when 50 consecutive existing are found. */
    async listMeetingsAll({ findExisting, skipConsecutive = 50 } = {}) {
      const targets = [];
      let consecutiveExisting = 0;
      const now = Date.now();
      const minAge = 60 * 60 * 1000;
      let pages = 1;
      for (let page = 1; page <= pages; page++) {
        const result = await tldv(`/meetings?page=${page}&limit=100`);
        if (!Array.isArray(result.results) || !Number.isInteger(result.pages) || result.pages < 0 ||
            (result.pages === 0 && result.results.length) || (result.page != null && result.page !== page)) {
          throw new BackfillError('tldv-invalid-pagination');
        }
        pages = result.pages;
        for (const meeting of result.results) {
          if (typeof meeting.id !== 'string' || !meeting.id || !Number.isFinite(Date.parse(meeting.happenedAt))) {
            throw new BackfillError('tldv-invalid-meeting');
          }
          // Skip meetings that haven't ended 60+ minutes ago
          const endedAt = Date.parse(meeting.happenedAt) + (typeof meeting.duration === 'number' && Number.isFinite(meeting.duration) && meeting.duration >= 0 ? meeting.duration * 1000 : 0);
          if (endedAt > now - minAge) continue;
          if (findExisting) {
            const existing = await findExisting(meeting.id);
            if (existing) { consecutiveExisting++; if (consecutiveExisting >= skipConsecutive) return targets; continue; }
          }
          consecutiveExisting = 0;
          targets.push(meeting);
        }
      }
      return targets;
    },
    transcript: id => tldv(`/meetings/${encodeURIComponent(id)}/transcript`),
    notes: id => tldv(`/meetings/${encodeURIComponent(id)}/notes`),
    findExisting,
    async createDocument(meeting, content) {
      const boundary = `tldv_${randomUUID()}`;
      const metadata = { name: content.name, mimeType: DOC_MIME, parents: [FOLDER_ID], appProperties: { tldvMeetingId: meeting.id } };
      const body = [`--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
        `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', '', content.body, `--${boundary}--`, ''].join('\r\n');
      const file = await drive('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,appProperties,webViewLink',
        { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
        () => findExisting(meeting.id));
      if (!file?.id) throw new BackfillError('drive-create-missing-id');
      return file;
    },
  };
}

export async function runBackfill({ client, limit = Infinity, dryRun = false, all = false, out = console.log }) {
  let targets;
  if (all) {
    targets = await client.listMeetingsAll({ findExisting: client.findExisting });
    targets = targets.slice(0, limit);
  } else {
    const allMeetings = await client.listMeetings();
    targets = allMeetings.filter(meeting => Date.parse(meeting.happenedAt) < Date.parse(CUTOFF))
      .sort((a, b) => Date.parse(a.happenedAt) - Date.parse(b.happenedAt) || a.id.localeCompare(b.id)).slice(0, limit);
  }
  const summary = { created: 0, existing: 0, empty: 0, failed: 0, planned: 0, reasons: {}, files: [] };
  out(`取得 / 対象 ${targets.length}${dryRun ? '（dry-run）' : ''}${all ? '（--all）' : ''}`);
  let cursor = 0, completed = 0;
  const reason = code => { summary.reasons[code] = (summary.reasons[code] || 0) + 1; };
  async function worker() {
    while (cursor < targets.length) {
      const meeting = targets[cursor++];
      let stage = 'existing';
      try {
        if (await client.findExisting(meeting.id)) { summary.existing++; continue; }
        stage = 'transcript';
        const transcript = transcriptText(await client.transcript(meeting.id));
        if (!transcript) { summary.empty++; reason('transcript-empty'); continue; }
        stage = 'notes';
        const notes = notesText(await client.notes(meeting.id));
        stage = 'create';
        const content = documentContent(meeting, transcript, notes);
        if (dryRun) summary.planned++;
        else {
          const file = await client.createDocument(meeting, content);
          summary.created++;
          summary.files.push({ meetingId: meeting.id, ...file });
        }
      } catch (error) { summary.failed++; reason(`${stage}:${safeReason(error)}`); }
      finally {
        completed++;
        if (completed % 10 === 0) out(`進捗 ${completed}/${targets.length} 作成 ${summary.created} / 既存 ${summary.existing} / 空 ${summary.empty} / 失敗 ${summary.failed}`);
      }
    }
  }
  // Each worker issues only one HTTP request at a time, including retry lookups.
  await Promise.all([worker(), worker()]);
  if (dryRun) out(`dry-run 作成予定 ${summary.planned}`);
  for (const [code, count] of Object.entries(summary.reasons).sort()) out(`スキップ理由 ${code}: ${count}`);
  out(`作成 ${summary.created} / 既存スキップ ${summary.existing} / 空スキップ ${summary.empty} / 失敗 ${summary.failed}`);
  return summary;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    const apiKey = process.env.TLDV_API_KEY || readEnvValue(path.join(os.homedir(), '.claude', 'tldv.env'), 'TLDV_API_KEY');
    if (!apiKey) throw new BackfillError('missing-tldv-api-key');
    // The specified Windows helper is also usable from WSL via its mounted path.
    const authUrl = process.platform === 'win32' ? AUTH_URL : AUTH_URL.replace('file:///C:/', 'file:///mnt/c/');
    let auth, proxy;
    try {
      auth = await import(authUrl);
      proxy = await import(new URL('./gws-proxy.mjs', authUrl).href);
    } catch { throw new BackfillError('drive-auth-module-unavailable'); }
    const client = createClient({ apiKey, getToken: auth.getDriveToken, driveFetch: proxy.gwsFetch });
    const summary = await runBackfill({ client, ...options });
    // --all: 403 だけの失敗は許容（権限不足の会議はスキップ）
    if (options.all && summary.failed > 0) {
      const all403 = Object.keys(summary.reasons).every(r => r.endsWith('http-403'));
      return all403 ? 0 : 1;
    }
    return summary.failed ? 1 : 0;
  } catch (error) { console.error(`tldv-drive-backfill: ${safeReason(error)}`); return 1; }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
