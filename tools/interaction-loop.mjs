#!/usr/bin/env node
// interaction-loop.mjs — Claude Code が kim の追加入力を待って止まった回数と理由を可視化する。
// 巨大 transcript を想定し、JSONL は一行ずつ処理して本文を保持しない。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { isEntry } from './is-entry.mjs';

const EXCLUDED_PREFIXES = [
  'Caveat:', '<command-name>', '<local-command', '<task-notification>',
  'Stop hook feedback:', '[Request interrupted', '<user-prompt-submit-hook>',
];

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(item => item?.type === 'text').map(item => item.text || '').join('\n');
}

function humanTurn(row, sessionFile = '') {
  if (!row || row.type !== 'user') return null;
  const content = row.message?.content;
  if (Array.isArray(content) && content.some(item => item?.type === 'tool_result')) return null;
  const text = contentText(content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
  if (!text || EXCLUDED_PREFIXES.some(prefix => text.startsWith(prefix))) return null;
  return { ts: row.timestamp || '', text, len: text.length, sessionFile: row.sessionFile || sessionFile };
}

export function extractHumanTurns(lines) {
  const turns = [];
  for (const line of lines) {
    let row = line;
    if (typeof line === 'string') { try { row = JSON.parse(line); } catch { continue; } }
    const turn = humanTurn(row);
    if (turn) turns.push(turn);
  }
  return turns;
}

const STOP_RULES = [
  ['LIMIT_ERROR', /session limit|API Error|Overloaded|OAuth session expired|Failed to authenticate|rate limit/i],
  ['EMPTY_NOTICE', /No response requested|待機ジョブが終了しただけ|対応不要|追加の作業はありません/i],
  ['ASK_PERMISSION', /進めて良いですか|やっておきますか|進めてよければ|よろしいですか|承認|許可を/i],
  ['ASK_CHOICE', /どこから着手|どちらを|優先順位をどう|どれにしますか|選んでください/i],
  ['ASK_INFO', /教えてください|共有してください|貼って|送ってください|確認してください|お知らせください/i],
  ['HANDOFF', /手動|手作業|押してください|クリックしてください|実行してください|ログインしてください/i],
  ['REPORT_DONE', /完了|反映済|push\s*済|deploy\s*完了|PASS|✅/i],
];

export function classifyStop(assistantText) {
  const tail = String(assistantText || '').slice(-800);
  for (const [reason, pattern] of STOP_RULES) if (pattern.test(tail)) return reason;
  return 'OTHER';
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0;
  const index = Math.ceil(sorted.length * fraction) - 1;
  return sorted[Math.max(0, index)];
}

export function calculateWaitStats(seconds) {
  const valid = seconds.filter(Number.isFinite).filter(value => value >= 0).sort((a, b) => a - b);
  const attended = valid.filter(value => value < 300);
  const middle = Math.floor(valid.length / 2);
  const median = valid.length === 0 ? 0 : valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
  return {
    medianSec: median,
    p75Sec: percentile(valid, 0.75),
    attendedCount: attended.length,
    attendedMinutes: Number((attended.reduce((sum, value) => sum + value, 0) / 60).toFixed(1)),
  };
}

function defaultHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
}

const DIGEST_METRICS = [
  ['turnsPerDay'],
  ['stops', 'total'],
  ['stops', 'avoidable'],
  ['nudgeCount'],
  ['wait', 'attendedMinutes'],
];

function metricValue(metrics, keyPath) {
  const value = keyPath.reduce((current, key) => current?.[key], metrics);
  return Number.isFinite(value) ? value : 0;
}

export function diffMetrics(previous, current) {
  const result = {};
  for (const keyPath of DIGEST_METRICS) {
    const key = keyPath.join('.');
    const before = previous ? metricValue(previous, keyPath) : null;
    const now = metricValue(current, keyPath);
    result[key] = { previous: before, current: now, change: before === null ? null : now - before };
  }
  return result;
}

export function shouldPublish(diff) {
  return Object.values(diff).some(({ previous, current }) => {
    if (previous === null) return true;
    if (previous === 0) return current !== 0;
    return Math.abs(current - previous) / Math.abs(previous) > 0.05;
  });
}

export function retainMetricHistory(history, current, limit = 30) {
  return [...(Array.isArray(history) ? history : []), current].slice(-limit);
}

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.name.endsWith('.jsonl')) out.push(file);
  }
}

