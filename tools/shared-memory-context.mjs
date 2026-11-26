#!/usr/bin/env node
import os from 'node:os';
import { staleMemoryContext } from './lib/shared-memory-freshness.mjs';
import { isEntry } from './is-entry.mjs';

export function context(options = {}) {
  const additionalContext = staleMemoryContext(options.home || process.env.ORGIAST_HOME || os.homedir(), options.now || Date.now());
  return additionalContext ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } } : null;
}

if (isEntry(import.meta.url)) {
  const output = context();
  if (output) console.log(JSON.stringify(output));
}
