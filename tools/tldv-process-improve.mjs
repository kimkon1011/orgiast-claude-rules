#!/usr/bin/env node
// tl;dv 会議 → 制作プロセス改善 夜間ループ
// 毎晩、前日分の tl;dv 会議記録を読み、制作プロセスの改善を抽出して社内の改善フローに自動で流し込む。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { readEnvValue } from './env-kv.mjs';

// -- 定数 --
const HOME = process.env.ORGIAST_HOME || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const STATE_DIR = path.join(CLAUDE_DIR, 'state');
function getLogDir() {
  return process.env.TLDV_PI_LOG_DIR || path.join(CLAUDE_DIR, 'logs');
}
function getLogPath() {
  return path.join(getLogDir(), 'tldv-process-improve.log');
}
const STATE_PATH = path.join(STATE_DIR, 'tldv-process-improve.json');
const CONFIG_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config', 'tldv-process-improve.json');
const AUTH_MODULE_URL = new URL('./lib/drive-auth.mjs', import.meta.url).href;
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3/files';
const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DOC_MIME = 'application/vnd.google-apps.document';

const FOLDER_ID = '1-X9Q3tD2BaGONEbYDn6LShgLpeO2rMJX';
const IMPERSONATE_DRIVE = 'seisaku-team@orgiast.jp';
const IMPERSONATE_SHEETS = 'kim@orgiast.jp';
const IMPERSONATE_GMAIL = 'seisaku-team@orgiast.jp';

// 重複判定の bigram Jaccard 閾値
const DUP_THRESHOLD = 0.6;
// 改善項目シートの直近チェック行数
const DUP_LOOKBACK = 800;
// LLM 呼び出し上限
const MAX_LLM_CALLS = 60;
// チャンクサイズ
const CHUNK_SIZE = 12000;

// -- エラー型 --
export class ProcessImproveError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function safeReason(error) {
  if (error instanceof ProcessImproveError) return error.code;
  if (error?.code === 'ENOENT') return 'file-not-found';
  if (error?.code === 'ETIMEDOUT') return 'timeout';
  return `unexpected:${error?.name || 'Error'}`;
}

// -- 子プロセス実行ヘルパー（execFile を Promise + 決まった exitCode/out/err に統一） --
export function runNode(args, { timeout = 120000, execFileImpl } = {}) {
  return new Promise(resolve => {
    const fn = execFileImpl || execFile;
    fn(process.execPath, args, { timeout, maxBuffer: 10 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// -- 設定読み込み --
export function loadConfig(configPath = CONFIG_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
    if (raw.version !== 1) throw new ProcessImproveError('unsupported-config-version');
    return raw;
  } catch (error) {
    if (error instanceof ProcessImproveError) throw error;
    throw new ProcessImproveError('config-unavailable');
  }
}

// -- 状態管理 --
export function defaultState() {
  return { version: 1, processedMeetings: {}, lastRun: null, logSheetId: null, llmCallsToday: 0 };
}

export function readState(statePath = STATE_PATH) {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { ...defaultState(), ...raw };
  } catch { return defaultState(); }
}

export function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  try { fs.renameSync(temp, statePath); } catch {
    try { fs.copyFileSync(temp, statePath); } finally { fs.rmSync(temp, { force: true }); }
  }
}

// -- ログ書き込み --
export function appendLog(entry) {
  const dir = getLogDir();
  const logPath = getLogPath();
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(logPath, line);
}

// -- 引数解析 --
export function parseArgs(argv) {
  const options = { dryRun: false, since: null, limit: Infinity, meeting: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--since') {
      const value = argv[++i];
      if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) throw new ProcessImproveError('since-must-be-ISO-date');
      options.since = new Date(value);
    } else if (arg === '--limit') {
      const value = argv[++i];
      if (!/^\d+$/.test(value || '') || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
        throw new ProcessImproveError('limit-must-be-positive-integer');
      }
      options.limit = Number(value);
    } else if (arg === '--meeting') {
      const value = argv[++i];
      if (!value) throw new ProcessImproveError('meeting-requires-doc-id');
      options.meeting = value;
    } else throw new ProcessImproveError('unknown-argument');
  }
  return options;
}

// -- HTTP ヘルパー（リトライ付き） --
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function requestJson(url, init = {}, { fetchImpl = fetch, sleepImpl = sleep, label = 'api', attempts = 5, as = 'json' } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(60_000) });
    } catch {
      if (attempt === attempts - 1) throw new ProcessImproveError(`${label}-network-error`);
      await sleepImpl(1000 * 2 ** attempt);
      continue;
    }
    if (response.ok) {
      if (response.status === 204) return null;
      try { return as === 'text' ? await response.text() : await response.json(); }
      catch { throw new ProcessImproveError(`${label}-invalid-json`); }
    }
    const status = response.status;
    await response.body?.cancel();
    if ((status !== 429 && (status < 500 || status > 599)) || attempt === attempts - 1) {
      throw new ProcessImproveError(`${label}-http-${status}`);
    }
    await sleepImpl(1000 * 2 ** attempt);
  }
}

// -- 認証トークン取得 --
export async function getDriveToken({ impersonate = IMPERSONATE_DRIVE, scope, fetchImpl = fetch } = {}) {
  const keyPath = process.env.GOOGLE_SA_KEY || path.join(HOME, '.claude', 'keys', 'aujust-sheets-reader.json');
  if (!fs.existsSync(keyPath)) throw new ProcessImproveError('drive-key-not-found');
  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const b64url = v => Buffer.from(v).toString('base64url');
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: key.client_email, sub: impersonate,
    scope: scope || 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  }));
  const { createSign } = await import('node:crypto');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const jwt = `${header}.${claims}.${signer.sign(key.private_key, 'base64url')}`;
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  });
  const json = await res.json();
  if (!json.access_token) throw new ProcessImproveError('drive-auth-failed');
  return json.access_token;
}

async function withRetryAuth(fn, impersonate, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getDriveToken({ impersonate, fetchImpl });
      return await fn(token);
    } catch (error) {
      if (attempt === 2 || !error?.message?.includes('token')) throw error;
      await sleep(1000);
    }
  }
}

