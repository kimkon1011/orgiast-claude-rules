#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repairEnvBom } from './env-repair.mjs';
import { isEntry } from './is-entry.mjs';

export const REQUIRED_HOOKS = [
  ['PreToolUse', 'pretooluse-bash-delegation.mjs'],
  ['PreToolUse', 'model-agent-guard.mjs'],
  ['UserPromptSubmit', 'cost-routing-gate.mjs'],
  ['UserPromptSubmit', 'expensive-session-guard.mjs'],
  ['UserPromptSubmit', 'session-purpose-gate.mjs'],
  ['UserPromptSubmit', 'makimono-gate.mjs'],
  ['UserPromptSubmit', 'fable-session-guard.mjs'],
  ['SessionStart', 'fable-session-guard.mjs'],
  ['SessionStart', 'hook-selfcheck.mjs'],
  // 旧Windows機は SessionStart に凍結コピーの onboarding-sync.ps1 が居座り、リポ自己更新も
  // keyserve の鍵配布(provisionKeys)も走らない。ここで「欠落」と判定させて register-hooks に
  // .mjs へ移行させる(.ps1 は 'onboarding-sync.mjs' を含まないので includes 判定で欠落になる)。
  ['SessionStart', 'onboarding-sync.mjs'],
];

export function missingSkills({ home, repo }) {
  try {
    return fs.readdirSync(path.join(repo, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => !fs.existsSync(path.join(home, '.claude', 'skills', name, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

// junction 経由(~/orgiast-claude-rules -> Downloads)でも判定が外れないよう isEntry を使う。
// 素の path.resolve 比較だと SessionStart hook が無言で何もしなくなる(is-entry.mjs のコメント参照)。
const isMain = isEntry(import.meta.url);
if (isMain) try {
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
  const skills = missingSkills({ home, repo });
  if (skills.length) {
    spawnSync(process.execPath, [path.join(repo, 'tools', 'onboarding-sync.mjs'), '--force'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
    console.log(`🚨 skill が ${skills.length} 本未配備だったため再配布しました: ${skills.join(', ')}`);
  }
} catch {}
if (isMain) process.exit(0);
