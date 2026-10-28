#!/usr/bin/env node
/**
 * qutask.mjs — クオータタスクの一括実行ヘルパー
 *
 * 使用方法:
 *   node tools/qutask.mjs [--list] [--status] [qutasks.md のパス]
 *   node tools/qutask.mjs --update <index> <newStatus> [resultNote]
 *
 * --list:              タスク一覧を表示（実行しない）
 * --status:            現在の進捗サマリーのみ表示
 * --update <i> <s> [n]: タスク i をステータス s (✅💀⏳❌) に更新、任意の注釈 n
 * 引数無し:            ファイルのパース結果をJSONで出力
 *
 * このスクリプトはファイル入出力とパースを担当。
 * コードレビューの実行自体は Claude（SKILL.md の指示）が行う。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// argv[0]=node.exe, argv[1]=script path, argv[2+]=user args
const SCRIPT_PATH = process.argv[1].replace(/\\/g, '/');
const SCRIPT_DIR = SCRIPT_PATH.replace(/tools\/qutask\.mjs$/, '');
const DEFAULT_PATH = resolve(SCRIPT_DIR, 'qutasks.md');

/**
 * Parse markdown task table from file.
 */
function parseTasks(filePath) {
  const text = readFileSync(filePath, 'utf-8');
  const lines = text.split('\n');
  const tasks = [];
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Detect table start: line starting with | and containing --- and |
    if (/^\|.*---.*\|/.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;

    // Skip header separator line (---|---|---)
    if (/^\|[\s\-:]+\|/.test(line)) continue;

    // End of table
    if (!/^\|/.test(line)) {
      inTable = false;
      continue;
    }

    // Parse task row
    const cols = line.split('|').map(c => c.trim());
    if (cols.length < 5) continue;

    tasks.push({
      status: cols[1],
      task: cols[2],
      target: cols[3],
      notes: cols[4],
      lineIndex: i,
    });
  }

  return { tasks, lines };
}

function buildSummary(tasks) {
  const total = tasks.length;
  return {
    total,
    done: tasks.filter(t => t.status === '✅').length,
    failed: tasks.filter(t => t.status === '💀').length,
    running: tasks.filter(t => t.status === '⏳').length,
    pending: tasks.filter(t => t.status === '❌').length,
  };
}

function updateTaskStatus(filePath, taskIndex, newStatus, resultNote = '') {
  const { tasks, lines } = parseTasks(filePath);

  if (taskIndex < 0 || taskIndex >= tasks.length) {
    process.stderr.write(`Error: task index ${taskIndex} out of range (0-${tasks.length - 1})\n`);
    process.exit(1);
  }

  const task = tasks[taskIndex];
  const lineIdx = task.lineIndex;
  lines[lineIdx] = lines[lineIdx].replace(/[❌✅💀⏳]/, newStatus);

  // Recompute and update summary line
  const updatedTasks = tasks.map((t, i) => i === taskIndex ? { ...t, status: newStatus } : t);
  const summary = buildSummary(updatedTasks);

  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\*\*Summary:\*\*/.test(lines[i])) {
      lines[i] = `**Summary:** ${summary.total} tasks total, ${summary.done} ✅, ${summary.failed} 💀, ${summary.running} ⏳, ${summary.pending} ❌`;
      break;
    }
  }

  writeFileSync(filePath, lines.join('\n'), 'utf-8');
  process.stdout.write(JSON.stringify({ updated: true, task: task.task, newStatus, summary }) + '\n');
}

function listTasks(filePath) {
  const { tasks } = parseTasks(filePath);
  const summary = buildSummary(tasks);

  process.stdout.write('| # | Status | Task |\n');
  process.stdout.write('|---|--------|------|\n');

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const taskShort = t.task.length > 60 ? t.task.slice(0, 57) + '...' : t.task;
    process.stdout.write(`| ${i} | ${t.status} | ${taskShort} |\n`);
  }

  process.stdout.write('\n' + JSON.stringify(summary, null, 2) + '\n');
}

// --- Main ---
// argv[0]=node.exe, argv[1]=script path, argv[2+]=user args
const args = process.argv.slice(2);
// --update always uses the default file path
// For --list and --status, optionally accept a file path as last non-flag arg
const nonFlagArgs = args.filter(a => !a.startsWith('--'));
const path = nonFlagArgs.length > 0 ? nonFlagArgs[nonFlagArgs.length - 1] : DEFAULT_PATH;

if (args.includes('--update')) {
  const idxPos = args.indexOf('--update');
  const idx = Number(args[idxPos + 1]);
  const newStatus = args[idxPos + 2];
  const note = args.slice(idxPos + 3).filter(a => !a.startsWith('--')).join(' ');
  if (!Number.isFinite(idx) || !['✅', '💀', '⏳', '❌'].includes(newStatus)) {
    process.stderr.write('Usage: node tools/qutask.mjs --update <index> <✅|💀|⏳> [note]\n');
    process.exit(1);
  }
  updateTaskStatus(DEFAULT_PATH, idx, newStatus, note);
} else if (args.includes('--list')) {
  listTasks(path);
} else if (args.includes('--status')) {
  const { tasks } = parseTasks(path);
  process.stdout.write(JSON.stringify(buildSummary(tasks), null, 2) + '\n');
} else {
  const { tasks, lines } = parseTasks(path);
  process.stdout.write(JSON.stringify({
    filePath: path,
    tasks: tasks.map((t, i) => ({ index: i, status: t.status, task: t.task, target: t.target, notes: t.notes })),
    summary: buildSummary(tasks),
    lineCount: lines.length,
  }, null, 2) + '\n');
}