// -- 認証付き Drive API 呼び出し --
async function driveFetch(url, init, token, opts = {}) {
  return requestJson(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${token}` } }, { label: 'drive', ...opts });
}

// == ソース A: Drive フォルダから会議 Doc 取得 ==
export async function fetchDriveMeetings({ since, limit, impersonate, fetchImpl = fetch, getToken: getTokenImpl } = {}) {
  const meetings = [];
  const failures = [];
  const sinceMs = since ? since.getTime() : 0;
  let token;
  if (getTokenImpl) {
    token = await getTokenImpl();
  } else {
    try {
      token = await getDriveToken({ impersonate: impersonate || IMPERSONATE_DRIVE, fetchImpl });
    } catch (error) {
      if (impersonate !== 'kim@orgiast.jp') {
        token = await getDriveToken({ impersonate: 'kim@orgiast.jp', fetchImpl });
      } else throw error;
    }
  }

  // フォルダ内の Google Doc をリスト
  const query = `trashed = false and '${FOLDER_ID}' in parents and mimeType = '${DOC_MIME}'`;
  const params = new URLSearchParams({
    q: query,
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,appProperties)',
    pageSize: String(Math.min(limit || 200, 200)),
    orderBy: 'modifiedTime desc',
  });
  if (sinceMs > 0) params.set('q', `${query} and modifiedTime > '${new Date(sinceMs).toISOString()}'`);

  const result = await driveFetch(`${DRIVE_BASE}?${params}`, {}, token, { fetchImpl });
  if (!Array.isArray(result.files)) throw new ProcessImproveError('drive-invalid-file-list');

  for (const file of result.files) {
    const meetingId = file.appProperties?.tldvMeetingId || file.id;
    if (!meetingId) continue;
    // text/plain で本文取得
    try {
      const content = await driveFetch(`${DRIVE_BASE}/${encodeURIComponent(file.id)}/export?mimeType=text/plain`, {}, token, { as: 'text', fetchImpl });
      const text = typeof content === 'string' ? content : JSON.stringify(content);
      const modified = new Date(file.modifiedTime || Date.now());
      meetings.push({
        id: meetingId,
        title: file.name || '無題の会議',
        modifiedTime: modified,
        url: file.webViewLink || '',
        source: 'drive',
        body: text,
      });
    } catch (error) {
      failures.push({ meetingId, reason: safeReason(error) });
    }
  }
  return { meetings, failures, listedCount: result.files.length };
}

// == ソース B: Gmail から tl;dv 議事録メール取得 ==
export async function fetchGmailMeetings({ since, limit, fetchImpl = fetch } = {}) {
  // Gmail API で tl;dv メールを検索
  const meetings = [];
  try {
    const token = await getDriveToken({ impersonate: IMPERSONATE_GMAIL, scope: 'https://www.googleapis.com/auth/gmail.readonly', fetchImpl });
    const query = 'from:no-reply@tldv.io';
    const sinceDays = since ? Math.ceil((Date.now() - since.getTime()) / 86400000) : 2;
    const gmailQuery = sinceDays <= 2 ? `${query} newer_than:${sinceDays}d` : `${query} after:${new Date(since.getTime()).toISOString().slice(0, 10)}`;

    // メール検索
    const searchResult = await driveFetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(gmailQuery)}&maxResults=${Math.min(limit || 20, 50)}`,
      {}, token
    );
    if (!Array.isArray(searchResult.messages)) return meetings;

    for (const msg of searchResult.messages) {
      if (meetings.length >= (limit || 20)) break;
      try {
        const detail = await driveFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
          {}, token
        );
        const payload = detail.payload || {};
        const headers = {};
        for (const h of payload.headers || []) headers[h.name?.toLowerCase()] = h.value;

        const subject = headers.subject || '';
        // tl;dv の会議IDを件名から抽出
        const meetingMatch = subject.match(/\[([A-Za-z0-9_-]+)\]/);
        const meetingId = meetingMatch ? meetingMatch[1] : `gmail-${msg.id}`;

        // メール本文を抽出
        const bodyParts = payload.parts || [];
        let bodyText = '';
        for (const part of bodyParts) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            bodyText = Buffer.from(part.body.data, 'base64url').toString('utf8');
            break;
          }
        }
        if (!bodyText) {
          // 1階層下の parts
          for (const part of bodyParts) {
            if (Array.isArray(part.parts)) {
              for (const sub of part.parts) {
                if (sub.mimeType === 'text/plain' && sub.body?.data) {
                  bodyText = Buffer.from(sub.body.data, 'base64url').toString('utf8');
                  break;
                }
              }
            }
            if (bodyText) break;
          }
        }

        const dateHeader = headers.date || headers['x-received'] || new Date().toISOString();
        meetings.push({
          id: meetingId,
          title: subject,
          modifiedTime: new Date(dateHeader),
          url: `https://mail.google.com/#inbox/${msg.id}`,
          source: 'gmail',
          body: bodyText || '',
        });
      } catch {
        continue; // 個別のメール取得失敗はスキップ
      }
    }
  } catch {
    // Gmail 取得失敗は致命的ではない
    appendLog({ event: 'gmail-fetch-warning', error: 'Gmail API unavailable, skipping source B' });
  }
  return meetings;
}

// -- 重複除去（会議ID + 日付） --
export function deduplicateMeetings(meetings, state) {
  const seen = new Set(Object.keys(state.processedMeetings || {}));
  return meetings.filter(m => !seen.has(m.id));
}

// -- 会議の日付を抽出（名前/本文 → modifiedTime フォールバック） --
export function extractMeetingDate(meeting) {
  const title = meeting.title || '';
  let match = title.match(/(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/);
  if (match) return new Date(match[1] + 'T00:00:00Z');
  const body = (meeting.body || '').slice(0, 200);
  match = body.match(/(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}/);
  if (match) return new Date(match[1] + 'T00:00:00Z');
  return meeting.modifiedTime;
}

// -- LLM 呼び出し（子プロセスで llm-ask.mjs） --
export async function callLlm(prompt, { provider, model, config, fetchImpl = fetch, execFileImpl } = {}) {
  const llmAskPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');
  if (!fs.existsSync(llmAskPath)) throw new ProcessImproveError('llm-ask-not-found');

  const promptFile = path.join(getLogDir(), `.llm-prompt-${randomUUID()}.txt`);
  const providersToTry = ['gemini', 'deepseek', 'groq'];

  try {
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, prompt, 'utf8');

    let lastError = null;
    for (const currentProvider of providersToTry) {
      const args = [
        llmAskPath,
        '--provider', currentProvider,
        '--prompt-file', promptFile,
        '--max', '8192',
        '--category', 'extraction',
      ];
      if (model) args.push('--model', model);

      try {
        const result = await runNode(args, { timeout: 120_000, execFileImpl });
        const stdout = String(result.stdout || '').trim();
        if (result.exitCode !== 0 && !stdout) {
          lastError = new ProcessImproveError('llm-failed');
          continue;
        }
        return stdout;
      } catch (error) {
        lastError = error;
        continue;
      }
    }
    throw lastError || new ProcessImproveError('llm-failed');
  } finally {
    try { fs.rmSync(promptFile, { force: true }); } catch {}
  }
}

