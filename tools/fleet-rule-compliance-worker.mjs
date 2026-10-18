#!/usr/bin/env node
// Separate entrypoint avoids a top-level-await cycle between fleet-mail and its daily helper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dailyRuleCompliance } from './fleet-rule-compliance-daily.mjs';
import { createClient, acquireLock } from './fleet-mail.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { parseEnvText } from './env-kv.mjs';
import { COMPLIANCE_CONTROLLER } from './lib/rule-compliance-mail.mjs';
import { isEntry } from './is-entry.mjs';

export async function main() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  let request;
  if (resolveFleetLabel(home) !== COMPLIANCE_CONTROLLER) {
    request = async (...args) => {
      const config = parseEnvText(fs.readFileSync(path.join(home, '.claude/fleet-sheet.env'), 'utf8'));
      return createClient({ url: config.FLEET_SHEET_URL, token: config.FLEET_SHEET_TOKEN })(...args);
    };
  }
  const repo = process.env.ORGIAST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  return dailyRuleCompliance({ home, request, repo, acquireLock });
}
if (isEntry(import.meta.url)) await main();
