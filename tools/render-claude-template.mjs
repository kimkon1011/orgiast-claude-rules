#!/usr/bin/env node
// Pure local rendering: no settings, home-directory writes, network or hook registration.
import fs from 'node:fs';
import { build, makeIndex } from './onboarding-sync.mjs';
import { isEntry } from './is-entry.mjs';

export function renderTemplate() {
  const preferences = fs.readFileSync(new URL('./claude-md-preferences.md', import.meta.url), 'utf8');
  const source = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  return build(preferences, makeIndex(source), 'ONBOARDING.md').updated;
}

if (isEntry(import.meta.url)) {
  const target = new URL('../CLAUDE.md.template', import.meta.url);
  const rendered = renderTemplate();
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== rendered) {
      console.error('CLAUDE.md.template is stale: run node tools/render-claude-template.mjs');
      process.exitCode = 1;
    }
  } else fs.writeFileSync(target, rendered);
}