function assistantTextOnly(row) {
  if (!row || row.type !== 'assistant') return null;
  const content = row.message?.content;
  if (typeof content === 'string') return content.trim() || null;
  if (!Array.isArray(content) || !content.length || content.some(item => item?.type !== 'text')) return null;
  const text = content.map(item => item.text || '').join('\n').trim();
  return text || null;
}

export async function collectInteractionStats({ home = defaultHome(), days = 14, now = Date.now() } = {}) {
  const files = [];
  walk(path.join(home, '.claude', 'projects'), files);
  const since = now - days * 864e5;
  const byReason = {}, shortCounts = new Map(), sessionCounts = new Map(), waits = [];
  let humanTurns = 0, nudgeCount = 0;

  for (const file of files) {
    try { if (fs.statSync(file).mtimeMs < since) continue; } catch { continue; }
    let precedingStop = null;
    let input;
    try { input = fs.createReadStream(file, { encoding: 'utf8' }); } catch { continue; }
    try {
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        let row; try { row = JSON.parse(line); } catch { continue; }
        const human = humanTurn(row, file);
        if (human) {
          humanTurns++;
          sessionCounts.set(file, (sessionCounts.get(file) || 0) + 1);
          const normalized = human.text.replace(/\s+/g, ' ').trim();
          if (human.len <= 30) shortCounts.set(normalized, (shortCounts.get(normalized) || 0) + 1);
          if (/^(?:すすめて|進めて|続けて|つづけて)/.test(normalized)) nudgeCount++;
          const humanTs = Date.parse(human.ts);
          if (precedingStop) {
            const reason = classifyStop(precedingStop.text);
            byReason[reason] = (byReason[reason] || 0) + 1;
            if (Number.isFinite(humanTs) && humanTs >= precedingStop.ts) waits.push((humanTs - precedingStop.ts) / 1000);
          }
          precedingStop = null;
          continue;
        }
        const text = assistantTextOnly(row);
        if (text !== null) {
          const ts = Date.parse(row.timestamp || '');
          precedingStop = { text, ts };
        } else if (row?.type === 'assistant') {
          // A tool-using assistant turn means the previous text was not the turn that stopped for kim.
          precedingStop = null;
        }
      }
    } catch { /* unreadable/truncated files do not abort the remaining scan */ }
    finally { input.destroy(); }
  }

  const avoidableReasons = new Set(['LIMIT_ERROR', 'EMPTY_NOTICE', 'ASK_PERMISSION', 'ASK_CHOICE', 'REPORT_DONE']);
  const needsWorkReasons = new Set(['ASK_INFO', 'HANDOFF']);
  const sumReasons = set => [...set].reduce((sum, reason) => sum + (byReason[reason] || 0), 0);
  const totalStops = Object.values(byReason).reduce((sum, count) => sum + count, 0);
  return {
    generatedAt: new Date(now).toISOString(), days, humanTurns,
    turnsPerDay: Number((humanTurns / Math.max(days, 1)).toFixed(1)),
    stops: { total: totalStops, byReason, avoidable: sumReasons(avoidableReasons), needsWork: sumReasons(needsWorkReasons) },
    nudgeCount,
    shortTurns: [...shortCounts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ja')).slice(0, 20),
    wait: calculateWaitStats(waits),
    topSessions: [...sessionCounts].map(([file, count]) => ({ session: path.basename(file, '.jsonl'), humanTurns: count })).sort((a, b) => b.humanTurns - a.humanTurns || a.session.localeCompare(b.session)).slice(0, 20),
  };
}

function parseArgs(argv) {
  let days = 14, out = '', json = false, digest = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--digest') digest = true;
    else if (argv[i] === '--days') days = Number.parseInt(argv[++i], 10);
    else if (argv[i].startsWith('--days=')) days = Number.parseInt(argv[i].slice(7), 10);
    else if (argv[i] === '--out') out = argv[++i] || '';
    else if (argv[i].startsWith('--out=')) out = argv[i].slice(6);
  }
  return { days: Number.isFinite(days) && days > 0 ? days : 14, out, json, digest };
}

const ACTION_BY_REASON = {
  REPORT_DONE: '止まるな hook(Done Digest)',
  ASK_PERMISSION: '判断キュー', ASK_CHOICE: '判断キュー',
  LIMIT_ERROR: '自動再開', EMPTY_NOTICE: '自動再開',
  ASK_INFO: '情報の先回り取得(Prefetch)', HANDOFF: '手渡しの品質理由の再確認', OTHER: 'OTHER の再分類',
};

function formatDelta(item) {
  if (item.previous === null) return '初回計測';
  const arrow = item.change > 0 ? '↑' : item.change < 0 ? '↓' : '→';
  return `${item.previous} → ${item.current} (${arrow}${Math.abs(item.change)})`;
}

