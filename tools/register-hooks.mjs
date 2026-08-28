#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hooksOnly = process.argv.includes('--hooks-only');
const home = process.env.ORGIAST_HOME || os.homedir();
const repo = process.env.ORGIAST_REPO || path.join(home, 'orgiast-claude-rules');
const geminiKey = process.env.ORGIAST_GEMINI_KEY || readGeminiKey();
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
function readGeminiKey() {
  try { return fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith('GEMINI_API_KEY='))?.slice(15) || ''; } catch { return ''; }
}
function load(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return raw.trim() ? JSON.parse(raw) : {};
}
function backup(file) { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${stamp}-installer`); }
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function commands(groups) { return groups.flatMap((g) => Array.isArray(g?.hooks) ? g.hooks : []).map((h) => String(h?.command || '')); }
function add(groups, scriptName, group) {
  // リポの同期が遅れている環境で、存在しないスクリプトを登録して毎回 ENOENT を出すのを防ぐ。
  if (scriptName.endsWith('.mjs') && !fs.existsSync(path.join(repo, 'tools', scriptName))) return false;
  // 既存PCは .ps1 版が登録済みのことがある(Windows install)。拡張子を無視して重複判定しないと
  // .mjs と .ps1 の二重登録になり、同じ context が2回注入される。
  const base = scriptName.replace(/\.(mjs|ps1)$/, '');
  if (commands(groups).some((cmd) => cmd.includes(base))) return false;
  groups.push(group); return true;
}
function migrate(groups, oldName, newName, newCommand) {
  let changed = 0;
  for (const group of groups) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
    if (String(hook.command || '').includes(oldName) && hook.command !== newCommand) { hook.command = newCommand; changed += 1; }
  }
  // 旧hookが複数あった環境でも、新hookは1本だけに正規化する。
  let seen = false;
  for (let i = groups.length - 1; i >= 0; i--) {
    const hooks = Array.isArray(groups[i]?.hooks) ? groups[i].hooks : [];
    for (let j = hooks.length - 1; j >= 0; j--) {
      if (!String(hooks[j]?.command || '').includes(newName)) continue;
      if (seen) { hooks.splice(j, 1); changed += 1; } else seen = true;
    }
    // 複数hookを同じgroupに入れている利用者の無関係なhookは残す。
    if (hooks.length === 0) groups.splice(i, 1);
  }
  return changed;
}
function setTimeoutFor(groups, scriptName, timeout) {
  let changed = 0;
  for (const group of groups) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
    if (String(hook.command || '').includes(scriptName) && hook.timeout !== timeout) { hook.timeout = timeout; changed += 1; }
  }
  return changed;
}

try {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const settingsHadBom = fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8').startsWith('\uFEFF');
  const settings = load(settingsFile);
  let added = 0;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const command = (name, extra = '') => `node "${path.join(repo, 'tools', name)}"${extra}`;
  const session = [
    ['onboarding-sync.mjs', 20, true, ''],
    ['claude-cost-reporter.mjs', 15, true, ''],
    ['tool-adoption-check.mjs', 60, true, ' --fix'],
    ['cost-loop.mjs', 15, false, ''],
  ];
  // Windows旧版はコピー済み .ps1 に固定されるため、リポに新実装が届いた時点で正本 .mjs へ移行する。
  if (fs.existsSync(path.join(repo, 'tools', 'onboarding-sync.mjs'))) {
    added += migrate(settings.hooks.SessionStart, 'onboarding-sync.ps1', 'onboarding-sync.mjs', command('onboarding-sync.mjs'));
    for (const group of settings.hooks.SessionStart) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
      if (String(hook.command || '').includes('onboarding-sync.mjs')) { hook.timeout = 20; hook.async = true; }
    }
  }
  for (const [name, timeout, async, extra] of session) {
    const hook = { type: 'command', command: command(name, extra), timeout };
    if (async) hook.async = true;
    if (add(settings.hooks.SessionStart, name, { hooks: [hook] })) added += 1;
  }
  added += setTimeoutFor(settings.hooks.SessionStart, 'tool-adoption-check', 60);
  if (add(settings.hooks.SessionStart, 'hook-selfcheck.mjs', { hooks: [{ type: 'command', command: command('hook-selfcheck.mjs'), timeout: 10 }] })) added += 1;
  if (add(settings.hooks.SessionStart, 'makimono-host-detect.mjs', { hooks: [{ type: 'command', command: command('makimono-host-detect.mjs'), timeout: 10 }] })) added += 1;
  // 1セッション=1目的ゲート: SessionStart で目的宣言を要求し、UserPromptSubmit で目的ドリフト/肥大をナッジする(context注入のため async 禁止)
  if (add(settings.hooks.SessionStart, 'session-purpose-gate.mjs', { hooks: [{ type: 'command', command: command('session-purpose-gate.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.UserPromptSubmit, 'session-purpose-gate.mjs', { hooks: [{ type: 'command', command: command('session-purpose-gate.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.SessionStart, 'fable-session-guard.mjs', { hooks: [{ type: 'command', command: command('fable-session-guard.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.UserPromptSubmit, 'fable-session-guard.mjs', { hooks: [{ type: 'command', command: command('fable-session-guard.mjs'), timeout: 5 }] })) added += 1;
  added += migrate(settings.hooks.SessionStart, 'purge-hidden-sessions.py', 'session-list-tidy.mjs', command('session-list-tidy.mjs'));
  added += migrate(settings.hooks.UserPromptSubmit, 'purge-hidden-sessions.py', 'session-list-tidy.mjs', command('session-list-tidy.mjs'));
  if (add(settings.hooks.SessionStart, 'session-list-tidy.mjs', { hooks: [{ type: 'command', command: command('session-list-tidy.mjs'), timeout: 10, async: true }] })) added += 1;
  if (add(settings.hooks.UserPromptSubmit, 'session-list-tidy.mjs', { hooks: [{ type: 'command', command: command('session-list-tidy.mjs'), timeout: 10, async: true }] })) added += 1;
  added += migrate(settings.hooks.UserPromptSubmit, 'current-session.mjs', 'current-session.mjs', command('current-session.mjs'));
  if (add(settings.hooks.UserPromptSubmit, 'current-session.mjs', { hooks: [{ type: 'command', command: command('current-session.mjs'), timeout: 5 }] })) added += 1;
  added += migrate(settings.hooks.UserPromptSubmit, 'delegation-gate', 'cost-routing-gate.mjs', command('cost-routing-gate.mjs'));
  if (add(settings.hooks.UserPromptSubmit, 'cost-routing-gate.mjs', { hooks: [{ type: 'command', command: command('cost-routing-gate.mjs') }] })) added += 1;
  // additionalContext を返すため同期実行。高額モデル・肥大セッションを純ローカルで検知する。
  if (add(settings.hooks.UserPromptSubmit, 'expensive-session-guard.mjs', { hooks: [{ type: 'command', command: command('expensive-session-guard.mjs'), timeout: 5 }] })) added += 1;
  // 完成済み指示書の候補を同期注入するため async は付けない。
  if (add(settings.hooks.UserPromptSubmit, 'makimono-gate.mjs', { hooks: [{ type: 'command', command: command('makimono-gate.mjs'), timeout: 6 }] })) added += 1;
  added += migrate(settings.hooks.PreToolUse, 'pretooluse-delegation-warn.ps1', 'pretooluse-delegation-warn.mjs', command('pretooluse-delegation-warn.mjs'));
  if (add(settings.hooks.PreToolUse, 'pretooluse-delegation-warn.mjs', { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: command('pretooluse-delegation-warn.mjs') }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'pretooluse-bash-delegation.mjs', { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: command('pretooluse-bash-delegation.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'pretooluse-codex-invocation.mjs', { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: command('pretooluse-codex-invocation.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'model-agent-guard.mjs', { matcher: 'Agent|Task', hooks: [{ type: 'command', command: command('model-agent-guard.mjs') }] })) added += 1;
  if (add(settings.hooks.Stop, 'verify-before-done-detector.mjs', { hooks: [{ type: 'command', command: command('verify-before-done-detector.mjs') }] })) added += 1;
  // kim が読む文書をローカルパスのリンクで渡す違反を止める(モバイルで1クリックで開けない・2026-08-07 kim確定ルール)
  if (add(settings.hooks.Stop, 'doc-link-drive-guard.mjs', { hooks: [{ type: 'command', command: command('doc-link-drive-guard.mjs'), timeout: 10 }] })) added += 1;
  // 作業依頼だけを残して必要なURL・コマンドを省くと、kimが過去ログを探すため同期Stopで差し戻す。
  if (add(settings.hooks.Stop, 'handoff-info-guard.mjs', { hooks: [{ type: 'command', command: command('handoff-info-guard.mjs'), timeout: 10 }] })) added += 1;
  // 差分が無い時は書かない(日次実行で .bak が積み上がるのを防ぐ)
  if (added || settingsHadBom) { backup(settingsFile); write(settingsFile, settings); }
  if (settingsHadBom) console.log('[register-hooks] settings.json の BOM を除去しました');
  if (hooksOnly) { console.log(added ? `  [OK] settings.json に hook を ${added} 件追加(バックアップ済)` : '  [OK] hook は既に登録済み(変更なし)'); process.exit(0); }

  const claudeFile = path.join(home, '.claude.json');
  backup(claudeFile);
  const claude = load(claudeFile);
  if (!claude.mcpServers || typeof claude.mcpServers !== 'object' || Array.isArray(claude.mcpServers)) claude.mcpServers = {};
  claude.mcpServers['gemini-cli'] = { type: 'stdio', command: 'npx', args: ['-y', '@choplin/mcp-gemini-cli', '--allow-npx'], env: { GEMINI_API_KEY: geminiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true' } };
  write(claudeFile, claude);
  console.log(`  [OK] settings.json${added ? '(hook ' + added + '件追加)' : '(変更なし)'} / .claude.json 更新`);
} catch (e) {
  console.error(`  [注意] 設定登録に失敗: ${e.message}`);
  process.exitCode = 1;
}
