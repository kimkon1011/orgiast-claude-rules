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
  return {
    medianSec: percentile(valid, 0.5),
    p75Sec: percentile(valid, 0.75),
    attendedCount: attended.length,
    attendedMinutes: Number((attended.reduce((sum, value) => sum + value, 0) / 60).toFixed(1)),
  };
}

function defaultHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
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
  let days = 14, out = '', json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') json = true;
    else if (argv[i] === '--days') days = Number.parseInt(argv[++i], 10);
    else if (argv[i].startsWith('--days=')) days = Number.parseInt(argv[i].slice(7), 10);
    else if (argv[i] === '--out') out = argv[++i] || '';
    else if (argv[i].startsWith('--out=')) out = argv[i].slice(6);
  }
  return { days: Number.isFinite(days) && days > 0 ? days : 14, out, json };
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
  const serialized = JSON.stringify(result, null, 2);
  if (args.out) {
    try { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, serialized + '\n'); }
    catch (error) { console.error(`JSON保存失敗: ${error.message}`); process.exitCode = 1; }
  }
  console.log(args.json ? serialized : formatReport(result));
}
