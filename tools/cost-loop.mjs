#!/usr/bin/env node
// SessionStart: 前回のコスト×作業量ループを注入し、重い集計は裏で起動する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const g = setTimeout(() => process.exit(0), 3000); g.unref();

const home = process.env.ORGIAST_HOME || os.homedir();
const candidates = (name) => [
  path.join(home, 'orgiast-claude-rules', 'tools', name),
  path.join(home, 'Downloads', 'orgiast-claude-rules', 'tools', name),
];
const firstFile = (name) => candidates(name).find((p) => fs.existsSync(p));
const background = (script, args = []) => {
  try { spawn(process.execPath, [script, ...args], { detached: true, stdio: 'ignore' }).unref(); } catch {}
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
    const ctx = `【コスト×作業量ループ｜監督への自己指示】前回計測の結果は下記。Claude以外への委譲率が低い/コスト効率が悪化している時は、作業前に必ず: 実装→Codex(定額) / 量産・分類→Groq / 汎用の安い推論→OpenRouter / 長文脈→Gemini / 別課金へ逃がす→Kimi、へ回す。監督(Opus)は最小限にとどめ大きな実装を抱えない(§1.18)。\n\n${txt}`;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } })}\n`);
  }
} catch {}
