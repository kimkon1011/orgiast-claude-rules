#!/usr/bin/env node
// 各PCで毎日03:15に動くフリート管理エージェント。任意コマンドは実行しない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const dry = process.argv.includes('--dry');
const home = process.env.ORGIAST_HOME || os.homedir();
const scriptRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const candidates = [process.env.ORGIAST_REPO, path.join(home, 'orgiast-claude-rules'), path.join(home, 'Downloads', 'orgiast-claude-rules'), scriptRepo].filter(Boolean);
const repo = candidates.find(p => fs.existsSync(path.join(p, 'tools')));
const claudeDir = path.join(home, '.claude');

function readEnv(file) {
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) values[match[1].trim()] = match[2].trim();
    }
  } catch {}
  return values;
}

const env = readEnv(path.join(claudeDir, 'cost-reporter.env'));
const label = env.REPORTER_LABEL || (process.platform === 'win32' ? process.env.COMPUTERNAME : os.hostname()) || 'unknown';
const webhook = env.DISCORD_COST_WEBHOOK || env.COST_WEBHOOK || '';
const commandUrl = process.env.ORGIAST_FLEET_COMMAND_URL || 'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/fleet-command.json';

async function post(message) {
  if (dry) {
    console.log(`[DRY POST] ${message}`);
    return;
  }
  if (!webhook) return;
  try {
    await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: message }), signal: AbortSignal.timeout(20_000) });
  } catch {}
}

function run(program, args) {
  const result = spawnSync(program, args, { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
  return `${result.stdout || ''}${result.stderr || ''}`;
}

function verifySetup() {
  if (!repo) return '';
  return process.platform === 'win32'
    ? run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools', 'verify-setup.ps1')])
    : run('bash', [path.join(repo, 'tools', 'selftest-install.sh')]);
}

function taskOutput(task) {
  if (!repo) return '';
  if (task === 'verify-setup') return verifySetup();
  if (task === 'rules-resync') {
    return process.platform === 'win32'
      ? run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(home, '.claude', 'hooks', 'onboarding-sync.ps1'), '-Force'])
      : run('node', [path.join(repo, 'tools', 'onboarding-sync.mjs'), '--force']);
  }
  if (task === 'cost-report') return run('node', [path.join(repo, 'tools', 'claude-cost-reporter.mjs')]);
  return '';
}

fs.mkdirSync(claudeDir, { recursive: true });

// A) 20時間に1回の自己ヘルスレポート。
const guard = path.join(claudeDir, '.fleet-report-guard');
let dueDaily = true;
try { dueDaily = Date.now() - fs.statSync(guard).mtimeMs >= 20 * 60 * 60 * 1000; } catch {}
if (dueDaily && repo) {
  try { fs.writeFileSync(guard, new Date().toISOString()); } catch {}
  const output = verifySetup();
  if (output) {
    const lines = output.split(/\r?\n/);
    const ok = lines.filter(line => /\[OK\s*\]/.test(line)).length;
    const ngLines = lines.filter(line => /\[NG\s*\]/.test(line));
    const ngItems = ngLines.map(line => line.replace(/^.*\[NG\s*\]\s*/, '').trim()).filter(Boolean).join(' / ');
    const tail = ngLines.length ? ` … NG: ${ngItems}` : '';
    await post(`${ngLines.length ? '⚠' : '✅'} **[${label}]** 日次設定チェック: OK ${ok} / NG ${ngLines.length}${tail}`);
  }
}

// B) 中央キュー。runId は実行前に記録し、ホワイトリスト以外は決して実行しない。
try {
  const response = await fetch(commandUrl, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const command = await response.json();
  const runId = String(command.runId || '');
  const task = String(command.task || '');
  const targets = String(command.targets || '');
  if (runId && task && repo) {
    const processedFile = path.join(claudeDir, '.fleet-processed');
    let done = [];
    try { done = fs.readFileSync(processedFile, 'utf8').split(/\r?\n/); } catch {}
    const matches = targets === 'all' || targets === '' || label.includes(targets);
    if (!done.includes(runId) && matches) {
      fs.appendFileSync(processedFile, `${runId}\n`);
      const allowed = new Set(['verify-setup', 'rules-resync', 'cost-report']);
      if (allowed.has(task)) {
        const result = taskOutput(task);
        const summary = result.split(/\r?\n/).filter(line => /結果:|OK |NG |完了|エラー|error/i.test(line)).slice(-3).join(' / ');
        await post(`▶ **[${label}]** タスク『${task}』実行 (runId=${runId}): ${summary}`);
      } else {
        await post(`⚠ **[${label}]** 未許可タスク『${task}』は実行しません(ホワイトリスト外)`);
      }
    }
  }
} catch {}
