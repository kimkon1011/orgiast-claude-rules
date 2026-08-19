#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repairEnvBom } from './env-repair.mjs';

export const REQUIRED_HOOKS = [
  ['PreToolUse', 'model-agent-guard.mjs'],
  ['UserPromptSubmit', 'cost-routing-gate.mjs'],
  ['UserPromptSubmit', 'session-purpose-gate.mjs'],
  ['UserPromptSubmit', 'makimono-gate.mjs'],
  ['SessionStart', 'hook-selfcheck.mjs'],
];
try {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const repo = process.env.ORGIAST_REPO || path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const repaired = repairEnvBom({ home });
  if (repaired.length) console.log(`🔧 ~/.claude/*.env の BOM を除去しました(${repaired.length}件) — 安いAI委譲が無効化されていました`);
  const settingsFile = path.join(home, '.claude', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const missing = REQUIRED_HOOKS.filter(([event, script]) => !(settings.hooks?.[event] || []).some((group) => (group.hooks || []).some((hook) => String(hook.command || '').includes(script))));
  if (missing.length) {
    spawnSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
    console.log(`🚨 コスト規律hookが ${missing.length} 本欠落していたため自動登録しました: ${missing.map(([event, script]) => `${event}/${script}`).join(', ')}（次回セッションから有効）`);
  }
} catch {}
process.exit(0);