// -- テキストをチャンク分割 --
export function chunkText(text, maxChars = CHUNK_SIZE) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf('\n', maxChars);
    if (splitAt < maxChars / 2) splitAt = remaining.lastIndexOf('。', maxChars);
    if (splitAt < maxChars / 2) splitAt = maxChars;
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// -- bigram Jaccard 類似度 --
function bigramSet(text) {
  const s = new Set();
  for (let i = 0; i < text.length - 1; i++) s.add(text.slice(i, i + 2));
  return s;
}

function jaccardSimilarity(a, b) {
  const sa = bigramSet(a), sb = bigramSet(b);
  if (!sa.size && !sb.size) return 1;
  let intersection = 0;
  for (const item of sa) if (sb.has(item)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union ? intersection / union : 0;
}

export function normalizeText(text) {
  let result = String(text ?? '');
  result = result.normalize('NFKC');
  result = result.replace(/\s|\p{P}|\p{S}|\p{Cf}/gu, '');
  return result.toLowerCase();
}

// -- 会議タイトル正規化（同一会議の異表記を統一） --
export function normalizeTitle(title) {
  let t = String(title ?? '');
  t = t.replace(/\d{4}[-/]\d{2}[-/]\d{2}\s+\d{2}:\d{2}/g, '');
  t = t.replace(/[（(][^)）]*?時間[)）]/g, '');
  t = t.replace(/[「」✅❌]/g, '');
  t = t.replace(/の会議ノートとAI回答が準備できました$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return normalizeText(t);
}

// -- 重複ソースのマージ（同一会議の Gmail 分を除去） --
export function mergeDuplicateSources(driveMeetings, gmailMeetings) {
  const driveNorm = new Map();
  for (const m of driveMeetings) {
    const nt = normalizeTitle(m.title);
    if (!driveNorm.has(nt)) driveNorm.set(nt, m.id);
  }
  const skipped = [];
  const filteredGmail = gmailMeetings.filter(gm => {
    const nt = normalizeTitle(gm.title);
    if (driveNorm.has(nt)) {
      skipped.push({ meetingId: gm.id, title: gm.title });
      return false;
    }
    return true;
  });
  return { merged: [...driveMeetings, ...filteredGmail], skippedDuplicateSource: skipped };
}

// -- スプレッドシートの sheetId → タブ名解決（共通関数） --
export async function resolveTabName(spreadsheetId, targetSheetId, { token, fetchImpl = fetch } = {}) {
  const metadata = await driveFetch(
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties`,
    {}, token, { fetchImpl, label: 'sheet-meta' }
  );
  const sheets = metadata.sheets || [];
  const target = sheets.find(s => s.properties?.sheetId === targetSheetId);
  if (!target || !target.properties?.title) throw new ProcessImproveError('sheet-tab-not-found');
  return target.properties.title;
}

// -- 重複判定（既存シートの直近N行の事象/解決策と比較） --
export async function fetchExistingImprovements({ impersonate = IMPERSONATE_SHEETS, fetchImpl = fetch, dryRun = false } = {}) {
  const config = loadConfig();
  const spreadsheetId = config.sheets.improvementSheetId;
  const targetSheetId = config.sheets.improvementTabGid; // 354072335
  const token = await getDriveToken({ impersonate, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly', fetchImpl });

  // 1. スプレッドシートのメタデータから sheetId → タブ名を解決
  let tabName;
  try {
    tabName = await resolveTabName(spreadsheetId, targetSheetId, { token, fetchImpl });
  } catch (error) {
    const status = error.code ? (error.code.includes('http-') ? error.code.split('-').pop() : 'meta-error') : 'unknown';
    appendLog({ event: 'existing-fetch-error', status, error: safeReason(error) });
    if (!dryRun) throw new ProcessImproveError('existing-fetch-error');
    return [];
  }

  const safeTabName = `'${tabName.replace(/'/g, "''")}'`;

  // 2. データ行を A3:J で読み、末尾800行のみ抽出（1行目集計・2行目ヘッダーをスキップ）
  let result;
  try {
    result = await driveFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(`${safeTabName}!A3:J`)}?valueRenderOption=FORMATTED_VALUE`,
      {}, token, { fetchImpl, label: 'sheet-values' }
    );
  } catch (error) {
    const status = error.code ? (error.code.includes('http-') ? error.code.split('-').pop() : 'values-error') : 'unknown';
    appendLog({ event: 'existing-fetch-error', status, error: safeReason(error) });
    if (!dryRun) throw new ProcessImproveError('existing-fetch-error');
    return [];
  }

  // 3. 末尾最大800行の F（事象=index5）と H（対策=index7）を抽出
  const dataRows = (result.values || []).slice(-DUP_LOOKBACK);
  const rows = [];
  for (const row of dataRows) {
    rows.push({ event: String(row[5] || ''), solution: String(row[7] || '') });
  }
  appendLog({ event: 'existing-loaded', count: rows.length, tabName });
  return rows;
}

export function isDuplicate(candidate, existing) {
  const cNorm = normalizeText((candidate.event || '') + (candidate.solution || ''));
  for (const ex of existing) {
    const eNorm = normalizeText((ex.event || '') + (ex.solution || ''));
    if (jaccardSimilarity(cNorm, eNorm) >= DUP_THRESHOLD) return true;
  }
  return false;
}

// -- 会議テキストから改善項目を LLM 抽出 --
export async function extractImprovements(meeting, { config, state, fetchImpl = fetch, execFileImpl } = {}) {
  const conf = config || loadConfig();
  const today = new Date().toISOString().slice(0, 10);
  const body = meeting.body || '';

  // チャンク分割
  const chunks = chunkText(body, CHUNK_SIZE);

  const allItems = [];
  const seenInCall = []; // 同一呼び出し内の重複除去用
  for (const chunk of chunks) {
    if (state && state.llmCallsToday >= MAX_LLM_CALLS) {
      appendLog({ event: 'llm-limit-reached', meetingId: meeting.id });
      break;
    }

    const prompt = buildAnalysisPrompt(chunk, meeting, today);
    const response = await callLlm(prompt, { provider: 'gemini', fetchImpl, execFileImpl });

    // JSON パース（フェンス除去＋truncated JSON 救済）
    let jsonText = response;
    jsonText = jsonText.replace(/^```json?\s*/m, '').replace(/\s*```\s*$/m, '');
    jsonText = jsonText.trim();
    if (!jsonText.endsWith(']') && jsonText.startsWith('[')) {
      const lastCloseBrace = jsonText.lastIndexOf('}');
      if (lastCloseBrace >= 0) {
        jsonText = jsonText.slice(0, lastCloseBrace + 1) + ']';
      }
    }
    try {
      const items = JSON.parse(jsonText);
      if (!Array.isArray(items)) continue;

      for (const item of items) {
        if (typeof item.confidence === 'number' && item.confidence >= (conf.llm?.confidenceThreshold || 0.6)) {
          // 同一 extractImprovements 呼び出し内の重複除去（チャンクまたぎ）
          // 同じチャンク内では exact match（Jaccard は短い文字列で過剰検出するため）
          const itemKey = (item.event || '') + '\0' + (item.solution || '');
          const seenKey = (seenInCall.map(s => (s.event || '') + '\0' + (s.solution || '')));
          if (seenKey.includes(itemKey)) continue;
          seenInCall.push({ event: item.event, solution: item.solution });
          item.caseName = meeting.title;
          item.meetingId = meeting.id;
          item.meetingUrl = meeting.url;
          allItems.push(item);
        }
      }
    } catch {
      appendLog({ event: 'llm-parse-error', meetingId: meeting.id });
    }

    if (state) {
      state.llmCallsToday = (state.llmCallsToday || 0) + 1;
    }
  }
  return allItems;
}

// -- 分析プロンプト構築 --
function buildAnalysisPrompt(chunk, meeting, today) {
  return `あなたは制作プロセスの改善アナリストです。以下の会議の文字起こしから、制作プロセス改善に役立つ情報を抽出してください。

抽出対象：
- トラブル・ミス・手戻り
- 「次回から」「今後は」「ルールにしよう」等の決定
- アプリ/パネルへの要望
- 現場ノウハウ
- テンプレートやマニュアルの修正案

除外：
- 雑談
- 顧客向け提案内容そのもの
- 会議で出ていない値を決定事項として作り出さない

会議情報：
- 会議名: ${meeting.title || '無題の会議'}
- 日付: ${meeting.modifiedTime?.toISOString?.() || today}

文字起こし：
${chunk}

1チャンク最大10件まで・各フィールドは簡潔に出力してください。

以下の JSON 配列形式で出力してください：
[
  {
    "kind": "app|template|knowhow|manual|process",
    "event": "事象の説明",
    "solution": "解決策・改善方法（会議で決まっていなければ空欄）",
    "cause": "発生原因（分かる範囲）",
    "decided": trueまたはfalse（会議で決定済みか）,
    "target": "該当テンプレート名またはアプリ機能名または施工カテゴリ",
    "evidence": "発言の短い引用",
    "confidence": 0.0〜1.0
  }
]

kind の意味:
- app: アプリ改善要望
- template: テンプレート修正案
- knowhow: ノウハウ（施工系含む）
- manual: マニュアル修正案
- process: 作業フローの改善

target に使えるテンプレート名:
実施計画書テンプレートver2 / 実施計画書テンプレート（追加パーツ） / 提出フォーマットver2 / 学会タスク進捗管理表 / Reブースタスク進捗管理表 / 見積テンプレート / コンテンツシート倉庫 / Taskシートテンプレート倉庫 / 保有機材リスト(Slides) / 備品管理表 / 社内マニュアル(Growi)

confidence が 0.6 未満の項目は含めないでください。`;
}

// -- 改善項目シートへの書き込み --
export async function writeImprovementSheet(items, { token, dryRun = false, fetchImpl = fetch } = {}) {
  const config = loadConfig();
  const sheetId = config.sheets.improvementSheetId;
  const targetSheetId = config.sheets.improvementTabGid;

  // JST 日時（yyyy/MM/dd HH:mm:ss）
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const dateStr = `${jst.getUTCFullYear()}/${(jst.getUTCMonth() + 1).toString().padStart(2, '0')}/${jst.getUTCDate().toString().padStart(2, '0')} ${jst.getUTCHours().toString().padStart(2, '0')}:${jst.getUTCMinutes().toString().padStart(2, '0')}:${jst.getUTCSeconds().toString().padStart(2, '0')}`;

  // 1. タブ名解決
  const tabName = await resolveTabName(sheetId, targetSheetId, { token, fetchImpl });
  const safeTabName = `'${tabName.replace(/'/g, "''")}'`;

  // 2. ヘッダー検証（2行目 A2:H2）
  const headerRange = `${safeTabName}!A2:H2`;
  const headerResult = await driveFetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(headerRange)}?valueRenderOption=FORMATTED_VALUE`,
    {}, token, { fetchImpl }
  );
  const headers = (headerResult.values?.[0] || []).map(h => String(h || '').trim());
  const expectedHeaders = config.sheets.improvementHeaders;
  if (headers.length !== expectedHeaders.length) {
    appendLog({ event: 'header-mismatch', expected: expectedHeaders, actual: headers });
    throw new ProcessImproveError('sheet-header-mismatch');
  }
  for (let i = 0; i < expectedHeaders.length; i++) {
    if (headers[i] !== expectedHeaders[i]) {
      appendLog({ event: 'header-mismatch', expected: expectedHeaders[i], actual: headers[i] });
      throw new ProcessImproveError('sheet-header-mismatch');
    }
  }

  // 3. 最終行を A1:J から算出（どの列にでも値がある最後の行 + 1）
  const allResult = await driveFetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(`${safeTabName}!A1:J`)}?valueRenderOption=FORMATTED_VALUE`,
    {}, token, { fetchImpl }
  );
  const allValues = allResult.values || [];
  let lastNonEmptyRow = 2; // 最低でもヘッダー行
  for (let i = allValues.length - 1; i >= 0; i--) {
    const row = allValues[i] || [];
    if (row.some(cell => String(cell ?? '').trim().length > 0)) {
      lastNonEmptyRow = i + 1;
      break;
    }
  }
  const writeStartRow = lastNonEmptyRow + 1;

  // 4. batchUpdate 用データ生成（A:B / D:E / F:H の3範囲）
  const kindJp = { app: 'アプリ改善', template: 'テンプレート修正', knowhow: 'ノウハウ', manual: 'マニュアル修正', process: '業務フロー' };
  const abValues = [];
  const deValues = [];
  const fghValues = [];

  for (const item of items) {
    const kj = kindJp[item.kind] || item.kind;
    const meetingName = (item.caseName || '').replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}（日本時間）\s*/, '');
    const eventText = `【${kj}】${item.event || ''}`;
    const causeText = item.cause || '';
    const solutionText = `${item.solution || ''}［出典: tl;dv ${item.meetingUrl || ''}］`;

    abValues.push([dateStr, 'tl;dv自動抽出']);
    deValues.push([meetingName, '問題']);
    fghValues.push([eventText, causeText, solutionText]);
  }

  if (dryRun) {
    const plannedRows = items.map((item, i) => {
      const kj = kindJp[item.kind] || item.kind;
      const meetingName = (item.caseName || '').replace(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}（日本時間）\s*/, '');
      return {
        row: writeStartRow + i,
        A: dateStr,
        B: 'tl;dv自動抽出',
        D: meetingName,
        E: '問題',
        F: `【${kj}】${item.event || ''}`,
        G: item.cause || '',
        H: `${item.solution || ''}［出典: tl;dv ${item.meetingUrl || ''}］`,
      };
    });
    return { planned: items.length, writeStartRow, tabName, rows: plannedRows };
  }

  // 5. batchUpdate 書き込み
  const batchBody = {
    valueInputOption: 'USER_ENTERED',
    data: [
      { range: `${safeTabName}!A${writeStartRow}:B${writeStartRow + items.length - 1}`, majorDimension: 'ROWS', values: abValues },
      { range: `${safeTabName}!D${writeStartRow}:E${writeStartRow + items.length - 1}`, majorDimension: 'ROWS', values: deValues },
      { range: `${safeTabName}!F${writeStartRow}:H${writeStartRow + items.length - 1}`, majorDimension: 'ROWS', values: fghValues },
    ],
  };
  await driveFetch(
    `${SHEETS_BASE}/${sheetId}/values:batchUpdate`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batchBody) },
    token, { fetchImpl }
  );

  // 6. 読み戻し確認（F と H）
  const verifyRange = `${safeTabName}!F${writeStartRow}:H${writeStartRow + items.length - 1}`;
  const verify = await driveFetch(
    `${SHEETS_BASE}/${sheetId}/values/${encodeURIComponent(verifyRange)}?valueRenderOption=FORMATTED_VALUE`,
    {}, token, { fetchImpl }
  );
  const writtenF = (verify.values || []).map(r => String(r[0] || ''));
  const writtenH = (verify.values || []).map(r => String(r[2] || ''));
  for (let i = 0; i < items.length; i++) {
    if (writtenF[i] !== fghValues[i][0] || writtenH[i] !== fghValues[i][2]) {
      appendLog({ event: 'write-verification-failed', idx: i, expectedF: fghValues[i][0], actualF: writtenF[i] });
      throw new ProcessImproveError('write-verification-failed');
    }
  }

  return { written: items.length, writeStartRow };
}

