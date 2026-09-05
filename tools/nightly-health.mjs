#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_NOTIFICATION_ITEMS = 12;
const INITIAL_TAIL_LINES = 200;

export function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export async function defaultRunTests() {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tools/*.test.mjs', 'tools/lib/*.test.mjs'], {
    encoding: 'utf8',
    shell: false
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
    allTestFiles: ['tools/*.test.mjs', 'tools/lib/*.test.mjs']
  };
}

async function defaultNotify(text, { home }) {
  const { notifyKim } = await import('./notify-kim.mjs');
  const result = await notifyKim(text, { home });
  if (result.delivered === 'none') throw new Error(`通知送信が失敗しました: ${result.reason || '不明な理由'}`);
  return result;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function tailLines(buffer, count = INITIAL_TAIL_LINES) {
  const lines = buffer.toString('utf8').split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count - (lines.at(-1) === '' ? 1 : 0)));
}

function linesSinceOffset(logPath, previousSize) {
  const buffer = fs.readFileSync(logPath);
  if (Number.isInteger(previousSize) && previousSize >= 0 && previousSize <= buffer.length) {
    return { lines: buffer.subarray(previousSize).toString('utf8').split(/\r?\n/), size: buffer.length, incremental: true };
  }
  return { lines: tailLines(buffer), size: buffer.length, incremental: false };
}

export function isFailureLine(line) {
  if (!line.trim() || line.includes('/ サマリ /')) return false;
  let remainder = line
    .replace(/\berror\s*[:= ]*\s*(?:[0-9]*[0]|-(?!\w))/gi, '')
    .replace(/失敗\s*[:：= ]*\s*0(?!\w)/g, '')
    .replace(/\bfailed?\s*[:= ]*\s*(?:[0-9]*[0]|-(?!\w))/gi, '')
    .replace(/\bdead\s*[:= ]*\s*(?:[0-9]*[0]|-(?!\w))/gi, '')
    .replace(/\bNG\s*[:：= ]*\s*0(?!\w)/gi, '');
  return /error|\bNG\s*[:：]|Exception|MODULE_NOT_FOUND|Traceback|失敗|終了コード\s*[1-9]/i.test(remainder);
}

function recentLines(lines, now, useTimestampFilter) {
  if (!useTimestampFilter) return lines;
  const timestampRegex = /(?:^|\[)(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/;
  const hasTimestamps = lines.some((line) => timestampRegex.test(line));
  if (!hasTimestamps) return lines;
  let lastTimestamp = null;
  return lines.filter((line) => {
    const match = line.match(timestampRegex);
    if (match) {
      lastTimestamp = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6])
      );
    }
    if (!lastTimestamp) return false;
    const elapsed = now - lastTimestamp;
    return elapsed >= -5 * 60 * 1000 && elapsed <= DAY_MS;
  });
}

function latestRunLines(lines, logFile, incremental) {
  if (incremental) return lines;
  const stem = logFile.replace(/\.log$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = new RegExp(`^(?:\\[)?${stem}(?:\\]|:)`, 'i');
  let lastBoundary = -1;
  for (let index = 0; index < lines.length; index++) {
    if (boundary.test(lines[index])) lastBoundary = index;
  }
  return lastBoundary >= 0 ? lines.slice(lastBoundary) : lines;
}

export function extractFailCount(output) {
  const matches = [...output.matchAll(/^(?:#|ℹ|✖|\s)*fail\s*[=:]?\s*(\d+)/gim)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

export function extractFailingTests(output) {
  const names = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*not ok\s+\d+\s+-\s+(.+?)\s*$/i) || line.match(/^\s*✖\s+(.+?)\s*$/u);
    if (!match) continue;
    const name = match[1].replace(/\s+\(.*?\)\s*$/, '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function runNightlyHealth({
  home,
  now = new Date(),
  runTests = defaultRunTests,
  notify = defaultNotify,
  expectations = null,
  dryRun = false,
  prime = false,
  json = false,
  updateBaseline = false,
  baselinePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nightly-health-baseline.json')
} = {}) {
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  expectations ??= readJson(path.join(dirname, 'nightly-health-expectations.json'), []);
  const logsDir = path.join(home, '.claude', 'logs');
  const offsetsPath = path.join(home, '.claude', '.nightly-health-offsets.json');
  const oldOffsets = readJson(offsetsPath, {});
  const newOffsets = { ...oldOffsets };
  const anomalies = [];
  const registeredLogs = new Set();
  const scanTargets = [];
  const logFiles = fs.existsSync(logsDir)
    ? fs.readdirSync(logsDir).filter((file) => file.endsWith('.log'))
    : [];

  for (const exp of expectations) {
    let matches = [];
    if (exp.pattern) {
      const regex = new RegExp(exp.pattern);
      matches = logFiles.filter((file) => regex.test(file));
      for (const file of matches) registeredLogs.add(file);
      matches.sort((a, b) => fs.statSync(path.join(logsDir, b)).mtimeMs - fs.statSync(path.join(logsDir, a)).mtimeMs);
    } else if (exp.log) {
      registeredLogs.add(exp.log);
      if (logFiles.includes(exp.log)) matches = [exp.log];
    }
    const logFile = matches[0];
    if (!logFile) {
      const log = exp.log || exp.pattern;
      anomalies.push({ type: 'missing', label: exp.label, log, message: 'ログファイルが存在しません' });
      continue;
    }
    const logPath = path.join(logsDir, logFile);
    const stat = fs.statSync(logPath);
    if ((now - stat.mtime) / 3_600_000 > exp.maxAgeHours) {
      anomalies.push({ type: 'stale', label: exp.label, log: logFile, message: `ログ更新が滞っています（最終更新: ${formatDate(stat.mtime)}、期待: ${exp.maxAgeHours}時間以内）` });
    }
    if (exp.scan === 'keywords') scanTargets.push({ logFile, label: exp.label });
  }

  for (const { logFile, label } of scanTargets) {
      try {
        const logPath = path.join(logsDir, logFile);
        const previousSize = oldOffsets[logFile]?.size;
        const selection = linesSinceOffset(logPath, previousSize);
        newOffsets[logFile] = { size: selection.size, at: now.toISOString() };
        const latestLines = latestRunLines(selection.lines, logFile, selection.incremental);
        const lines = recentLines(latestLines, now, !selection.incremental);
        const matched = lines.filter(isFailureLine).map((line) => line.trim().slice(0, 200)).slice(0, 3);
        if (matched.length) {
          anomalies.push({ type: 'failure_traces', label, log: logFile, message: `ログに失敗を検知: ${matched.join(' / ')}` });
        }
      } catch (error) {
        anomalies.push({ type: 'log_scan_error', label: logFile, log: logFile, message: `ログ走査に失敗: ${error.message}` });
      }
  }
  const unregisteredLogs = logFiles.filter((file) => !registeredLogs.has(file));

  let suppressedCount = 0;
  try {
    const testResult = await runTests();
    if (testResult.error) throw testResult.error;
    const output = `${testResult.stdout || ''}\n${testResult.stderr || ''}`;
    const failCount = extractFailCount(output);
    const isRed = testResult.status !== 0 || (failCount !== null && failCount > 0);
    const failing = isRed ? extractFailingTests(output) : [];
    if (updateBaseline) writeJson(baselinePath, { failing, recordedAt: now.toISOString() });
    const baseline = updateBaseline ? failing : readJson(baselinePath, { failing: [] }).failing || [];
    const baselineSet = new Set(baseline);
    suppressedCount = failing.filter((name) => baselineSet.has(name)).length;
    const newFailures = failing.filter((name) => !baselineSet.has(name));
    for (const name of newFailures) {
      anomalies.push({ type: 'test_failure', label: 'ローカルテスト', testName: name, message: `テスト失敗: ${name}` });
    }
    if (isRed && failing.length === 0) {
      anomalies.push({ type: 'test_failure', label: 'ローカルテスト', message: `テスト失敗 (失敗 ${failCount ?? '件数不明'}件、テスト名不明)` });
    }
  } catch (error) {
    anomalies.push({ type: 'test_failure', label: 'ローカルテスト', message: `テスト実行中に例外が発生しました: ${error.message}` });
  }

  if (!dryRun) {
    try { writeJson(offsetsPath, newOffsets); } catch (error) { console.error('オフセットの書き込みに失敗しました:', error); }
  }

  // 未登録ログ・baseline抑制は「異常」ではなく注記なので、それ単独では通知しない。
  // これらで通知が飛ぶと、平穏な夜も毎日DMが来て通知そのものが読まれなくなる。
  if (anomalies.length === 0) {
    const message = 'ok:異常なし';
    if (json) console.log(JSON.stringify({ status: 'ok', anomaliesCount: 0, anomalies: [], message }, null, 2));
    else console.log(message);
    return { exitCode: 0, anomalies: [], message };
  }

  const visible = anomalies.slice(0, MAX_NOTIFICATION_ITEMS);
  let notificationText = anomalies.length ? `⚠️ 夜間ジョブ異常 ${anomalies.length}件\n` : 'ℹ️ 夜間ジョブ異常 0件\n';
  for (const anomaly of visible) notificationText += `- ${anomaly.label}: ${anomaly.message}\n`;
  if (anomalies.length > visible.length) notificationText += `…ほか ${anomalies.length - visible.length}件（node tools/nightly-health.mjs --dry-run で全件）\n`;
  if (suppressedCount) notificationText += `（既知の赤 ${suppressedCount}件は baseline により抑制）\n`;
  if (unregisteredLogs.length) {
    notificationText += `（未登録のログ ${unregisteredLogs.length}件: ${unregisteredLogs.slice(0, 5).join(', ')}）\n`;
  }
  notificationText += '確認コマンド: node tools/nightly-health.mjs';

  const hash = crypto.createHash('sha256').update(notificationText).digest('hex');
  const statePath = path.join(home, '.claude', '.nightly-health-state.json');
  const state = readJson(statePath, {});
  const shouldSkip = state.hash === hash && now - new Date(state.sentAt) < DAY_MS;
  if (shouldSkip && !dryRun) {
    const message = 'skip:前回と同一';
    if (json) console.log(JSON.stringify({ status: 'anomaly', anomaliesCount: anomalies.length, anomalies, message, skip: true }, null, 2));
    else console.log(message);
    return { exitCode: 0, anomalies, message, skip: true, suppressedCount };
  }
  if (dryRun) {
    if (json) console.log(JSON.stringify({ status: anomalies.length ? 'anomaly' : 'ok', anomaliesCount: anomalies.length, anomalies, message: notificationText, dryRun: true, suppressedCount }, null, 2));
    else console.log(notificationText);
    return { exitCode: 0, anomalies, message: notificationText, dryRun: true, suppressedCount };
  }
  // --prime: オフセットと state だけ記録して通知しない。導入直後の初回は「末尾200行」を走査するため
  // 既に解決済みの過去の失敗まで拾ってしまい、最初のDMが古い話で埋まる。これを避けるための一度きりの用途。
  if (prime) {
    writeJson(statePath, { hash, sentAt: now.toISOString() });
    const message = `prime:通知せず基準を記録（検知 ${anomalies.length}件）`;
    if (json) console.log(JSON.stringify({ status: 'primed', anomaliesCount: anomalies.length, anomalies, message, suppressedCount }, null, 2));
    else console.log(message);
    return { exitCode: 0, anomalies, message, primed: true, suppressedCount };
  }
  try {
    await notify(notificationText, { home });
    writeJson(statePath, { hash, sentAt: now.toISOString() });
    if (json) console.log(JSON.stringify({ status: 'anomaly', anomaliesCount: anomalies.length, anomalies, message: notificationText, sent: true, suppressedCount }, null, 2));
    else console.log('sent:通知送信完了');
    return { exitCode: 0, anomalies, message: notificationText, sent: true, suppressedCount };
  } catch (error) {
    console.error('通知の送信に失敗しました:', error.message || error);
    return { exitCode: 1, error, anomalies, message: notificationText, suppressedCount };
  }
}

async function main() {
  const { default: os } = await import('node:os');
  try {
    const result = await runNightlyHealth({
      home: process.env.ORGIAST_HOME || os.homedir(),
      now: new Date(),
      dryRun: process.argv.includes('--dry-run'),
      prime: process.argv.includes('--prime'),
      json: process.argv.includes('--json'),
      updateBaseline: process.argv.includes('--update-baseline')
    });
    return result.exitCode ?? 0;
  } catch (error) {
    console.error('エラーが発生しました:', error);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
