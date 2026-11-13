#!/usr/bin/env node
// 読み取りのみ。HOME は変更せず、Windows の実台帳は --home で指定できる。
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { ledgerFile, readLedger } from './auto-progress-ledger.mjs';
import { restoreMigrationClobbers, migrationClobberRestorationRows } from './auto-progress-watch.mjs';
const homeIndex = process.argv.indexOf('--home');
const home = homeIndex < 0 ? process.env.ORGIAST_HOME || os.homedir() : process.argv[homeIndex + 1];
if (!home) throw new Error('--home requires a path');
const file = ledgerFile(home);
const hash = () => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash();
const asOfIndex = process.argv.indexOf('--as-of');
const asOf = asOfIndex < 0 ? null : Date.parse(process.argv[asOfIndex + 1]);
if (asOfIndex >= 0 && !Number.isFinite(asOf)) throw new Error('--as-of requires an ISO timestamp');
const targets = asOf === null ? (await restoreMigrationClobbers({ home, dryRun: true })).targets :
  migrationClobberRestorationRows(readLedger(file).filter(row => Date.parse(row.ts) <= asOf));
console.log(JSON.stringify({ file, asOf: asOf === null ? null : new Date(asOf).toISOString(), count: targets.length, targets: targets.map(row => ({ session: String(row.sessionId).slice(0, 8), label: row.label || row.promise, status: row.status })), unchanged: before === hash() }, null, 2));
