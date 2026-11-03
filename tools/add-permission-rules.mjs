#!/usr/bin/env node
// STANDARD-PC-SETUP.md 5.3 の許可ルールを ~/.claude/settings.json の permissions.allow へ追記する。
// B（読み取り専用6行）は常に、A（本番反映9行）は利用者の了承を得て --with-prod を付けたときだけ追加する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const PROD_RULES = [
  'Bash(clasp push*)', 'Bash(clasp deploy*)', 'Bash(clasp version*)', 'Bash(npx clasp push*)', 'Bash(npx clasp deploy*)',
  'Bash(vercel --prod*)', 'Bash(vercel deploy --prod*)', 'Bash(npx vercel --prod*)', 'Bash(npx vercel deploy --prod*)',
];
export const READ_RULES = [
  'Bash(gh secret list*)', 'Bash(gh variable list*)', 'Bash(curl -s "https://raw.githubusercontent.com/kimkon1011/*")',
  'PowerShell(node * makimono-publish.mjs *)', 'PowerShell((Get-ScheduledTask*).Actions.Arguments)', 'PowerShell(Get-ScheduledTask -TaskName *)',
];

export function addRules(settings, rules) {
  settings.permissions ??= {};
  settings.permissions.allow ??= [];
  const added = rules.filter(rule => !settings.permissions.allow.includes(rule));
  settings.permissions.allow.push(...added);
  return added;
}

function main(argv) {
  const withProd = argv.includes('--with-prod');
  const checkOnly = argv.includes('--check');
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  const raw = fs.readFileSync(file, 'utf8');
  const settings = JSON.parse(raw);
  const rules = withProd ? [...PROD_RULES, ...READ_RULES] : READ_RULES;
  if (!checkOnly) {
    const added = addRules(settings, rules);
    if (added.length) {
      fs.writeFileSync(`${file}.bak.${Date.now()}-perms`, raw);
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    }
  }
  const allow = JSON.parse(fs.readFileSync(file, 'utf8')).permissions?.allow ?? [];
  const missing = rules.filter(rule => !allow.includes(rule));
  console.log(`permission-rules: ${rules.length - missing.length}/${rules.length} present${withProd ? ' (A+B)' : ' (B)'}`);
  for (const rule of missing) console.log(`  missing: ${rule}`);
  return missing.length ? 1 : 0;
}

if (isEntry(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
