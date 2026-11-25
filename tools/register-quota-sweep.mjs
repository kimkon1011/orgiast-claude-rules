#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
export function main(options = {}) {
  if ((options.platform ?? process.platform) !== 'win32') console.log('Skipped: OrgiastQuotaSweep registration requires Windows');
  return runRegisterPs1('register-quota-sweep.ps1', options);
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
