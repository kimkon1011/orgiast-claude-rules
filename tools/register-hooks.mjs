#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = process.env.ORGIAST_HOME || os.homedir();
const repo = process.env.ORGIAST_REPO || path.join(home, 'orgiast-claude-rules');
const geminiKey = process.env.ORGIAST_GEMINI_KEY || readGeminiKey();
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
function readGeminiKey() {
  try { return fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith('GEMINI_API_KEY='))?.slice(15) || ''; } catch { return ''; }
}
function load(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8');
  return raw.trim() ? JSON.parse(raw) : {};
}
function backup(file) { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${stamp}-installer`); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function commands(groups) { return groups.flatMap((g) => Array.isArray(g?.hooks) ? g.hooks : []).map((h) => String(h?.command || '')); }
function add(groups, scriptName, group) {
  if (commands(groups).some((cmd) => cmd.includes(scriptName))) return false;
  groups.push(group); return true;
}

try {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  backup(settingsFile);
  const settings = load(settingsFile);
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ['SessionStart', 'PreToolUse', 'Stop']) if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const command = (name, extra = '') => `node "${path.join(repo, 'tools', name)}"${extra}`;
  const session = [
    ['onboarding-sync.mjs', 20, true, ''],
    ['claude-cost-reporter.mjs', 15, true, ''],
    ['tool-adoption-check.mjs', 30, true, ' --fix'],
    ['cost-loop.mjs', 15, false, ''],
  ];
  for (const [name, timeout, async, extra] of session) {
    const hook = { type: 'command', command: command(name, extra), timeout };
    if (async) hook.async = true;
    add(settings.hooks.SessionStart, name, { hooks: [hook] });
  }
  add(settings.hooks.PreToolUse, 'pretooluse-delegation-warn.mjs', { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: command('pretooluse-delegation-warn.mjs') }] });
  add(settings.hooks.Stop, 'verify-before-done-detector.mjs', { hooks: [{ type: 'command', command: command('verify-before-done-detector.mjs') }] });
  write(settingsFile, settings);

  const claudeFile = path.join(home, '.claude.json');
  backup(claudeFile);
  const claude = load(claudeFile);
  if (!claude.mcpServers || typeof claude.mcpServers !== 'object' || Array.isArray(claude.mcpServers)) claude.mcpServers = {};
  claude.mcpServers['gemini-cli'] = { type: 'stdio', command: 'npx', args: ['-y', '@choplin/mcp-gemini-cli', '--allow-npx'], env: { GEMINI_API_KEY: geminiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
  write(claudeFile, claude);
  console.log('  [OK] settings.json / .claude.json 更新(バックアップ済)');
} catch (e) {
  console.error(`  [注意] 設定登録に失敗: ${e.message}`);
  process.exitCode = 1;
}
