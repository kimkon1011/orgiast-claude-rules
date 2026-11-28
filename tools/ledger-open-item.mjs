#!/usr/bin/env node
/**
 * 止まった作業を追いかけ台帳（followup-ledger）に自動登録する。
 * 終了処理や巡回から呼ばれ、gb-reports の未完了ディレクトリを走査する。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(__dirname);

// ── 文字コード ──

/**
 * UTF-8（BOM有/無）と UTF-16LE/BE（BOM検出）を文字列にデコードする。
 * @param {Buffer|string} buffer
 * @returns {string}
 */
export function decodeText(buffer) {
  if (typeof buffer === 'string') return buffer;
  const buf = new Uint8Array(buffer);
  if (buf.length < 2) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);

  // BOM 判定
  if (buf[0] === 0xFE && buf[1] === 0xFF) {
    // UTF-16BE
    return new TextDecoder('utf-16be', { ignoreBOM: true }).decode(buf.slice(2));
  }
  if (buf[0] === 0xFF && buf[1] === 0xFE) {
    // UTF-16LE (BOM 付き)
    return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(buf.slice(2));
  }
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    // UTF-8 BOM
    return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf.slice(3));
  }
  // BOM なし UTF-8
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
}

// ── 秘密値の伏せ字 ──

const REDACTED = '***REDACTED***';

/**
 * トークン風文字列・パスワードを伏せる。
 * 実装は redact-secrets.mjs と同じだが、このファイルは独立して動くよう内蔵する。
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let value = text;
  value = value.replace(/\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqp|amqps):\/\/)([^\s/:@]+):([^\s/@]+)@/gi, (_, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  value = value.replace(/\b(https:\/\/discord\.com\/api\/webhooks\/)[^\s<>'"`]+/gi, `$1${REDACTED}`);
  value = value.replace(/\b(https:\/\/hooks\.slack\.com\/)[^\s<>'"`]+/gi, `$1${REDACTED}`);
  value = value.replace(/\b(sk_live_|github_pat_|sk-ant-|xoxb-|xoxp-|ghp_|gho_|AIza|gsk_|xai-|sk-)[A-Za-z0-9._-]{10,}/g, (_, prefix) => `${prefix}${REDACTED}`);
  value = value.replace(/\b(eyJ)[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, `$1${REDACTED}`);
  value = value.replace(/\b(password|passwd|pwd|token|secret|api_key)(\s*[:=]\s*)(["']?)([^\s&;,}"']+)(["']?)/gi, (_, key, separator, quote) => `${key}${separator}${quote}${REDACTED}${quote}`);
  value = value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@([^\s/@]+)/gi, (_, scheme, user) => `${scheme}${user}:${REDACTED}@`);
  value = value.replace(/\b([^\s/:@]+):([^\s/@]+)@([a-z0-9.-]+(?::[0-9]+)?)/gi, (_, user) => `${user}:${REDACTED}@`);
  return value;
}

// ── 安定ID ──

/**
 * ディレクトリ名から安定した ID を作る。
 * 英数字・ハイフン・アンダースコアのみ、最大80文字。
 * @param {string} dirName
 * @param {string} [prefix='GB-OPEN']
 * @returns {string}
 */
export function stableId(dirName, prefix = 'GB-OPEN') {
  const raw = String(dirName || '');
  const hasNonAscii = /[^\x20-\x7E]/.test(raw);
  const wasTruncated = raw.length > 80;
  const needsHash = hasNonAscii || wasTruncated;

  let clean = raw
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_|_$/g, '');

  if (needsHash) {
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8);
    const maxClean = Math.max(0, 80 - prefix.length - hash.length - 2);
    clean = clean.slice(0, maxClean);
    return `${prefix}-${clean}-${hash}`;
  }

  clean = clean.slice(0, 70);
  return `${prefix}-${clean}`.slice(0, 80);
}

// ── 未完了キーワード ──

