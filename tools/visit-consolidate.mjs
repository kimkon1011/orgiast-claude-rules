#!/usr/bin/env node
// 期限確認と訪問集約（rules/absolute-rules.md「期限確認と訪問集約」・portable-knowhow/12）。
//   run   : 期限台帳を読み、訪問・郵送の予定を全案件の必要書類と突き合わせて ~/.claude/deadline-watch/visit-consolidation.md に書く（毎朝 07:40、000）
//   check : 訪問予定を決める前に、その窓口でまとめられる用事と訪問を避ける道を出す  --office 法務局 [--date 2026-11-30]
//   gate  : 選択肢を出す前に、期限と到着日で「出してよい／出さない」を判定する      --json options.json
// 外部への送信・台帳への書き込みはしない（読むだけ）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { gateOptions } from './lib/deadline-gate.mjs';
import { consolidate, renderReport } from './lib/visit-consolidate-core.mjs';

const officesPath = fileURLToPath(new URL('../config/visit-offices.json', import.meta.url));
const autopilotPath = fileURLToPath(new URL('../config/schedule-autopilot.json', import.meta.url));
const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const arg = (argv, name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };

export function loadOffices() { return JSON.parse(fs.readFileSync(officesPath, 'utf8')); }

async function readLedgerRows(argv) {
  const file = arg(argv, 'file');
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  const { createLedger } = await import('./deadline-ledger.mjs');
  const { createSheetsClient } = await import('./lib/sheets-dwd.mjs');
  const { gwsFetch } = await import('./lib/gws-proxy.mjs');
  const sheetId = JSON.parse(fs.readFileSync(autopilotPath, 'utf8')).ledgerSheetId;
  const ledger = createLedger({ sheets: createSheetsClient({ fetchImpl: gwsFetch }), config: { sheetId } });
  return ledger.read();
}

export async function main(argv = process.argv.slice(2), { log = console.log, home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const cmd = argv[0] || 'run';
  const today = arg(argv, 'today') || jstToday();
  if (cmd === 'gate') {
    const input = JSON.parse(fs.readFileSync(arg(argv, 'json'), 'utf8'));
    const res = gateOptions({ today, ...input });
    log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 2;
  }
  const dict = loadOffices();
  const rows = await readLedgerRows(argv);
  const result = consolidate(rows, { ...dict, today });
  if (cmd === 'check') {
    const office = arg(argv, 'office'); const date = arg(argv, 'date') || '';
    if (!office) { log('--office が必要です（例: 法務局）'); return 1; }
    const synthetic = consolidate([...rows, { id: 'NEW', title: `${office}へ訪問予定`, notes: `訪問:${date || today}@${office}`, status: '未着手', due: date }], { ...dict, today });
    const plan = synthetic.visitPlans.find(v => v.id === 'NEW');
    log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const sheetId = JSON.parse(fs.readFileSync(autopilotPath, 'utf8')).ledgerSheetId;
  const md = renderReport(result, { today, ledgerUrl: `https://docs.google.com/spreadsheets/d/${sheetId}/edit` });
  const out = arg(argv, 'out') || path.join(home, '.claude', 'deadline-watch', 'visit-consolidation.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md);
  fs.writeFileSync(out.replace(/\.md$/, '.json'), JSON.stringify({ today, ...result }, null, 2));
  log(md);
  return 0;
}

if (isEntry(import.meta.url)) main().then(c => process.exit(c), e => { console.error(e?.stack || e); process.exit(1); });
