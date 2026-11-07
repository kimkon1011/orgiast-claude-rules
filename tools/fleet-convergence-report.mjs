#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectConvergence } from './fleet-convergence.mjs';
import { parseEnvText } from './env-kv.mjs';
import { resolveFleetLabel } from './fleet-mail.mjs';
import { isEntry } from './is-entry.mjs';
export async function reportConvergence({ home = process.env.ORGIAST_HOME || os.homedir(),
  repo = process.env.ORGIAST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  fetchImpl = fetch, identity, dryRun = false } = {}) {
  const row = collectConvergence({ home, repo, ...identity });
  const label = resolveFleetLabel(home, identity);
  if (dryRun) return { ...row, label, sent: false };
  const config = parseEnvText(fs.readFileSync(path.join(home, '.claude/fleet-sheet.env'), 'utf8'));
  if (!config.FLEET_SHEET_URL || !config.FLEET_SHEET_TOKEN) throw new Error('fleet transport unavailable');
  const response = await fetchImpl(config.FLEET_SHEET_URL, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...row, label, convergenceOnly: true, token: config.FLEET_SHEET_TOKEN }), signal: AbortSignal.timeout(60000) });
  const result = await response.json();
  if (!response.ok || result.ok !== true || result.convergence !== row.convergenceId) throw new Error('convergence receipt missing; GAS deployment/read-back required');
  return { ...row, label, sent: true, sheetRow: result.row };
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(await reportConvergence({ dryRun: process.argv.includes('--dry-run') }))); }
  catch { console.error('fleet-convergence-report failed (transport/receipt unavailable; secrets omitted)'); process.exitCode = 1; }
}