// -- ログシートの作成または取得 --
export async function ensureLogSheet({ token, state, fetchImpl = fetch, summary } = {}) {
  if (state.logSheetId) return state.logSheetId;

  const config = loadConfig();
  // 初回作成
  const body = {
    properties: { title: '制作プロセス改善ログ（tl;dv自動）' },
    sheets: [
      { properties: { title: '抽出ログ', gridProperties: { rowCount: 1000, columnCount: 12 } } },
      { properties: { title: 'テンプレート反映案', gridProperties: { rowCount: 200, columnCount: 8 } } },
      { properties: { title: '実行サマリ', gridProperties: { rowCount: 500, columnCount: 10 } } },
    ],
  };
  const result = await driveFetch(
    `${SHEETS_BASE}?fields=spreadsheetId,spreadsheetUrl`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    token, { fetchImpl }
  );
  if (!result.spreadsheetId) throw new ProcessImproveError('log-sheet-create-failed');

  // 作成直後に各タブの1行目へ見出しを書き込む
  const extractionHeaders = ['実行日時', '会議名', '会議日', '種別', '案件', '事象', '解決策', '決定済み', '対象', '引用', '確信度', '反映結果'];
  const templateHeaders = ['作成日', '対象テンプレート', '会議', '修正案', '根拠引用', '状態'];
  const summaryHeaders = ['実行日時', '取得', '処理', '抽出', '重複', 'シート反映', '要望', 'ノウハウ', '失敗', 'エラー'];
  try {
    await driveFetch(`${SHEETS_BASE}/${result.spreadsheetId}/values/抽出ログ!A1:${String.fromCharCode(64 + extractionHeaders.length)}1?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `抽出ログ!A1:${String.fromCharCode(64 + extractionHeaders.length)}1`, values: [extractionHeaders] }) },
      token, { fetchImpl }
    );
    await driveFetch(`${SHEETS_BASE}/${result.spreadsheetId}/values/テンプレート反映案!A1:F1?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `テンプレート反映案!A1:F1`, values: [templateHeaders] }) },
      token, { fetchImpl }
    );
    await driveFetch(`${SHEETS_BASE}/${result.spreadsheetId}/values/実行サマリ!A1:J1?valueInputOption=USER_ENTERED`,
      { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: `実行サマリ!A1:J1`, values: [summaryHeaders] }) },
      token, { fetchImpl }
    );
  } catch { /* 見出し書き込み失敗はベストエフォート */ }

  // kim@orgiast.jp に writer 権限を付与し、読み戻して確認
  try {
    await driveFetch(
      `https://www.googleapis.com/drive/v3/files/${result.spreadsheetId}/permissions`,
      { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'writer', emailAddress: 'kim@orgiast.jp' }) },
      token, { fetchImpl }
    );
    // 読み戻し確認
    const permCheck = await driveFetch(
      `${DRIVE_BASE}/${result.spreadsheetId}/permissions?fields=permissions(emailAddress,role)`,
      {}, token, { fetchImpl }
    );
    const perms = (permCheck?.permissions || []);
    const kimPerm = perms.find(p => p.emailAddress === 'kim@orgiast.jp');
    if (!kimPerm || !['writer', 'owner'].includes(kimPerm.role)) {
      if (summary) summary.failed++;
      appendLog({ event: 'log-sheet-permission-error', actual: kimPerm ? kimPerm.role : 'no-permission' });
    }
  } catch {
    if (summary) summary.failed++;
    appendLog({ event: 'log-sheet-permission-error' });
  }

  state.logSheetId = result.spreadsheetId;
  try { writeState(STATE_PATH, state); } catch { /* state 保存失敗はベストエフォート */ }
  return result.spreadsheetId;
}

