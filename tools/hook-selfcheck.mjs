#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repairEnvBom } from './env-repair.mjs';
import { isEntry } from './is-entry.mjs';
import { deploySkills } from './onboarding-sync.mjs';

export const REQUIRED_HOOKS = [
  ['PreToolUse', 'pretooluse-bash-delegation.mjs'],
  ['PreToolUse', 'pretooluse-codex-invocation.mjs'],
  ['PreToolUse', 'model-agent-guard.mjs'],
  ['UserPromptSubmit', 'cost-routing-gate.mjs'],
  ['UserPromptSubmit', 'expensive-session-guard.mjs'],
  ['UserPromptSubmit', 'session-purpose-gate.mjs'],
  ['UserPromptSubmit', 'makimono-gate.mjs'],
  ['UserPromptSubmit', 'fable-session-guard.mjs'],
  ['UserPromptSubmit', 'current-session.mjs'],
  ['SessionStart', 'fable-session-guard.mjs'],
  ['SessionStart', 'session-list-tidy.mjs'],
  ['SessionStart', 'hook-selfcheck.mjs'],
  ['SessionStart', 'makimono-host-detect.mjs'],
  // 旧Windows機は SessionStart に凍結コピーの onboarding-sync.ps1 が居座り、リポ自己更新も
  // keyserve の鍵配布(provisionKeys)も走らない。ここで「欠落」と判定させて register-hooks に
  // .mjs へ移行させる(.ps1 は 'onboarding-sync.mjs' を含まないので includes 判定で欠落になる)。
  ['SessionStart', 'onboarding-sync.mjs'],
];

export const REQUIRED_TASKS = [
  ['OrgiastAutoSession', 'tools/register-auto-session.ps1'],
];

const TASK_SELFCHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;

function normalizedTaskName(name) {
  return String(name).trim().replace(/^\\+/, '').toLowerCase();
}

export function missingScheduledTasks(existingNames, required = REQUIRED_TASKS) {
  const existing = new Set(existingNames.map(normalizedTaskName));
  return required.filter(([name]) => !existing.has(normalizedTaskName(name)));
}

export function shouldRunTaskSelfcheck(lastRun, now = Date.now(), intervalMs = TASK_SELFCHECK_INTERVAL_MS) {
  const lastRunMs = Number(lastRun);
  return !Number.isFinite(lastRunMs) || lastRunMs > now || now - lastRunMs >= intervalMs;
}

function scheduledTaskNames(csv) {
  return String(csv).split(/\r?\n/).map((line) => {
    const match = line.match(/^"((?:[^"]|"")*)"/);
    return match ? match[1].replace(/""/g, '"') : '';
  }).filter(Boolean);
}

function repairScheduledTasks({ home, repo }) {
  if (process.platform !== 'win32') return;
  const stampFile = path.join(home, '.claude', '.task-selfcheck-stamp');
  let lastRun;
  try { lastRun = fs.readFileSync(stampFile, 'utf8').trim(); } catch {}
  if (!shouldRunTaskSelfcheck(lastRun)) return;

  const query = spawnSync('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (query.error || query.status !== 0) return;

  try {
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, String(Date.now()));
  } catch {}

  const missing = missingScheduledTasks(scheduledTaskNames(query.stdout));
  for (const [name, script] of missing) {
    const result = spawnSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', path.join(repo, script),
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true });
    if (!result.error && result.status === 0) console.log(`🚨 必須スケジュールタスク ${name} が欠落していたため自動登録しました`);
  }
}

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
    // onboarding-sync --force を spawn しない: あちらの repoPath は home から導出され ORGIAST_REPO を
    // 見ないため、配布が1件も起きていないのに成功したように見える(実測)。deploySkills を直接呼び、
    // 配布後にもう一度数え直して「実際に配備できたか」で報告を分ける。
    const deployed = deploySkills(repo, home, { quiet: true });
    const still = missingSkills({ home, repo });
    if (still.length) console.log(`🚨 skill ${still.length} 本が未配備のままです(配布失敗): ${still.join(', ')} — node ${path.join(repo, 'tools', 'onboarding-sync.mjs')} --force を実行してください`);
    else console.log(`🚨 skill が ${skills.length} 本未配備だったため再配布しました: ${deployed.join(', ')}`);
  }
  repairScheduledTasks({ home, repo });
} catch {}
if (isMain) process.exit(0);