const INCOMPLETE_KEYWORDS = [
  '未復旧', '残件', '中断', '未完', '失敗',
  '要対応', 'BLOCKED', '金さん待ち', '上限',
  'usage limit', 'weekly limit', '上限超過',
  '返信待ち', '承認待ち', '判断待ち', '待機中',
];

const KIM_WAITING_KEYWORDS = ['金さん待ち', '金さんの判断', 'kim待ち', 'kim 待ち'];

const PC_PATTERN = /(?:PC[=:]?\s*|担当)(000|004|008|011|014|015|018|019|999)/;

const DONE_INDICATORS = /^(DONE|完了|COMPLETE|done|Finish|finished)\b/;
const UPDATE_LINE = /^(UPDATE|START|END)\s/;

// ── classifyWorkDir ──

/**
 * 作業フォルダの状態を分類する。
 * @param {{ dirName: string, statusText: string, reportText: string, exitText: string, doneExists: boolean, mtime: number }} input
 * @param {Date|number} [now]
 * @returns {{ incomplete: boolean, reasons: string[], remaining: string, kimWaiting: boolean, ownerPc: string }}
 */
export function classifyWorkDir(input, now = new Date()) {
  const { dirName, statusText, reportText, exitText, doneExists, mtime } = input;
  const reasons = [];
  let remaining = '';
  let kimWaiting = false;
  let ownerPc = '';

  // 完了ファイルがあれば完了
  if (doneExists) {
    return { incomplete: false, reasons: [], remaining: '', kimWaiting: false, ownerPc: '' };
  }

  const statusLines = (statusText || '').split('\n');
  const reportLines = (reportText || '').split('\n');
  const combined = statusText + '\n' + reportText;

  // 最新の非空行（UPDATE / 状態行）を探す
  const nonEmptyLines = statusLines.filter(l => l.trim());
  let latestStatusLine = '';
  for (let i = nonEmptyLines.length - 1; i >= 0; i--) {
    const line = nonEmptyLines[i].trim();
    if (UPDATE_LINE.test(line)) {
      latestStatusLine = line;
      break;
    }
    // 「UPDATE なし」でも「END exit=...」だけの行は最終行候補
    if (/^(END|START)\s/.test(line)) {
      if (!latestStatusLine) latestStatusLine = line;
    }
  }

  // EXIT コードの抽出
  let exitCode = null;
  if (exitText) {
    const m = String(exitText).trim().match(/^(\d+)/);
    if (m) exitCode = parseInt(m[1], 10);
  } else {
    // STATUS.txt の END 行から exit 値を抽出
    for (const line of nonEmptyLines) {
      const em = line.match(/exit=(-?\d+)/);
      if (em) exitCode = parseInt(em[1], 10);
    }
  }

  // EXIT 非0 → 未完了
  if (exitCode !== null && exitCode !== 0) {
    reasons.push(`exit=${exitCode}`);
  }

  // 未完了キーワードのチェック
  for (const kw of INCOMPLETE_KEYWORDS) {
    if (combined.includes(kw)) {
      if (!reasons.includes(kw)) reasons.push(kw);
    }
  }

  // 金さん待ち
  for (const kw of KIM_WAITING_KEYWORDS) {
    if (combined.includes(kw)) {
      kimWaiting = true;
      break;
    }
  }

  // ownerPc の推定
  for (const line of [...statusLines, ...reportLines]) {
    const m = PC_PATTERN.exec(line);
    if (m) {
      ownerPc = m[1];
      break;
    }
  }

  // 残件の抽出 — 「残件」節があれば行を抜き出す
  if (reportText) {
    const remainingSection = reportText.split(/(?:^###?\s*)?残件[：:]/m);
    if (remainingSection.length > 1) {
      remaining = remainingSection[1].split(/\n(?:###?\s*)?(?:[A-Z][a-z]+[：:]|$)/m)[0].trim();
    }
  }
  if (!remaining && statusText) {
    // STATUS.txt の UPDATE 行に続く「残件」ブロック
    const parts = statusText.split(/残件[：:]/);
    if (parts.length > 1) {
      remaining = parts[1].split(/\n(?=UPDATE|START|END|$)/)[0].trim();
    }
  }
  // remaining から secret を伏せる
  if (remaining) remaining = redactSecrets(remaining);

  // 最新の状態行（最終非空行）が完了を示すなら完了扱い、過去行にキーワードがあっても登録しない
  const allNonEmptyLines = statusLines.filter(l => l.trim());
  const lastNonEmptyLine = allNonEmptyLines[allNonEmptyLines.length - 1] || '';
  const isLastLineDone = DONE_INDICATORS.test(lastNonEmptyLine) || /DONE(?:ファイル|あり)/.test(lastNonEmptyLine);

  if (isLastLineDone) {
    return { incomplete: false, reasons: [], remaining: '', kimWaiting: false, ownerPc: '' };
  }

  // exit=0 かつ未完了キーワードなし・金さん待ちでない → 正常終了（完了扱い）
  const normalExit = exitCode !== null && exitCode === 0 && reasons.length === 0 && !kimWaiting;

  const incomplete = !normalExit;

  return { incomplete, reasons, remaining, kimWaiting, ownerPc };
}

// ── defaultDue ──

/**
 * 既定の期限を返す。
 * @param {{ kimWaiting: boolean, now: Date, kimAvailableAt?: string }} opts
 * @returns {string} "YYYY-MM-DD 09:00" 形式
 */
export function defaultDue({ kimWaiting, now, kimAvailableAt }) {
  const n = now instanceof Date ? now : new Date(now);
  let due = new Date(n);

  if (kimWaiting && kimAvailableAt) {
    const parsed = new Date(kimAvailableAt);
    if (Number.isFinite(parsed.getTime())) {
      due = parsed;
    }
  }

  // 営業日（月〜金）の 09:00 JST に調整
  // 土曜(6) → 月曜(+2), 日曜(0) → 月曜(+1)
  const dow = due.getDay();
  if (dow === 0) due.setDate(due.getDate() + 1);
  else if (dow === 6) due.setDate(due.getDate() + 2);
  else if (dow === 5 && due.getHours() >= 9) due.setDate(due.getDate() + 3); // 金曜9時過ぎ→月曜
  else if (due.getHours() >= 9) due.setDate(due.getDate() + 1);

  // 再チェック（追加した日数で週末に当たったらスキップ）
  const finalDow = due.getDay();
  if (finalDow === 0) due.setDate(due.getDate() + 1);
  else if (finalDow === 6) due.setDate(due.getDate() + 2);

  const y = due.getFullYear();
  const m = String(due.getMonth() + 1).padStart(2, '0');
  const d = String(due.getDate()).padStart(2, '0');
  return `${y}-${m}-${d} 09:00`;
}

// ── buildAddArgs ──

const TEMA_CHECK_DEFAULT = '[TEMA-CHECK] 自動登録: 人への依頼なし・催促送信なし(channel=manual)・手間最小 [/TEMA-CHECK]';

/**
 * followup-ledger add の引数配列を組み立てる。
 * @param {{ id: string, task: string, ownerPc: string, ownerAi: string, kimWaiting: boolean, due: string, evidencePath: string, status: string, reason: string }} item
 * @returns {string[]}
 */
export function buildAddArgs(item) {
  const to = item.kimWaiting ? '金さん' : (item.ownerPc || '担当PC不明');
  const args = [
    'add',
    '--store', 'local',
    '--id', item.id,
    '--to', to,
    '--channel', 'manual',
    '--scope', 'internal',
    '--task', redactSecrets(String(item.task || '')),
    '--done-when', '実物完了（DONE/URL/追跡番号）',
    '--owner-ai', item.ownerAi || 'Claude Code',
    '--owner-pc', item.ownerPc || '',
    '--kind', 'automation',
    '--requested-by', 'ledger-open-item',
    '--tema-check', TEMA_CHECK_DEFAULT,
    '--upsert',
  ];
  if (item.due) args.push('--due', item.due);
  if (item.status === '止まった') {
    args.push('--status', '止まった', '--reason', redactSecrets(String(item.reason || '自動登録: 未完了')));
  }
  if (item.evidencePath) {
    const ev = redactSecrets(String(item.evidencePath));
    args.push('--evidence', ev);
  }
  return args;
}

// ── openItem ──

/**
 * 1件の作業を台帳に登録する。冪等。
 *
 * @param {{ id: string, task: string, ownerPc: string, ownerAi: string, kimWaiting: boolean, due: string, evidencePath: string, status: string, reason: string }} item
 * @param {{ existingRows: object[], runAdd: Function, dryRun: boolean }} opts
 * @returns {{ action: string, matchId?: string, args?: string[] }}
 */
export function openItem(item, { existingRows = [], runAdd, dryRun = false, originalName = '' } = {}) {
  const rows = Array.isArray(existingRows) ? existingRows : [];

  // 同じ id が既にあればスキップ
  const sameId = rows.find(r => r.id === item.id);
  if (sameId) {
    return { action: 'skip-existing', matchId: sameId.id, reason: 'id-match' };
  }

  // 既存行の id・task・案件・備考にフォルダ名または stableId が含まれればスキップ
  if (originalName) {
    const originalLower = originalName.toLowerCase();
    const idLower = item.id.toLowerCase();
    for (const row of rows) {
      if (row.status === '完了') continue;
      const searchFields = [row.id, row.task, row['案件'], row['備考']].filter(Boolean).join(' ').toLowerCase();
      const fieldsIncludeOriginal = searchFields.includes(originalLower);
      const fieldsIncludeId = searchFields.includes(idLower);
      if (fieldsIncludeOriginal || fieldsIncludeId) {
        // 短いフォルダ名（6文字以下、例 ss, tasks）は完全一致（単語境界）のみ許可
        if (originalLower.length <= 6 && fieldsIncludeOriginal) {
          const wordPattern = new RegExp(`(?:^|\\s)${originalLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`);
          if (!wordPattern.test(searchFields)) continue;
        }
        if (idLower.length <= 6 && fieldsIncludeId) {
          const wordPattern = new RegExp(`(?:^|\\s)${idLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s)`);
          if (!wordPattern.test(searchFields)) continue;
        }
        return { action: 'skip-existing', matchId: row.id, reason: 'folder-name-in-note' };
      }
    }
  }

  // 類似 task の未完了行があればスキップ
  const normalizedTask = normalizeForSimilarity(item.task);
  for (const row of rows) {
    if (row.status === '完了') continue;
    if (row.ownerPc && row.ownerPc === item.ownerPc && similarity(normalizedTask, normalizeForSimilarity(String(row.task || ''))) >= 0.6) {
      return { action: 'skip-similar', matchId: row.id, reason: 'task-similarity' };
    }
  }

  if (dryRun) {
    const args = buildAddArgs(item);
    return { action: 'would-add', args };
  }

  const args = buildAddArgs(item);
  if (typeof runAdd === 'function') {
    runAdd(args);
  } else {
    spawnSync(process.execPath, [path.join(REPO_ROOT, 'tools/followup-ledger.mjs'), ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 30_000, env: process.env,
    });
  }
  return { action: 'added' };
}

/** 類似度計算のため小文字化し連続空白を1つに */
function normalizeForSimilarity(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 文字2-gram Jaccard 類似度 */
function similarity(a, b) {
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const sa = grams(a), sb = grams(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  let intersection = 0;
  for (const g of sa) if (sb.has(g)) intersection++;
  const union = sa.size + sb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── 除外ディレクトリ ──

const EXCLUDED_DIRS = new Set([
  'session-status', 'followup-ledger', '.claude',
  'node_modules', '.git',
]);

const GB_REPORT_PREFIXES = ['gb-', 'GB-', 'gb_', 'GB_'];

// ── scanReports ──

/**
 * gb-reports 配下の未完了ディレクトリを走査し、台帳に登録する。
 * @param {{ root: string, pc?: string, existingRows: object[], now: Date, fs?: object, scanSessionStatus?: boolean, dryRun?: boolean, exclude?: string[] }} opts
 * @returns {Promise<{dir: string, id: string, action: string, reasons: string[]}[]>}
 */
export async function scanReports({ root, pc, existingRows = [], now = new Date(), fs: fsImpl = fs, scanSessionStatus = true, dryRun = false, exclude = [] } = {}) {
  const results = [];
  if (!fsImpl.existsSync(root)) return results;
  const checkExisting = Array.isArray(existingRows) ? existingRows : [];
  const nowMs = now instanceof Date ? now.getTime() : Date.now();

  const entries = fsImpl.readdirSync(root, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  for (const dirName of dirs) {
    if (EXCLUDED_DIRS.has(dirName)) continue;
    if (exclude.includes(dirName)) continue;
    // LEDGER_SELF_DIR で指定された自分自身のフォルダを除外
    if (process.env.LEDGER_SELF_DIR && dirName === process.env.LEDGER_SELF_DIR) continue;
    const dirPath = path.join(root, dirName);
    let mtime = 0;
    try { mtime = fsImpl.statSync(dirPath).mtimeMs || Date.now(); } catch { continue; }

    // 14日以内
    if (nowMs - mtime > 14 * 86_400_000) continue;

    // 直近30分以内に更新された「進行中」「実行中」のフォルダは登録しない
    if (nowMs - mtime < 30 * 60 * 1000) {
      const quickStatus = readFileSafe(fsImpl, path.join(dirPath, 'STATUS.txt')) ||
        readFileSafe(fsImpl, path.join(dirPath, 'STATUS.md'));
      if (quickStatus && /進行中|実行中/.test(quickStatus)) continue;
    }

    const doneExists = fsImpl.existsSync(path.join(dirPath, 'DONE.txt')) || fsImpl.existsSync(path.join(dirPath, 'DONE.md'));
    if (doneExists) continue;

    const statusText = readFileSafe(fsImpl, path.join(dirPath, 'STATUS.txt')) ||
      readFileSafe(fsImpl, path.join(dirPath, 'STATUS.md'));
    const reportText = readFileSafe(fsImpl, path.join(dirPath, 'REPORT.md'));
    const exitText = readFileSafe(fsImpl, path.join(dirPath, 'EXIT.txt'));

    if (!statusText && !reportText) continue; // 状態を読み取れるものが無い

    const classification = classifyWorkDir({
      dirName, statusText, reportText, exitText, doneExists, mtime,
    }, now);
    if (!classification.incomplete) continue;
    if (classification.reasons.length === 0) continue;

    const id = stableId(dirName);
    const task = classification.remaining ||
      `未完: ${dirName}（${classification.reasons.join('、')}）`;
    const reason = classification.reasons.join('／');

    const result = openItem({
      id, task,
      ownerPc: classification.ownerPc || pc || '',
      ownerAi: 'Claude Code',
      kimWaiting: classification.kimWaiting,
      due: defaultDue({ kimWaiting: classification.kimWaiting, now }),
      status: '止まった',
      reason: `自動検出: ${reason}`,
    }, { existingRows: checkExisting, dryRun, originalName: dirName });

    results.push({ dir: dirName, id, action: result.action, matchId: result.matchId || null, reason: result.reason || null, reasons: classification.reasons });
  }

  // session-status/STATUS-<PC>.md の走査
  if (scanSessionStatus) {
    const sessionDir = path.join(root, 'session-status');
    if (fsImpl.existsSync(sessionDir)) {
      const sessionFiles = fsImpl.readdirSync(sessionDir).filter(f => /^STATUS-\d+\.md$/i.test(f));
      for (const sf of sessionFiles) {
        const content = readFileSafe(fsImpl, path.join(sessionDir, sf));
        if (!content) continue;
        const lines = content.split('\n').filter(l => l.trim().startsWith('- '));
        for (const line of lines) {
          const lineText = line.replace(/^- /, '');
          // 「完了」行は常に登録しない
          if (/完了|DONE/i.test(lineText)) continue;
          // format: "- PC・dirname・status・description・期限date・次:action"
          const parts = lineText.split('・');
          if (parts.length < 3) continue;
          const dirNameFromStatus = parts[1]?.trim();
          const statusFromLine = parts[2]?.trim() || '';
          if (!dirNameFromStatus) continue;

          // 金さん待ち → 常に登録候補（DONE確認後に）
          // 停止 → 期限日付あり、またはエラーキーワードありの場合のみ
          if (statusFromLine === '金さん待ち') {
            // OK — proceed
          } else if (statusFromLine === '停止') {
            const hasDate = /\d{4}-\d{2}-\d{2}/.test(lineText);
            const hasErrorKeyword = /ログに上限|失敗|BLOCKED/.test(lineText);
            if (!hasDate && !hasErrorKeyword) continue;
          } else {
            continue;
          }

          // 同名ディレクトリの DONE 確認
          const statusDirPath = path.join(root, dirNameFromStatus);
          const doneExistsStatus = fsImpl.existsSync(path.join(statusDirPath, 'DONE.txt')) ||
            fsImpl.existsSync(path.join(statusDirPath, 'DONE.md'));
          if (doneExistsStatus) continue;

          // すでに scan で拾った行と重複しないよう stableId は同じものを
          const idFromStatus = stableId(dirNameFromStatus);
          // 既に results にあるか確認
          if (results.some(r => r.id === idFromStatus)) continue;

          const kimWaiting = statusFromLine === '金さん待ち';
          const taskFromLine = parts.slice(3).join('・') || `未完了: ${dirNameFromStatus}`;
          // 期限の抽出
          let dueFromLine = '';
          for (const part of parts) {
            const dm = part.match(/期限(\d{4}-\d{2}-\d{2})/);
            if (dm) { dueFromLine = `${dm[1]} 09:00`; break; }
          }

          const result = openItem({
            id: idFromStatus,
            task: taskFromLine.slice(0, 500),
            ownerPc: parts[0]?.trim() || pc || '',
            ownerAi: 'Claude Code',
            kimWaiting,
            due: dueFromLine || defaultDue({ kimWaiting, now }),
            status: '止まった',
            reason: `session-status: ${statusFromLine}`,
          }, { existingRows: checkExisting, dryRun, originalName: dirNameFromStatus });

          results.push({ dir: dirNameFromStatus, id: idFromStatus, action: result.action, matchId: result.matchId || null, reason: result.reason || null, reasons: [statusFromLine] });
        }
      }
    }
  }

  return results;
}

function readFileSafe(fsImpl, filePath) {
  try {
    const raw = fsImpl.readFileSync(filePath);
    return decodeText(raw);
  } catch { return ''; }
}

// ── 追加ルートの読み込み ──

function loadGbReportRoots() {
  const path_ = path.join(REPO_ROOT, 'config', 'gb-reports-roots.json');
  try {
    const raw = JSON.parse(fs.readFileSync(path_, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(raw.roots) ? raw.roots : [];
  } catch { return []; }
}

// ── existingRows の取得 ──

function tryParseJson(text) {
  try {
    const parsed = JSON.parse(String(text || '[]'));
    return Array.isArray(parsed) ? parsed : (parsed.items || []);
  } catch { return null; }
}

function getExistingRows() {
  // シート（--store 無し）を既定に
  let result = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'tools', 'followup-ledger.mjs'),
    'status', '--all', '--json',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: process.env });
  let parsed = tryParseJson(result.stdout);
  if (Array.isArray(parsed)) {
    console.error('existingRows: シートから読み込み');
    return parsed;
  }

  // 失敗したらローカルキャッシュに fallback
  result = spawnSync(process.execPath, [
    path.join(REPO_ROOT, 'tools', 'followup-ledger.mjs'),
    'status', '--all', '--json', '--store', 'local',
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: process.env });
  parsed = tryParseJson(result.stdout);
  if (Array.isArray(parsed)) {
    console.error('existingRows: ローカルキャッシュから読み込み（シート失敗）');
    return parsed;
  }

  return [];
}

// ── CLI ──

async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  const cmd = parsed._[0] || 'open';
  const flags = parsed.flags;
  const now = new Date();

  try {
    if (cmd === 'open') {
      const id = String(flags.id || '');
      if (!id) { console.error('--id が必要です'); return 1; }
      const existingRows = getExistingRows();
      const item = {
        id,
        task: String(flags.task || ''),
        ownerPc: String(flags['owner-pc'] || ''),
        ownerAi: String(flags['owner-ai'] || 'Claude Code'),
        kimWaiting: Boolean(flags['kim-wait']),
        due: String(flags.due || ''),
        evidencePath: String(flags['evidence-path'] || ''),
        status: String(flags.status || '止まった'),
        reason: String(flags.reason || ''),
      };
      const dryRun = Boolean(flags['dry-run']);
      const result = openItem(item, { existingRows, dryRun });
      console.log(JSON.stringify(result, null, 2));
      return 0;
    }

    if (cmd === 'scan') {
      const roots = [];
      if (flags.root) {
        if (Array.isArray(flags.root)) roots.push(...flags.root);
        else roots.push(String(flags.root));
      }
      const homeDir = os.homedir();
      const defaultRoot = path.join(homeDir, 'gb-reports');
      if (fs.existsSync(defaultRoot)) roots.push(defaultRoot);
      roots.push(...loadGbReportRoots());

      const existingRows = getExistingRows();
      const allResults = [];
      const excludes = [];
      if (flags.exclude) {
        if (Array.isArray(flags.exclude)) excludes.push(...flags.exclude);
        else excludes.push(String(flags.exclude));
      }
      const scanDryRun = Boolean(flags['dry-run']);

      for (const root of roots) {
        if (!fs.existsSync(root)) continue;
        const results = await scanReports({
          root,
          pc: String(flags.pc || ''),
          existingRows,
          now,
          dryRun: scanDryRun,
          exclude: excludes,
        });
        allResults.push(...results);
      }

      if (flags.json) {
        console.log(JSON.stringify({ scanned: roots, results: allResults }, null, 2));
      } else {
        const added = allResults.filter(r => r.action === 'added');
        const skipped = allResults.filter(r => r.action !== 'added');
        console.log(`scan: ${allResults.length} 件検出（追加 ${added.length} 件 / スキップ ${skipped.length} 件）`);
        for (const r of allResults) {
          if (r.action === 'added') {
            console.log(`  + ${r.id} [${r.reasons.join(', ')}]`);
          } else {
            console.log(`    ${r.id} [${r.reasons.join(', ')}] -> ${r.action} (match=${r.matchId || '-'}, reason=${r.reason || '-'})`);
          }
        }
      }
      return 0;
    }

    console.error(`未知のサブコマンド: ${cmd}`);
    return 1;
  } catch (error) {
    console.warn(`ledger-open-item: ${error.message || error}`);
    return 0; // 失敗しても exit 非0にしない（呼び出し元を壊さない）
  }
}

// ── 簡易 CLI パーサー ──

function parseCli(argv = []) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        out.flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

if (isEntry(import.meta.url)) {
  main().then((code) => {
    if (typeof code === 'number' && code !== 0) process.exit(code);
  }).catch((error) => {
    console.warn(`ledger-open-item: ${error.message || error}`);
  });
}