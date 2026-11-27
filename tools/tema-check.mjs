#!/usr/bin/env node
import fs from 'node:fs';
import { checkTema, formatTemaFindings } from './lib/tema-check.mjs';
import { parseTemaRecord } from './lib/tema-check.mjs';
import { assertNoHandback } from './lib/handback-guard.mjs';
import { saveTemaRecord } from './lib/tema-record-store.mjs';
import { stripHumanOnly } from './lib/handback-guard.mjs';
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ''; };
try {
  const file = value('--file');
  if (!file) throw new Error('--file <下書き> が必要です');
  const body = fs.readFileSync(file, 'utf8');
  const result = checkTema(body, { kind: value('--kind') || 'send' });
  if (result.ok && args.includes('--save')) {
    const record = parseTemaRecord(body);
    if (!record) throw Error('--save には [TEMA-CHECK] 記録が必要です');
    if ((value('--kind') || 'send') === 'send') assertNoHandback(body, { channel: value('--channel') || 'send' });
    else saveTemaRecord(stripHumanOnly(body), record, { channel: value('--channel') || value('--kind') });
  }
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.ok ? '手間チェック: 合格' : formatTemaFindings(result.findings));
  process.exitCode = result.ok ? 0 : 2;
} catch (error) { console.error(`tema-check: ${error.message}`); process.exitCode = 2; }
