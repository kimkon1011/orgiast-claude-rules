#!/usr/bin/env node

/**
 * Daily Report Generator
 *
 * Generates a daily report (Daily.md) for cache recovery assistance.
 * Run at session-end or manually via /daily command.
 *
 * Usage:
 *   node tools/daily-report.mjs
 *   node tools/daily-report.mjs --output outputs/daily/2026-11-11.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function getDateStr() {
  const now = new Date();
  // JST
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().split('T')[0];
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Collect session summary information.
 * Reads next-session.md to extract current TODO items.
 */
function collectSessionInfo() {
  const nextSessionPath = path.join(REPO_ROOT, '..', 'next-session.md');
  const info = {
    completed: [],
    inProgress: [],
    pendingDecisions: [],
    remaining: [],
    tokenUsage: { input: '?', output: '?', cacheHitRate: '?' },
  };

  // Try to read next-session.md for TODO items
  try {
    if (fs.existsSync(nextSessionPath)) {
      const content = fs.readFileSync(nextSessionPath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const trimmed = line.trim();
        // Completed items (strikethrough)
        if (trimmed.match(/^[\d.]+\.\s*~~.*~~/)) {
          const text = trimmed.replace(/^[\d.]+\.\s*~~/, '').replace(/~~.*$/, '').trim();
          info.completed.push(text);
        }
        // Pending items
        if (trimmed.match(/^[\d.]+\.\s*\[.*\]/) || trimmed.match(/^[\d.]+\.\s*\[判断待ち\]/)) {
          const text = trimmed.replace(/^[\d.]+\.\s*\[.*?\]\s*/, '').trim();
          info.pendingDecisions.push(text);
        }
        // Active items (numbered, not strikethrough, not pending)
        if (trimmed.match(/^[\d.]+\.\s*(?!~~)(?!\[)/)) {
          const text = trimmed.replace(/^[\d.]+\.\s*/, '').trim();
          if (text.length > 10 && !text.startsWith('<!--') && !text.startsWith('>')) {
            info.inProgress.push(text);
          }
        }
      }
    }
  } catch {
    // Ignore read errors
  }

  return info;
}

/**
 * Get output path
 */
function getOutputPath(customPath) {
  if (customPath) return customPath;
  const date = getDateStr();
  const dir = path.join(REPO_ROOT, 'outputs', 'daily');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, `${date}.md`);
}

/**
 * Generate the report
 */
function generateReport(info) {
  const date = getDateStr();
  const lines = [];

  lines.push(`# Daily Report — ${date}`);
  lines.push('');
  lines.push('> 自動生成（tools/daily-report.mjs）');
  lines.push('');

  // Completed
  lines.push('## 完了');
  if (info.completed.length > 0) {
    for (const item of info.completed) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('（なし）');
  }
  lines.push('');

  // In Progress
  lines.push('## 進行中');
  if (info.inProgress.length > 0) {
    for (const item of info.inProgress.slice(0, 10)) {
      lines.push(`- ${item.slice(0, 100)}`);
    }
  } else {
    lines.push('（なし）');
  }
  lines.push('');

  // Pending Decisions
  lines.push('## 判断待ち');
  if (info.pendingDecisions.length > 0) {
    for (const item of info.pendingDecisions) {
      lines.push(`- ${item.slice(0, 100)}`);
    }
  } else {
    lines.push('（なし）');
  }
  lines.push('');

  // Remaining
  lines.push('## 残課題');
  if (info.remaining.length > 0) {
    for (const item of info.remaining) {
      lines.push(`- ${item}`);
    }
  } else {
    lines.push('（next-session.md の残TODOを参照）');
  }
  lines.push('');

  // Token usage placeholder
  lines.push('## トークン消費');
  lines.push(`- 総入力: ${info.tokenUsage.input}K / 総出力: ${info.tokenUsage.output}K`);
  lines.push(`- キャッシュヒット率: ${info.tokenUsage.cacheHitRate}%`);
  lines.push('');
  lines.push('---');
  lines.push('_キャッシュ切れ後のセッション再開時は、この日報を最初に読むことで前回の状態を効率的に把握できます。_');

  return lines.join('\n');
}

// Main
function main() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const customPath = outputIndex >= 0 ? args[outputIndex + 1] : null;

  const info = collectSessionInfo();
  const report = generateReport(info);
  const outputPath = getOutputPath(customPath);

  fs.writeFileSync(outputPath, report, 'utf-8');
  console.log(`Daily report written to: ${outputPath}`);

  return 0;
}

process.exit(main());
