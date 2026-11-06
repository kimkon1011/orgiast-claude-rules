#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';

export function main(options = {}) {
  return runRegisterPs1('register-knowledge-merge-task.ps1', options);
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; }
}