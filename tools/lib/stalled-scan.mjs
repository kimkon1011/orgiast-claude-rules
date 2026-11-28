#!/usr/bin/env node
/**
 * GB-229: stalled-scan — gb-reports を走査し、止まった案件を followup-ledger へ登録する。
 *
 * 使い方（followup-ledger.mjs の stalled-scan コマンド経由）:
 *   node tools/followup-ledger.mjs stalled-scan [--reports-dir <path>] [--stale-hours <n>] [--dry-run] [--store local|sheet] [--pc <name>] [--max-age-days <n>]
 *
 * オプション:
 *   --reports-dir    gb-reports のパス（既定 ~/gb-reports）
 *   --stale-hours    何時間以上更新がないものを「止まった」とするか（既定 6）
 *   --max-age-days   DONE.txt無しの古いフォルダを無視する日数（既定 7）。これを超える未完了は載せずdry-runの別枠へ。ただしINCIDENT.md＋未復旧は常に登録
 *   --dry-run        実際に登録せず件数内訳と各対象をJSONで表示
 *   --store          local（既定）または sheet
 *   --pc             走査するPC名（既定は currentPcName）
 *   --selftest       タスク登録の存在確認のみ行う
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../is-entry.mjs';
import { redactSecrets } from '../redact-secrets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 自動生成フォルダ — 案件フォルダとして扱わない */
export const SKIP_FOLDERS = new Set([
  '.git', 'node_modules', '.wt', 'wt',
  'followup-ledger', 'session-status', 'stalled-sessions-hourly',
  'heartbeat', 'evidence',
]);

/** 走査対象ファイル（STATUS はワイルドカードで STATUS.txt / STATUS*.md の両方を拾う） */
export const WATCHED_FILES = ['STATUS.txt', 'STATUS.md', 'REPORT.md', 'INCIDENT.md', 'PROGRESS.md', 'DONE.txt'];

/** ステータス指標ファイル（DONE.txt 以外の監視ファイル）。これが無いフォルダは「止まった」判定の対象外 */
export const STATUS_INDICATOR_FILES = ['STATUS.txt', 'STATUS.md', 'REPORT.md', 'INCIDENT.md', 'PROGRESS.md'];

/** 止まったと判定する検出語（大文字小文字を区別せず部分一致） */
export const STALLED_KEYWORDS = [
  '金さん待ち', '未復旧', '中断', 'インシデント',
  '承認待ち', 'ブロック', '未完了', '人の手が必要',
];

/** 金さんにしかできないことを示す語（STATUS の「次の一手」などから抽出） */
export const KIM_ONLY_PATTERNS = [
  /金さん(?:にしか|だけ|に|が|への)/,
  /本人(?:にしか|だけ|確認)/,
  /(?:承認|判断)(?:が|を|待)/,
  /(?:ログイン|本人確認|支払い|決済)/,
  /(?:画面|通知|確認)が必要/,
];

/** 金さん待ちを示す検出語 */
export const KIM_WAITING_KEYWORDS = ['金さん待ち', '金さんだけ'];

/**
 * 案件フォルダ名として有効か（英数、-、_、日本語文字のみ）
 * ただし自動生成フォルダ（SKIP_FOLDERS）は除外
 */
export function isValidCaseFolder(name) {
  if (SKIP_FOLDERS.has(name)) return false;
  // Skip hidden and dotfiles
  if (name.startsWith('.')) return false;
  // Must contain at least one character
  return name.length > 0;
}

/**
 * 案件フォルダ名を ID 用に正規化（英数と-_のみ）
 */