// -- テンプレート反映案タブへの書き込み（kind=template の項目） --
export async function writeTemplateReflection(items, { token, logSheetId, fetchImpl = fetch } = {}) {
  const now = new Date().toISOString();
  const templateItems = items.filter(i => i.kind === 'template');
  if (templateItems.length === 0) return 0;

  const values = templateItems.map(item => [
    now,
    item.target || '',
    item.caseName || '',
    item.solution || '',
    item.evidence || '',
    '未反映',
  ]);
  const range = `'テンプレート反映案'!A1`;
  await driveFetch(
    `${SHEETS_BASE}/${encodeURIComponent(logSheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `'テンプレート反映案'!A1`, values, majorDimension: 'ROWS' }) },
    token, { fetchImpl }
  );
  return templateItems.length;
}

// -- ログシートへの書き込み --
export async function writeLogEntry({ token, logSheetId, entry, fetchImpl = fetch } = {}) {
  const today = new Date().toISOString();
  const values = [[
    today,                                                          // 実行日時
    entry.meetingName || '',                                        // 会議名
    entry.meetingDate || '',                                        // 会議日
    entry.kind || '',                                               // kind
    entry.caseName || '',                                           // 案件
    entry.event || '',                                              // 事象
    entry.solution || '',                                           // 解決策
    entry.decided ? '✓' : '',                                       // decided
    entry.target || '',                                             // target
    entry.evidence || '',                                           // 引用
    String(entry.confidence || ''),                                 // confidence
    entry.reflectionResult || '',                                   // 反映先/結果
  ]];
  const range = `'抽出ログ'!A1`;
  await driveFetch(
    `${SHEETS_BASE}/${encodeURIComponent(logSheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `'抽出ログ'!A1`, values, majorDimension: 'ROWS' }) },
    token, { fetchImpl }
  );
}

