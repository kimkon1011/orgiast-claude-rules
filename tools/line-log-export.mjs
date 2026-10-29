// LINE 受信ログを Google スプレッドシートへ自動追記する。
// 初回は 2026-10-01 からの全件、2回目以降はシート上の最新受信日時より後を追記。
// 鍵は前回の LINE 抽出と同じ場所（aujust-sales-automation/.env.local）から読む。
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isEntry } from './is-entry.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { createSheetsClient, ensureSheetTab } from './lib/sheets-dwd.mjs';

// ── 定数 ──────────────────────────────────────────────
const SHEET_TITLE = 'LINE受信ログ（自動・毎時）';
const HEADER = ['受信日時(JST)', 'グループ名(subject)', 'スレッドID(external_thread_id)', '表示名', '方向', '本文', '添付の保存パス', 'メッセージID'];
const SHEET_ID_FILE = join(homedir(), '.claude', 'line-log-sheet-id.txt');
const SINCE = '2026-10-01';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

// ── 認証情報の読み込み ──────────────────────────────
function loadSupabaseCreds() {
  const candidates = [
    join(homedir(), 'Downloads', 'CLAUDE.md配布', 'aujust-sales-automation', '.env.local'),
    join(homedir(), 'orgiast-main', '.env.local'),
  ];
  for (const file of candidates) {
    try {
      const text = readFileSync(file, 'utf8');
      const values = {};
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/);
        if (m) values[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
      }
      const url = values.NEXT_PUBLIC_SUPABASE_URL || values.SUPABASE_URL;
      const key = values.SUPABASE_SERVICE_ROLE_KEY || values.SUPABASE_SECRET_KEY;
      if (url && key) return { url, key, file };
    } catch {}
  }
  throw new Error('Supabase 認証情報が見つかりません（試行: ' + candidates.join(', ') + '）');
}

// ── Supabase REST API（ページネーション対応） ──────
async function supabaseQueryAll(creds, baseQuery, { signal, fetchImpl = globalThis.fetch } = {}) {
  const base = creds.url.replace(/\/$/, '');
  const PAGE = 1000;
  const all = [];
  let offset = 0;
  for (;;) {
    const query = `${baseQuery}&limit=${PAGE}&offset=${offset}`;
    const res = await fetchImpl(base + query, {
      headers: { apikey: creds.key, Authorization: `Bearer ${creds.key}` },
      signal,
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text().catch(() => '')}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    offset += PAGE;
  }
  return all;
}

// ── 伏せ字 ──────────────────────────────────────────
function redactPersonalNumber(text) {
  // 12桁の数字（個人番号らしきもの）は末尾4桁以外を * にする
  return String(text ?? '').replace(/\b(\d{8})(\d{4})\b/g, (_, head, tail) => '*'.repeat(head.length) + tail);
}

// ── 日時変換 ──────────────────────────────────────────
function toJstIso(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  if (isNaN(d.getTime())) return String(utcStr);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', dateStyle: 'short', timeStyle: 'medium', hour12: false,
  }).format(d).replace(' ', 'T');
}

// ── 添付パスの整形 ──────────────────────────────
function formatAttachments(msg) {
  const atts = msg.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return '';
  return atts.map((a) => a.url || '').filter(Boolean).join('; ');
}

// ── メッセージをシート行に変換 ──────────────────────
function toRow(msg) {
  return [
    toJstIso(msg.received_at),
    String(msg.subject ?? ''),
    String(msg.external_thread_id ?? ''),
    String(msg.sender_identifier ?? ''),
    String(msg.direction ?? ''),
    redactPersonalNumber(String(msg.body ?? '')),
    formatAttachments(msg),
    String(msg.id ?? ''),
  ];
}

// ── シートID の読み書き ──────────────────────────
async function readSheetId() {
  try {
    const text = await readFile(SHEET_ID_FILE, 'utf8');
    return text.trim();
  } catch {
    return null;
  }
}
async function writeSheetId(id) {
  await writeFile(SHEET_ID_FILE, id.trim() + '\n', 'utf8');
}

// ── メイン ──────────────────────────────────────────
export async function runLineLogExport({
  args = process.argv.slice(2),
  log = console.log,
  fetchImpl = globalThis.fetch,
  now = new Date(),
} = {}) {
  const dryRun = args.includes('--dry-run');
  const creds = loadSupabaseCreds();
  log(`認証情報: ${creds.file}`);

  // 1) シートID を取得／作成
  let sheetId = await readSheetId();
  if (!sheetId) {
    // 新規作成: Drive API でスプレッドシートを作る
    const token = await getDriveToken({ scope: SCOPE, impersonate: 'kim@orgiast.jp', signal: AbortSignal.timeout(30_000), fetchImpl });
    const res = await fetchImpl('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { title: SHEET_TITLE } }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`シート作成失敗 ${res.status}: ${await res.text()}`);
    const data = await res.json();
    sheetId = data.spreadsheetId;
    await writeSheetId(sheetId);
    log(`シートを作成しました: https://docs.google.com/spreadsheets/d/${sheetId}`);
  } else {
    log(`シートID: ${sheetId}`);
  }

  // 2) タブを確保
  const sheets = createSheetsClient({ fetchImpl });
  const tab = await ensureSheetTab(sheetId, SHEET_TITLE, HEADER);
  const range = `'${SHEET_TITLE.replaceAll("'", "''")}'!A:H`;

  // 3) カーソル（シート上の最新受信日時）を取得
  let cursor = null;
  const existing = await sheets.get(sheetId, range);
  if (existing.length > 1) {
    // ヘッダー行を除いた最終行の A 列（受信日時）
    const lastRow = existing[existing.length - 1];
    if (lastRow[0]) cursor = lastRow[0];
  }

  // 4) Supabase から channel_messages を取得（ページネーション）
  const since = cursor || SINCE;
  log(`取得範囲: ${since} 以降`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let messages;
  try {
    const baseQuery = `/rest/v1/channel_messages?select=id,received_at,direction,sender_identifier,subject,body,external_thread_id,attachments&channel=eq.line&received_at=gte.${since}&order=received_at.asc`;
    messages = await supabaseQueryAll(creds, baseQuery, { signal: controller.signal, fetchImpl });
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    log('新規メッセージはありません。');
    return { sheetId, rows: 0, latest: cursor, status: 'no_new_messages' };
  }

  // 5) 重複除去（シート上のメッセージIDと突合）
  const existingIds = new Set();
  if (existing.length > 1) {
    for (let i = 1; i < existing.length; i++) {
      const id = existing[i][7]; // H列 = メッセージID
      if (id) existingIds.add(String(id));
    }
  }
  const newRows = messages.filter((m) => !existingIds.has(String(m.id))).map(toRow);

  if (newRows.length === 0) {
    log('新規メッセージはありません（重複除去後）。');
    return { sheetId, rows: 0, latest: cursor, status: 'no_new_messages' };
  }

  // 6) 出力
  if (dryRun) {
    log(`[dry-run] 追記予定: ${newRows.length} 行`);
    log(`[dry-run] 最新の受信日時: ${newRows[newRows.length - 1][0]}`);
    return { sheetId, rows: newRows.length, latest: newRows[newRows.length - 1][0], status: 'dry_run' };
  }

  await sheets.append(sheetId, range, newRows);
  const latest = newRows[newRows.length - 1][0];
  log(`追記完了: ${newRows.length} 行（最新: ${latest}）`);
  return { sheetId, rows: newRows.length, latest, status: 'ok' };
}

if (isEntry(import.meta.url)) {
  runLineLogExport().catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
