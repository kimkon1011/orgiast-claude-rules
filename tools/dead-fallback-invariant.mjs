#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function findGuardedScripts(repoDir) {
  const toolsDir = path.join(repoDir, 'tools');
  let entries;
  try { entries = fs.readdirSync(toolsDir, { withFileTypes: true }); }
  catch { return []; }

  return entries
    .filter((entry) => entry.isFile() && /^register-.*\.ps1$/.test(entry.name))
    .filter((entry) => {
      try {
        const content = fs.readFileSync(path.join(toolsDir, entry.name), 'utf8');
        return content.includes('ensure-run-hidden.ps1') && content.includes('Test-Path');
      } catch { return false; }
    })
    .map((entry) => `tools/${entry.name}`)
    .sort();
}

export function helperExists(repoDir) {
  return fs.existsSync(path.join(repoDir, 'tools', 'ensure-run-hidden.ps1'));
}

export function buildRecords({ repoDir, guardedScripts, helperPresent }) {
  void repoDir;
  const action = helperPresent ? 'uptodate' : 'flagged';
  const reason = helperPresent
    ? 'ensure-run-hidden.ps1 present; fallback branch is dead code but harmless'
    : 'ensure-run-hidden.ps1 missing; fallback branch is reachable and will show a console window (#185 regression)';
  return guardedScripts.map((file) => ({ tool: 'dead-fallback-invariant', file, action, reason }));
}

export function appendLedger(ledgerFile, record) {
  try {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.appendFileSync(ledgerFile, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  } catch (error) {
    console.error(`[dead-fallback-invariant] ledger write failed: ${error.message}`);
  }
}

export function runCheck({ repo, home, dryRun = false } = {}) {
  const resolvedHome = home || process.env.ORGIAST_HOME || os.homedir();
  const resolvedRepo = repo || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const ledgerFile = process.env.ORGIAST_SELFHEAL_LEDGER
    || path.join(resolvedHome, '.claude', 'hook-selfheal-ledger.jsonl');
  const guardedScripts = findGuardedScripts(resolvedRepo);
  const helperPresent = helperExists(resolvedRepo);
  const records = buildRecords({ repoDir: resolvedRepo, guardedScripts, helperPresent });
  if (!dryRun) records.forEach((record) => appendLedger(ledgerFile, record));
  return records;
}

if (isEntry(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const records = runCheck({ dryRun });
  if (dryRun) console.log(JSON.stringify(records, null, 2));
}