export function normalizeFolderName(name) {
  return String(name).replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/**
 * gb-reports 配下の案件フォルダを列挙
 */
export function enumerateCaseDirs(reportsDir) {
  const entries = [];
  try {
    const dirs = fs.readdirSync(reportsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      if (!isValidCaseFolder(d.name)) continue;
      entries.push({ name: d.name, dirPath: path.join(reportsDir, d.name) });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return entries;
}

/**
 * 案件フォルダ内の監視ファイルを読む。
 * @returns {{ statusText: string, hasDone: boolean, watchedFiles: string[], mtimeMs: number }}
 */
export function readCaseFiles(caseDir) {
  let statusText = '';
  let hasDone = false;
  const watchedFiles = [];
  let latestMtime = 0;

  let entries;
  try {
    entries = fs.readdirSync(caseDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { statusText: '', hasDone: false, watchedFiles: [], mtimeMs: 0 };
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;

    // Check if it's a STATUS file (STATUS.txt or STATUS*.md)
    const isStatusFile = name === 'STATUS.txt' || /^STATUS.*\.md$/.test(name);
    // Or one of the other watched files
    const isWatched = isStatusFile || name === 'REPORT.md' || name === 'INCIDENT.md' || name === 'PROGRESS.md' || name === 'DONE.txt';

    if (!isWatched) continue;

    const filePath = path.join(caseDir, name);
    watchedFiles.push(name);

    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs > latestMtime) latestMtime = stat.mtimeMs;
    } catch { /* skip */ }

    if (name === 'DONE.txt') {
      hasDone = true;
      try {
        statusText += '\n' + (fs.readFileSync(filePath, 'utf8') || '');
      } catch { /* ignore read errors */ }
      continue;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8') || '';
      statusText += '\n' + content;
    } catch { /* ignore read errors */ }
  }

  // If no watched files found, check dir mtime as fallback
  if (latestMtime === 0) {
    try {
      latestMtime = fs.statSync(caseDir).mtimeMs;
    } catch { /* ignore */ }
  }

  return { statusText, hasDone, watchedFiles, mtimeMs: latestMtime };
}

/**
 * 検出語とマッチするか判定
 */
export function containsStalledKeywords(text) {
  return STALLED_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * 金さんにしかできないことを本文から抽出
 */
export function extractKimOnlyAction(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nextStepSection = [];
  let inNextStep = false;
  for (const line of lines) {
    if (/次の一手|次のステップ|next.?step/i.test(line)) {
      inNextStep = true;
      nextStepSection.push(line);
      continue;
    }
    if (inNextStep) {
      if (/^$|^\s*$|^状態:|^理由:|^期限:|^##/.test(line)) {
        inNextStep = false;
      } else {
        nextStepSection.push(line);
      }
    }
  }
  const combined = nextStepSection.join('\n');
  if (combined.length > 10) return redactSecrets(combined).slice(0, 200);
  // Fallback: extract any line matching kim-only patterns
  for (const line of lines) {
    if (KIM_ONLY_PATTERNS.some((p) => p.test(line))) {
      return redactSecrets(line.trim()).slice(0, 200);
    }
  }
  return '';
}

/**
 * 金さん待ちかどうか（本文に金さん待ち系キーワードがあるか）
 */
export function isKimWaiting(text) {
  return KIM_WAITING_KEYWORDS.some((kw) => text.includes(kw));
}

/**
 * INCIDENT ファイルが存在するか
 */
export function hasIncidentFile(caseDir) {
  try {
    return fs.existsSync(path.join(caseDir, 'INCIDENT.md'));
  } catch { return false; }
}

/**
 * 1つの案件フォルダを走査し、登録すべき行データを返す。
 * 登録不要なら null。
 *
 * @param {string} caseDir  案件フォルダの絶対パス
 * @param {string} caseName フォルダ名
 * @param {string} pcName   走査PC名
 * @param {number} staleHours 何時間以上更新なしを「止まった」とするか
 * @param {number} nowMs   現在時刻（ms）
 * @param {number} maxAgeDays DONE.txt無しでこれより古い未完了は載せない（既定 7）。INCIDENT.md＋未復旧は常に登録
 */
export function scanCase(caseDir, caseName, pcName, staleHours, nowMs = Date.now(), maxAgeDays = 7) {
  const { statusText, hasDone, watchedFiles, mtimeMs } = readCaseFiles(caseDir);

  // ステータス指標ファイル（STATUS.txt/STATUS*.md/REPORT.md/INCIDENT.md/PROGRESS.md）が1つも無ければスキップ
  const hasStatusIndicator = watchedFiles.some((f) =>
    f === 'STATUS.txt' || /^STATUS.*\.md$/.test(f) ||
    f === 'REPORT.md' || f === 'INCIDENT.md' || f === 'PROGRESS.md'
  );
  if (!hasStatusIndicator) return null;

  const text = statusText;
  const hasStalledKeywords = containsStalledKeywords(text);

  // DONE.txt があり、かつ検出語がなければ「完了」としてスキップ
  if (hasDone && !hasStalledKeywords) return null;

  // 最終更新が maxAgeDays より古いものは、INCIDENT.md＋「未復旧」以外はスキップ
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (nowMs - mtimeMs > maxAgeMs) {
    const hasIncidentWithUnrecovered = hasIncidentFile(caseDir) && text.includes('未復旧');
    if (!hasIncidentWithUnrecovered) return null;
  }

  // 登録条件: (1) 検出語あり または (2) DONE.txt 無しで stale 時間超過
  const isStale = !hasDone && (nowMs - mtimeMs > staleHours * 60 * 60 * 1000);
  const shouldRegister = hasStalledKeywords || isStale;

  if (!shouldRegister) return null;

  // 検出語を特定
  const foundKeywords = STALLED_KEYWORDS.filter((kw) => text.includes(kw));
  const detectedWords = foundKeywords.length > 0 ? foundKeywords.join('・') : '止まった（未完了）';

  // 理由を構築（秘密は redact）
  const relativePath = path.basename(caseDir);
  const reasonParts = [`検出語: ${detectedWords}`, `根拠: ${relativePath}`];
  const statusLine = text.split(/\r?\n/).find((l) => /^状態:|^理由:/.test(l.trim()));
  if (statusLine) reasonParts.push(statusLine.trim());

  const reason = redactSecrets(reasonParts.join('／'));
  const kimOnlyAction = extractKimOnlyAction(text);
  const isKimWaitingCase = isKimWaiting(text) || kimOnlyAction.length > 0;
  const hasIncident = hasIncidentFile(caseDir);

  // due 計算
  const due = hasIncident ? computeDueIncident(nowMs) : computeDueDefault(nowMs);

  // folder 名を正規化して ID
  const folderId = normalizeFolderName(caseName);
  const id = `GB-STALL-${pcName}-${folderId}`;

  // 金さんだけができること
  let kimOnly = '';
  if (isKimWaitingCase) {
    kimOnly = kimOnlyAction || `金さん待ち: ${detectedWords}`;
  }

  return {
    id,
    folder: caseName,
    folderId,
    pc: pcName,
    reason,
    kimOnlyAction: kimOnly,
    due,
    detectedWords,
    hasIncident,
  };
}

function computeDueDefault(nowMs) {
  const d = new Date(nowMs + 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function computeDueIncident(nowMs) {
  const d = new Date(nowMs);
  d.setHours(23, 59, 0, 0);
  return d.toISOString();
}

/**
 * gb-reports 全体を走査し、登録すべき案件のリストを返す。
 */
export function scanReports(reportsDir, pcName, staleHours = 6, nowMs = Date.now(), maxAgeDays = 7) {
  const cases = enumerateCaseDirs(reportsDir);
  const results = [];
  for (const c of cases) {
    const entry = scanCase(c.dirPath, c.name, pcName, staleHours, nowMs, maxAgeDays);
    if (entry) results.push(entry);
  }
  return results;
}

/**
 * scanReports に加え、skip理由の内訳を返す。dry-run出力用。
 * @returns {{ entries: Array, breakdown: { registered: number, completed: number, tooOld: number, noStatusFiles: number } }}
 */
export function scanReportsWithBreakdown(reportsDir, pcName, staleHours = 6, nowMs = Date.now(), maxAgeDays = 7) {
  const cases = enumerateCaseDirs(reportsDir);
  const entries = [];
  const breakdown = { registered: 0, completed: 0, tooOld: 0, noStatusFiles: 0 };

  for (const c of cases) {
    const { statusText, hasDone, watchedFiles, mtimeMs } = readCaseFiles(c.dirPath);

    // ステータス指標ファイルが無ければスキップ
    const hasStatusIndicator = watchedFiles.some((f) =>
      f === 'STATUS.txt' || /^STATUS.*\.md$/.test(f) ||
      f === 'REPORT.md' || f === 'INCIDENT.md' || f === 'PROGRESS.md'
    );
    if (!hasStatusIndicator) { breakdown.noStatusFiles++; continue; }

    const text = statusText;
    const hasStalledKeywords = containsStalledKeywords(text);

    // DONE.txt があり検出語なし → 完了
    if (hasDone && !hasStalledKeywords) { breakdown.completed++; continue; }

    // 最終更新が maxAgeDays より古い → 古すぎ（INCIDENT.md＋未復旧は除く）
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    if (nowMs - mtimeMs > maxAgeMs) {
      const hasIncidentWithUnrecovered = hasIncidentFile(c.dirPath) && text.includes('未復旧');
      if (!hasIncidentWithUnrecovered) { breakdown.tooOld++; continue; }
    }

    // scanCase で実際の登録判定
    const entry = scanCase(c.dirPath, c.name, pcName, staleHours, nowMs, maxAgeDays);
    if (entry) {
      entries.push(entry);
      breakdown.registered++;
    }
  }

  return { entries, breakdown };
}

/**
 * 既存の followup-ledger の items から、同じ案件が既に登録されていないか検査。
 * 重複条件: 同じ id、または status が未完了で folder（備考/理由に含まれる相対パス）が一致する。
 */
export function findExistingEntries(items, scanEntry) {
  const folderNames = [scanEntry.folder, scanEntry.folderId];
  return items.filter((r) => {
    if (r.status === '完了') return false;
    if (r.id === scanEntry.id) return true;
    const note = String(r.note || r.statusReason || '');
    return folderNames.some((fn) => fn && note.includes(fn));
  });
}

/**
 * stalled-scan の結果を followup-ledger の add 形式の flags に変換する。
 * 重複があれば upsert フラグを立てる。
 */
export function toAddFlags(entry, hasExisting) {
  const flags = {
    id: entry.id,
    to: '',
    channel: 'manual',
    task: `【stalled-scan】${entry.folder}`,
    doneWhen: '復旧確認',
    interval: '60',
    due: entry.due,
    renudge: '120',
    'max-nudges': '5',
    escalate: 'kim-inbox',
    'owner-ai': 'Claude Code',
    'owner-pc': entry.pc,
    status: '止まった',
    reason: entry.reason,
    kind: 'automation',
    'requested-by': 'stalled-scan',
    note: entry.folder,
    upsert: hasExisting,
  };
  if (entry.kimOnlyAction) {
    flags['kim-only'] = entry.kimOnlyAction;
  }
  return flags;
}

// ---- selftest ----

/**
 * stalled-scan --selftest: タスクの存在確認
 */
export async function selftest({ spawnImpl } = {}) {
  const { getScheduledTaskInfo } = await import('./scheduled-task.mjs');
  const results = [];
  for (const taskName of ['OrgiastFollowupLedger', 'OrgiastStalledScan']) {
    try {
      const info = await getScheduledTaskInfo(taskName, { spawnImpl });
      if (info) {
        const ok = info.lastTaskResult === 0 || info.lastTaskResult === 267009;
        results.push({ taskName, exists: true, state: info.state, lastResult: info.lastTaskResult, ok });
      } else {
        results.push({ taskName, exists: false, ok: false });
      }
    } catch (error) {
      results.push({ taskName, exists: false, ok: false, error: error.message });
    }
  }
  return results;
}

// ---- CLI entry point ----

export function parseArgs(argv = []) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        out.flags[key] = true;
      } else { out.flags[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

if (isEntry(import.meta.url)) {
  const parsed = parseArgs(process.argv.slice(2));
  const flags = parsed.flags;

  if (flags.selftest) {
    selftest().then((results) => {
      console.log(JSON.stringify(results, null, 2));
      const allOk = results.every((r) => r.ok);
      process.exit(allOk ? 0 : 1);
    }).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    process.exit(0); // Handled above; this is a safety line
  }

  const reportsDir = String(flags['reports-dir'] || path.join(os.homedir(), 'gb-reports'));
  const staleHours = Number(flags['stale-hours'] || 6);
  const pcName = String(flags.pc || os.hostname());
  const maxAgeDays = Number(flags['max-age-days'] || 7);

  if (flags['dry-run']) {
    const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, pcName, staleHours, Date.now(), maxAgeDays);
    console.log(JSON.stringify({ breakdown, entries }, null, 2));
  } else {
    const results = scanReports(reportsDir, pcName, staleHours, Date.now(), maxAgeDays);
    console.log(JSON.stringify(results, null, 2));
  }
}