// -- 実行サマリの書き込み --
export async function writeRunSummary({ token, logSheetId, summary, fetchImpl = fetch } = {}) {
  const values = [[
    new Date().toISOString(),
    String(summary.fetched || 0),
    String(summary.processed || 0),
    String(summary.extracted || 0),
    String(summary.duplicates || 0),
    String(summary.sheetWritten || 0),
    String(summary.feedbackSent || 0),
    String(summary.knowhowAdded || 0),
    String(summary.failed || 0),
    summary.error || '',
  ]];
  const range = `'実行サマリ'!A1`;
  await driveFetch(
    `${SHEETS_BASE}/${encodeURIComponent(logSheetId)}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: `'実行サマリ'!A1`, values, majorDimension: 'ROWS' }) },
    token, { fetchImpl }
  );
}

// -- kim-inbox への通知 --
// kim-inbox.mjs CLI: --add --kind <kind> --body-file <file> --source <name> [--key <key>]
export async function notifyKimInbox(summary, logSheetUrl) {
  const inboxPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kim-inbox.mjs');
  if (!fs.existsSync(inboxPath)) return;

  if (summary.totalItems === 0) {
    // 0件の夜は通知しない
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const body = `tl;dv 制作プロセス改善 ${today}

取得会議: ${summary.fetched}
処理会議: ${summary.processed}
抽出項目: ${summary.extracted}
重複除去: ${summary.duplicates}
シート反映: ${summary.sheetWritten}
アプリ要望: ${summary.feedbackSent}
ノウハウ追加: ${summary.knowhowAdded}
失敗: ${summary.failed}

ログシート: ${logSheetUrl}?authuser=kim@orgiast.jp`;

  // 本文を一時ファイルに書き、CLI 経由で kim-inbox に追加
  const tmpFile = path.join(getLogDir(), `.kim-inbox-body-${randomUUID()}.txt`);
  try {
    fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
    fs.writeFileSync(tmpFile, body, 'utf8');
    await runNode([
      inboxPath,
      '--add', '--kind', 'info',
      '--body-file', tmpFile,
      '--source', 'tldv-process-improve',
      '--key', `tldv-process-improve-${today}`,
    ], { timeout: 30_000 });
  } catch { /* 通知失敗はベストエフォート */ }
  finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch {}
  }
}

// -- app 向けフィードバック投稿（kind=app） --
// GAS /exec に JSON POST → FeedbackApi_submitFromDialog({kind,title,body,submitId,reporter})
export async function postAppFeedback(items, { dryRun = false, fetchImpl = fetch } = {}) {
  const config = loadConfig();
  const feedbackApi = config.feedbackApi;
  const rawUrl = process.env.BOOTH_FEEDBACK_URL || feedbackApi?.url || '';
  // 未解決のテンプレート変数（{{...}}）は有効なURLとみなさない
  const url = rawUrl.startsWith('http') ? rawUrl : '';
  if (!feedbackApi || !url) return 0;

  let posted = 0;
  for (const item of items) {
    if (posted >= (feedbackApi.maxPerNight || 5)) break;
    if (item.kind !== 'app') continue;

    const title = (item.event || '').slice(0, 100);
    const body = `【事象】${item.event}\n【解決策】${item.solution || '（未定）'}\n【出典】tl;dv ${item.caseName || ''}\n【引用】${item.evidence || ''}`;
    const submitId = `tldv-${item.meetingId || ''}-${String(item.event || '').slice(0, 20).replace(/[^a-z0-9]/gi, '')}`;

    if (dryRun) { posted++; continue; }

    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'submitFeedbackDialog',
          kind: '要望',
          title,
          body,
          submitId,
          reporter: 'tl;dv自動抽出',
        }),
      });
      if (res.ok) posted++;
    } catch {
      continue;
    }
  }
  return posted;
}

// -- knowhow 登録（kind=knowhow かつ施工系） --
// booth-cmd.mjs usage: node booth-cmd.mjs <command> '<json args array>' （引数は配列のJSON）
// GAS ConstructionKnowhow_add(entry) → entry={category,type,phase,condition?,title,body,steps?,source?,status?}
// CommandQueue の result 形式: { ok: true, command, result: <戻り値> } または { ok: false, command, error }
export async function addConstructionKnowhow(items, { dryRun = false, fetchImpl = fetch, cmdPath: cmdPathOpt, runNode: runNodeImpl } = {}) {
  const config = loadConfig();
  const cmdPath = cmdPathOpt || path.join(HOME, '.claude', 'tools-local', 'booth-cmd.mjs');
  const runNodeFn = runNodeImpl || runNode;

  // dry-run は booth-cmd が要らないので先にカウントして返す
  if (dryRun) {
    let count = 0;
    for (const item of items) {
      if (count >= (config.knowhow?.maxPerNight || 5)) break;
      if (item.kind !== 'knowhow') continue;
      count++;
    }
    return count;
  }

  // runNodeImpl が注入されている場合は実行経路を呼び出し側が制御するため、ファイル存在確認をスキップ
  if (!runNodeImpl && !fs.existsSync(cmdPath)) return 0;

  let added = 0;
  for (const item of items) {
    if (added >= (config.knowhow?.maxPerNight || 5)) break;
    if (item.kind !== 'knowhow') continue;

    // entry object: category,type,phase must be set. Others are detected from meeting content.
    const entry = [{
      category: item.target || '施工ノウハウ',
      type: '注意',
      phase: '共通',
      title: (item.event || '').slice(0, 80),
      body: `${item.solution || ''}\n\n出典: tl;dv ${item.caseName || ''}`,
      source: `tl;dv ${item.caseName || ''}`,
      status: '要確認',
    }];
    const argsFile = path.join(getLogDir(), `.knowhow-args-${randomUUID()}.json`);
    try {
      fs.writeFileSync(argsFile, JSON.stringify(entry), 'utf8');
      const result = await runNodeFn([cmdPath, 'ConstructionKnowhow_add', `@${argsFile}`], { timeout: 120_000 });
      if (result.exitCode === 0) {
        // CommandQueue result format: { ok: true, command, result: <戻り値> }
        try {
          const output = JSON.parse(result.stdout);
          if (output && output.ok === true && output.result) added++;
          else {
            appendLog({ event: 'knowhow-add-error', exitCode: result.exitCode, ok: output?.ok, stdout: (result.stdout || '').slice(0, 200), stderr: (result.stderr || '').slice(0, 200) });
          }
        } catch {
          appendLog({ event: 'knowhow-add-error', exitCode: result.exitCode, stdout: (result.stdout || '').slice(0, 200), stderr: (result.stderr || '').slice(0, 200) });
        }
      } else {
        appendLog({ event: 'knowhow-add-error', exitCode: result.exitCode, stderr: (result.stderr || '').slice(0, 200) });
      }
    } catch (error) {
      appendLog({ event: 'knowhow-add-error', exitCode: -1, error: safeReason(error) });
    } finally {
      try { fs.rmSync(argsFile, { force: true }); } catch {}
    }
  }
  return added;
}

// -- メイン実行ロジック --
export async function runImprove(options = {}, dependencies = {}) {
  const fetchImpl = dependencies.fetch || fetch;
  const execFileImpl = dependencies.execFile;
  const opts = { ...options };
  const config = loadConfig();
  let state = readState(STATE_PATH);
  // dry-run では状態を更新しない
  const persistState = !opts.dryRun && state;

  const summary = {
    fetched: 0, processed: 0, extracted: 0, duplicates: 0, skippedOld: 0,
    skippedDuplicateSource: 0, skippedExcluded: 0,
    sheetWritten: 0, feedbackSent: 0, knowhowAdded: 0, templateReflected: 0, failed: 0,
    totalItems: 0, error: '',
  };
  const allItems = [];
  const processedIds = [];

  try {
    // -- 会議取得 --
    const since = opts.since || (state.lastRun ? new Date(state.lastRun) : new Date(Date.now() - 7 * 86400000));

    let meetings = [];
    let driveMeetings = [];
    let driveListed = 0;
    let driveFetchedCount = 0;
    let driveExportFailCount = 0;
    try {
      const result = await fetchDriveMeetings({ since, limit: opts.limit || Infinity, fetchImpl });
      driveMeetings = result.meetings;
      driveFetchedCount = result.meetings.length;
      meetings.push(...result.meetings);
      driveListed = result.listedCount;
      driveExportFailCount = result.failures.length;
      for (const f of result.failures) {
        summary.failed++;
        appendLog({ event: 'drive-export-error', meetingId: f.meetingId, error: f.reason });
      }
    } catch (error) {
      summary.failed++;
      summary.error = safeReason(error);
      appendLog({ event: 'drive-fetch-error', error: safeReason(error) });
      return 2;
    }
    appendLog({ event: 'source-fetched', source: 'drive', count: driveFetchedCount });

    // 一覧は取れたが本文が1件も取れなかった → 致命的
    const isAllExportFailed = driveListed > 0 && driveFetchedCount === 0 && driveExportFailCount >= driveListed;
    if (isAllExportFailed && !summary.error) {
      summary.error = 'all-drive-exports-failed';
      appendLog({ event: 'all-exports-failed', listed: driveListed, exportFailed: driveExportFailCount });
      return 2;
    }

    let gmailMeetings = [];
    try {
      gmailMeetings = await fetchGmailMeetings({ since, limit: opts.limit || Infinity, fetchImpl });
    } catch (error) {
      summary.failed++;
      appendLog({ event: 'gmail-fetch-error', error: safeReason(error) });
    }
    appendLog({ event: 'source-fetched', source: 'gmail', count: gmailMeetings.length });

    // -- 同一会議の重複除去（Gmail 分を Drive に統合） --
    const { merged, skippedDuplicateSource } = mergeDuplicateSources(driveMeetings, gmailMeetings);
    meetings = merged;
    summary.skippedDuplicateSource = skippedDuplicateSource.length;

    // meetings から driveMeetings を取り出す（driveSkippedOld 計算用）
    // (driveMeetings は既に保持)

    // -- 古い会議をスキップ（再保存で modifiedTime が更新されたもの） --
    const beforeOld = meetings.length;
    meetings = meetings.filter(m => {
      const meetingDate = extractMeetingDate(m);
      return !meetingDate || meetingDate >= since;
    });
    const skippedOld = beforeOld - meetings.length;
    summary.skippedOld = skippedOld;
    const driveSkippedOld = driveMeetings.length - driveMeetings.filter(m => {
      const meetingDate = extractMeetingDate(m);
      return !meetingDate || meetingDate >= since;
    }).length;

    summary.fetched = meetings.length;

    // -- 重複除去（既処理会議をスキップ） --
    const newMeetings = deduplicateMeetings(meetings, state);
    summary.processed = newMeetings.length;

    // 母数の合計一致ログ
    // 等式1: listed = fetched + exportFailed + skippedOld（Drive 側: driveListed = driveFetchedCount + driveExportFailCount + driveSkippedOld）
    // 等式2: fetched = processed + skippedAlreadyDone（全体）
    const skippedAlreadyDone = meetings.length - newMeetings.length;
    console.log(`Drive: listed=${driveListed} fetched=${driveFetchedCount} exportFailed=${driveExportFailCount} skippedOld=${driveSkippedOld} | All: fetched=${summary.fetched} processed=${summary.processed} skippedAlreadyDone=${skippedAlreadyDone} skippedOld=${skippedOld} skippedDupSource=${summary.skippedDuplicateSource} skippedExcluded=${summary.skippedExcluded}`);

    if (opts.meeting) {
      // 特定会議のみ処理
      const specific = meetings.find(m => m.id === opts.meeting || m.title.includes(opts.meeting));
      if (specific) {
        newMeetings.length = 0;
        newMeetings.push(specific);
        summary.processed = 1;
      }
    }

    // -- 既存改善項目を取得 --
    let existingItems = [];
    try {
      existingItems = await fetchExistingImprovements({ fetchImpl, dryRun: opts.dryRun });
    } catch (error) {
      if (!opts.dryRun) {
        summary.error = 'existing-fetch-error';
        appendLog({ event: 'existing-fetch-error', error: safeReason(error) });
        return 2;
      }
      appendLog({ event: 'existing-fetch-warning', error: 'Could not fetch existing improvements' });
    }

    // -- 各会議を LLM 解析 --
    const excludePatterns = config.excludeTitlePatterns || [];
    for (const meeting of newMeetings.slice(0, opts.limit || Infinity)) {
      if (state && state.llmCallsToday >= MAX_LLM_CALLS) break;

      // 除外パターンに一致する会議はスキップ
      const matchedPattern = excludePatterns.find(p => (meeting.title || '').includes(p));
      if (matchedPattern) {
        summary.skippedExcluded++;
        appendLog({ event: 'skipped-excluded', meetingId: meeting.id, pattern: matchedPattern });
        continue;
      }

      try {
        const items = await extractImprovements(meeting, { config, state, fetchImpl, execFileImpl });
        for (const item of items) {
          // 重複チェック
          if (isDuplicate(item, existingItems)) {
            summary.duplicates++;
            continue;
          }
          allItems.push(item);
          existingItems.push({ event: item.event, solution: item.solution });
        }
        summary.extracted += items.length;
        // 抽出成功した会議IDを記録（全書き込み成功後に state へ保存）
        processedIds.push(meeting.id);
      } catch (error) {
        summary.failed++;
        appendLog({ event: 'meeting-process-error', meetingId: meeting.id, error: safeReason(error) });
      }
    }

    summary.totalItems = allItems.length;

    // -- 全会議が process-error で成功0なら exit 2 --
    if (summary.processed > 0 && summary.extracted === 0 && summary.totalItems === 0) {
      summary.error = 'all-meetings-process-error';
      appendLog({ event: 'all-meetings-process-error', processed: summary.processed, failed: summary.failed });
      return 2;
    }

    // -- dry-run 出力 --
    if (opts.dryRun) {
      let sheetPlan = null;
      if (allItems.length > 0) {
        let token;
        try {
          token = await getDriveToken({ impersonate: IMPERSONATE_SHEETS, fetchImpl });
        } catch (error) {
          token = await getDriveToken({ impersonate: 'kim@orgiast.jp', fetchImpl });
        }
        try {
          sheetPlan = await writeImprovementSheet(allItems, { token, dryRun: true, fetchImpl });
        } catch (error) {
          if (error instanceof ProcessImproveError && error.code === 'sheet-header-mismatch') {
            summary.error = 'sheet-header-mismatch';
            console.error('sheet-header-mismatch in dry-run');
            return 3;
          }
          throw error;
        }
      }

      const result = {
        meetings: newMeetings.map(m => ({ id: m.id, title: m.title, source: m.source })),
        extracted: allItems,
        summary,
        ...(sheetPlan ? { sheetPlan } : {}),
      };
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    // -- 実際の書き込み --
    let token;
    try {
      token = await getDriveToken({ impersonate: IMPERSONATE_SHEETS, fetchImpl });
    } catch (error) {
      token = await getDriveToken({ impersonate: 'kim@orgiast.jp', fetchImpl });
    }

    // 1. 改善項目シート
    if (allItems.length > 0) {
      try {
        const sheetResult = await writeImprovementSheet(allItems, { token, fetchImpl });
        summary.sheetWritten = sheetResult.written;
      } catch (sheetError) {
        if (sheetError instanceof ProcessImproveError && sheetError.code === 'sheet-header-mismatch') {
          summary.error = 'sheet-header-mismatch';
          appendLog({ event: 'sheet-header-mismatch' });
          return 3;
        }
        if (sheetError instanceof ProcessImproveError && sheetError.code === 'write-verification-failed') {
          summary.error = 'write-verification-failed';
          appendLog({ event: 'write-verification-failed' });
          return 2;
        }
        throw sheetError;
      }
    }

    // 2. app フィードバック
    summary.feedbackSent = await postAppFeedback(allItems, { fetchImpl });

    // 3. knowhow 登録
    summary.knowhowAdded = await addConstructionKnowhow(allItems);

    // 4. ログシート
    const logSheetId = await ensureLogSheet({ token, state: persistState ? state : { logSheetId: null }, fetchImpl, summary });

    // 5. テンプレート反映案タブ（kind=template）
    if (allItems.length > 0) {
      try {
        summary.templateReflected = await writeTemplateReflection(allItems, { token, logSheetId, fetchImpl });
      } catch { /* テンプレート反映案書き込み失敗は致命的ではない */ }
    }

    // 6. 抽出ログ（各項目1行）
    for (const item of allItems) {
      await writeLogEntry({
        token, logSheetId,
        entry: {
          meetingName: item.caseName,
          kind: item.kind,
          caseName: item.caseName,
          event: item.event,
          solution: item.solution,
          decided: item.decided,
          target: item.target,
          evidence: item.evidence,
          confidence: item.confidence,
          reflectionResult: summary.sheetWritten > 0 ? `シート行 ${summary.sheetWritten}` : '',
        },
        fetchImpl,
      });
    }

    // 7. 実行サマリ
    await writeRunSummary({ token, logSheetId, summary, fetchImpl });

    // -- 状態保存（全書き込み成功後に処理済みとして記録） --
    if (persistState) {
      state.lastRun = new Date().toISOString();
      // 全書き込み成功後、抽出成功した会議だけ state に保存
      for (const id of processedIds) {
        if (!state.processedMeetings[id]) {
          state.processedMeetings[id] = {
            title: '',
            processedAt: new Date().toISOString(),
            items: 1,
          };
        }
      }
      writeState(STATE_PATH, state);
    }

    // -- kim-inbox 通知 --
    const logSheetUrl = `https://docs.google.com/spreadsheets/d/${logSheetId}`;
    await notifyKimInbox(summary, logSheetUrl);

    // -- 標準出力サマリ --
    console.log(`fetched=${summary.fetched} processed=${summary.processed} extracted=${summary.extracted} ` +
      `duplicates=${summary.duplicates} sheet=${summary.sheetWritten} feedback=${summary.feedbackSent} ` +
      `knowhow=${summary.knowhowAdded} template=${summary.templateReflected} failed=${summary.failed}`);

    appendLog({ event: 'run-complete', ...summary });
    return summary.failed > 0 ? 1 : 0;

  } catch (error) {
    summary.failed++;
    summary.error = safeReason(error);
    console.error(`tldv-process-improve: ${safeReason(error)}`);
    appendLog({ event: 'run-error', error: safeReason(error) });
    return 1;
  }
}

// -- CLI エントリ --
if (isEntry(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await runImprove(options);
  } catch (error) {
    console.error(`tldv-process-improve: ${safeReason(error)}`);
    process.exitCode = 2;
  }
}