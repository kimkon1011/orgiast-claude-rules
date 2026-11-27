#!/usr/bin/env node
/**
 * followup-ledger-agenda — 翌日の案件別フォローアップTODOを生成する
 * 使い方: node tools/followup-ledger-agenda.mjs --origin auto --output <output_path>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEDGER_HOME = process.env.FOLLOWUP_LEDGER_HOME
  || path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'followup-ledger');

function loadLocalLedger() {
  const file = path.join(LEDGER_HOME, 'ledger.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { items: [], history: [] };
    throw e;
  }
}

function toIsoJst(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => parts.find((p) => p.type === t)?.value || '00';
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}:${g('second')}+09:00`;
}

function jstDateStr(date = new Date()) {
  return toIsoJst(date).slice(0, 10);
}

function nextBusinessDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  d.setDate(d.getDate() + 1);
  // Skip Saturday (6) and Sunday (0)
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return toIsoJst(d).slice(0, 10);
}

/**
 * Generate agenda for a target date.
 */
function generateAgenda(targetDateStr, ledger) {
  const items = (ledger.items || []).filter(r => r.status !== '完了');

  const overdue = [];
  const dueToday = [];
  const stalled = [];
  const pending = [];
  const escalated = [];

  for (const row of items) {
    const due = row.dueAt ? new Date(row.dueAt) : null;
    const dueDay = due && Number.isFinite(due.getTime()) ? toIsoJst(due).slice(0, 10) : null;

    if (row.status === '止まった') {
      stalled.push(row);
    } else if (row.status === 'エスカレーション') {
      escalated.push(row);
    } else if (dueDay && dueDay < targetDateStr) {
      overdue.push(row);
    } else if (dueDay && dueDay === targetDateStr) {
      dueToday.push(row);
    } else {
      pending.push(row);
    }
  }

  // Group by case
  const byCase = {};
  for (const row of items) {
    const key = row.caseName || '(案件なし)';
    if (!byCase[key]) byCase[key] = [];
    byCase[key].push(row);
  }

  return {
    date: targetDateStr,
    overdue,
    dueToday,
    stalled,
    escalated,
    pending,
    byCase,
    summary: {
      total: items.length,
      overdue: overdue.length,
      dueToday: dueToday.length,
      stalled: stalled.length,
      escalated: escalated.length,
      pending: pending.length,
      cases: Object.keys(byCase).length,
    },
  };
}

function formatMd(agenda) {
  const lines = [];
  lines.push(`# フォローアップTODO（${agenda.date}）`);
  lines.push(`更新: ${toIsoJst()}`);
  lines.push('');

  // === エスカレーション ===
  if (agenda.escalated.length) {
    lines.push('## ⚠ エスカレーション（kim 判断待ち）');
    lines.push('| 依頼ID | 案件 | 依頼先 | 内容 | 理由 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of agenda.escalated) {
      lines.push(`| ${r.id} | ${r.caseName || '-'} | ${r.to} | ${(r.task || '').slice(0, 60)} | ${(r.statusReason || '').slice(0, 80)} |`);
    }
    lines.push('');
  }

  // === 止まった ===
  if (agenda.stalled.length) {
    lines.push('## 🔴 止まっている依頼');
    lines.push('| 依頼ID | 案件 | 担当PC | 状態理由 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of agenda.stalled) {
      lines.push(`| ${r.id} | ${r.caseName || '-'} | ${r.ownerPc || '-'} | ${(r.statusReason || '').slice(0, 100)} |`);
    }
    lines.push('');
  }

  // === 期限超過 ===
  if (agenda.overdue.length) {
    lines.push('## 🔴 期限超過');
    lines.push('| 依頼ID | 案件 | 依頼先 | 期限 | 状態 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of agenda.overdue) {
      lines.push(`| ${r.id} | ${r.caseName || '-'} | ${r.to} | ${r.dueAt || '-'} | ${r.status} |`);
    }
    lines.push('');
  }

  // === 今日期限 ===
  if (agenda.dueToday.length) {
    lines.push(`## 📅 ${agenda.date} 期限`);
    lines.push('| 依頼ID | 案件 | 依頼先 | 期限 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of agenda.dueToday) {
      lines.push(`| ${r.id} | ${r.caseName || '-'} | ${r.to} | ${r.dueAt || '-'} |`);
    }
    lines.push('');
  }

  // === 案件別 ===
  lines.push('## 📋 案件別フォローアップ');
  for (const [caseName, rows] of Object.entries(agenda.byCase)) {
    lines.push(`### ${caseName}`);
    lines.push('| 依頼ID | 依頼先 | 状態 | 期限 | 内容抜粋 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of rows) {
      lines.push(`| ${r.id} | ${r.to} | ${r.status} | ${r.dueAt || '-'} | ${(r.task || '').slice(0, 80)} |`);
    }
    lines.push('');
  }

  // === サマリ ===
  lines.push('## サマリ');
  lines.push(`- 総件数: ${agenda.summary.total}`);
  lines.push(`- エスカレーション: ${agenda.summary.escalated}`);
  lines.push(`- 止まった: ${agenda.summary.stalled}`);
  lines.push(`- 期限超過: ${agenda.summary.overdue}`);
  lines.push(`- ${agenda.date} 期限: ${agenda.summary.dueToday}`);
  lines.push(`- 待機中: ${agenda.summary.pending}`);
  lines.push(`- 案件数: ${agenda.summary.cases}`);
  lines.push('');

  return lines.join('\n');
}

function parseArgs(argv = []) {
  const out = { origin: 'auto', output: '', date: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--origin') out.origin = argv[++i] || 'auto';
    else if (a === '--output') out.output = argv[++i] || '';
    else if (a === '--date') out.date = argv[++i] || '';
  }
  return out;
}

function isEntry() {
  try {
    return process.argv[1] && (
      process.argv[1].includes('followup-ledger-agenda')
      || process.argv[1].includes('followup-ledger-agenda.mjs')
    );
  } catch { return false; }
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const ledger = loadLocalLedger();

  // Target: tomorrow (default). Allow override via --date.
  const today = new Date();
  const targetStr = args.date || nextBusinessDay(jstDateStr(today));

  const agenda = generateAgenda(targetStr, ledger);

  // Output
  const md = formatMd(agenda);
  const json = JSON.stringify(agenda, null, 2);

  if (args.output) {
    const dir = path.dirname(args.output);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(args.output, md, 'utf8');
    // Also write JSON next to it
    const jsonPath = args.output.replace(/\.\w+$/, '.json');
    fs.writeFileSync(jsonPath, json, 'utf8');
    console.log(`Agenda written to ${args.output}`);
    console.log(`JSON written to ${jsonPath}`);
  } else {
    console.log(md);
  }

  // Summary JSON for script consumption
  const summaryJson = JSON.stringify({
    ok: true,
    targetDate: targetStr,
    summary: agenda.summary,
    output: args.output || '(stdout)',
  });
  console.log(`\n__AGENDA_SUMMARY__${summaryJson}__`);
}

if (isEntry()) {
  main().catch((error) => {
    console.error(`followup-ledger-agenda: ${error.message || error}`);
    process.exit(1);
  });
}