export function formatDigest(result, diff) {
  const labels = {
    turnsPerDay: '対話回数/日', 'stops.total': '停止回数', 'stops.avoidable': '削減可能な停止',
    nudgeCount: '「進めて」系', 'wait.attendedMinutes': '張り付き待機時間(分)',
  };
  const topReasons = Object.entries(result.stops.byReason).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3);
  const avoidable = new Set(['LIMIT_ERROR', 'EMPTY_NOTICE', 'ASK_PERMISSION', 'ASK_CHOICE', 'REPORT_DONE']);
  const topAvoidable = Object.entries(result.stops.byReason).filter(([reason]) => avoidable.has(reason)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const stopRate = Number((result.stops.total / Math.max(result.days, 1)).toFixed(1));
  return `<!-- INTERACTION-DIGEST-START -->\n` +
    `## 🕐 対話ループ ${result.turnsPerDay}回/日 (停止 ${stopRate}回/日)\n` +
    `${Object.entries(diff).map(([key, item]) => `- ${labels[key]}: ${formatDelta(item)}`).join('\n')}\n` +
    `### 停止理由 上位3件\n${topReasons.length ? topReasons.map(([reason, count]) => `- ${reason}: ${count}回`).join('\n') : '- なし'}\n` +
    `### 最優先施策\n${topAvoidable ? `- ${topAvoidable[0]} (${topAvoidable[1]}回) → ${ACTION_BY_REASON[topAvoidable[0]]}` : '- 削減可能な停止なし'}\n` +
    `<!-- INTERACTION-DIGEST-END -->\n`;
}

function digestSnapshot(result) {
  return {
    generatedAt: result.generatedAt, turnsPerDay: result.turnsPerDay,
    stops: result.stops, nudgeCount: result.nudgeCount, wait: result.wait,
  };
}

function writeDigest(result, home) {
  const claudeDir = path.join(home, '.claude');
  const metricsFile = path.join(claudeDir, 'interaction-metrics.json');
  const directiveFile = path.join(claudeDir, 'interaction-directive.md');
  let state = { history: [] };
  try { state = JSON.parse(fs.readFileSync(metricsFile, 'utf8')); } catch { /* first measurement */ }
  const history = Array.isArray(state.history) ? state.history : [];
  const previous = history.at(-1) || null;
  const current = digestSnapshot(result);
  const diff = diffMetrics(previous, current);
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(metricsFile, JSON.stringify({ history: retainMetricHistory(history, current) }, null, 2) + '\n');
  if (!shouldPublish(diff)) {
    console.log('skip:前回と差分なし');
    return;
  }
  fs.writeFileSync(directiveFile, formatDigest(result, diff));
  console.log(formatDigest(result, diff));
}

export function formatReport(result) {
  const reasons = Object.entries(result.stops.byReason).sort((a, b) => b[1] - a[1]).map(([key, count]) => `  - ${key}: ${count}`).join('\n') || '  - なし';
  const shorts = result.shortTurns.map(item => `  - ${item.text}: ${item.count}回`).join('\n') || '  - なし';
  const sessions = result.topSessions.map(item => `  - ${item.session}: ${item.humanTurns}回`).join('\n') || '  - なし';
  return `Claude Code 対話ループ（直近${result.days}日）\n` +
    `人間の実発話: ${result.humanTurns}回（${result.turnsPerDay}回/日）\n` +
    `停止: ${result.stops.total}回 / 削減可能 ${result.stops.avoidable}回 / 要個別判定 ${result.stops.needsWork}回\n${reasons}\n` +
    `「進めて」系: ${result.nudgeCount}回\n` +
    `待機: median ${result.wait.medianSec}秒 / p75 ${result.wait.p75Sec}秒 / 張り付き ${result.wait.attendedCount}回・${result.wait.attendedMinutes}分\n` +
    `短文上位:\n${shorts}\nセッション上位:\n${sessions}`;
}

if (isEntry(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = await collectInteractionStats({ days: args.days });
  if (args.digest) {
    try { writeDigest(result, defaultHome()); }
    catch (error) { console.error(`ダイジェスト保存失敗: ${error.message}`); process.exitCode = 1; }
    process.exitCode ||= 0;
  } else {
  const serialized = JSON.stringify(result, null, 2);
  if (args.out) {
    try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, serialized + '\n'); }
    catch (error) { console.error(`JSON保存失敗: ${error.message}`); process.exitCode = 1; }
  }
  console.log(args.json ? serialized : formatReport(result));
  }
}
