#!/usr/bin/env node
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { isEntry } from './is-entry.mjs';
export function main(options = {}) { return runRegisterPs1('register-rule-compliance-task.ps1', options); }
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
