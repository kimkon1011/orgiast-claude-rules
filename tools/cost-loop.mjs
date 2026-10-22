#!/usr/bin/env node
// SessionStart: 前回のコスト×作業量ループを注入し、重い集計は裏で起動する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { backgroundSpawnOptions } from './lib/background-spawn.mjs';

const home = process.env.ORGIAST_HOME || os.homedir();
const candidates = (name) => [
  path.join(home, 'orgiast-claude-rules', 'tools', name),
  path.join(home, 'Downloads', 'orgiast-claude-rules', 'tools', name),
];
const firstFile = (name) => candidates(name).find((p) => fs.existsSync(p));
const background = (script, args = []) => {
  try { spawn(process.execPath, [script, ...args], { ...backgroundSpawnOptions(), stdio: 'ignore' }).unref(); } catch {}
};
const batchRecentlyRan = () => {
  const lock = path.join(os.homedir(), '.claude', 'locks', 'batch-run.lock');
  try {
    const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
    process.kill(Number(owner.pid), 0);
    console.error(`[cost-loop] batch-run already running pid=${owner.pid}`);
    return true;
  } catch {}
  const last = path.join(home, '.claude', 'state', 'batch-run.last');
  try {
    const age = Date.now() - Date.parse(fs.readFileSync(last, 'utf8').trim());
    if (Number.isFinite(age) && age >= 0 && age < 6 * 60 * 60 * 1000) {
      console.error('[cost-loop] batch-run skipped: last run was within 6 hours');
      return true;
    }
  } catch {}
  return false;
};

try {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  const pending = path.join(home, '.claude', 'batch-queue', 'pending.jsonl');
  const batch = firstFile('batch-run.mjs');
  if ((mins >= 990 || mins < 30) && batch && fs.existsSync(pending) && fs.statSync(pending).size > 0 && !batchRecentlyRan()) background(batch);
} catch {}

try {
  const guard = path.join(home, '.claude', '.cost-loop-guard');
  const loop = firstFile('cost-work-loop.mjs');
  const due = !fs.existsSync(guard) || Date.now() - fs.statSync(guard).mtimeMs >= 20 * 60 * 60 * 1000;
  if (due && loop) {
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.writeFileSync(guard, new Date().toISOString(), 'utf8');
    background(loop, ['--days=7', '--post']);
  }
} catch {}

// 夜間タスクが止まった場合も、次回 SessionStart で領収書の空白を埋める。
try {
  const guard = path.join(home, '.claude', '.receipt-scan-guard');
  const scan = firstFile('ai-receipt-scan.mjs');
  const due = !fs.existsSync(guard) || Date.now() - fs.statSync(guard).mtimeMs >= 20 * 60 * 60 * 1000;
  if (due && scan) {
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.writeFileSync(guard, new Date().toISOString(), 'utf8');
    background(scan, ['--if-stale', '30', '--notify']);
  }
} catch {}

// Discord webhook の死活監視。webhook は Discord 側で消されると 404 になり、
// .env が古いURLを指したまま通知が無言で止まる(実測: 2026-08-19 に死んで 6日間気付かず
// 日次コスト自己申告が停止)。1日1回チェックし、同一チャンネルの生存webhookがあれば自動修復する。
try {
  const guard = path.join(home, '.claude', '.webhook-health-guard');
  const health = firstFile('webhook-health.mjs');
  const due = !fs.existsSync(guard) || Date.now() - fs.statSync(guard).mtimeMs >= 20 * 60 * 60 * 1000;
  if (due && health) {
    fs.mkdirSync(path.dirname(guard), { recursive: true });
    fs.writeFileSync(guard, new Date().toISOString(), 'utf8');
    background(health, ['--fix']);
  }
} catch {}

try {
  const directive = path.join(home, '.claude', 'cost-directive.md');
  if (fs.existsSync(directive)) {
    const txt = fs.readFileSync(directive, 'utf8');
    const ctx = `【監督への自己指示】最優先は user の手間（往復回数・同じ指摘の繰り返し・差し戻しで長くなった応答）を減らすこと。トークン・委譲率はその次。user に手作業や手順を渡す前の調査（過去ログ・memory・playbook）は回数無制限。実装→Codex(定額) / 量産・分類→Groq / 長文脈→Gemini への委譲は、調査の深さを削らない範囲で行う。\n\n${txt}`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })}\n`);
  }
} catch {}
