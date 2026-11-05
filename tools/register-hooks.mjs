#!/usr/bin/env node
import fs from 'node:fs';
import { repositoryHooks, collapseHooks, effectiveHooks, runtimeManifestPath } from './hook-dispatch-registry.mjs';
import { execFileSync } from 'node:child_process';
let wrapRegisteredGates = () => 0;
let gateRuntimeReady = false;
try { ({ wrapRegisteredGates } = await import('./gate-hook-runner.mjs')); gateRuntimeReady = true; } catch { /* 同期途中でも既存登録を維持 */ }
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hooksOnly = process.argv.includes('--hooks-only');
const expectedJson = process.argv.includes('--expected-json');
const home = process.env.ORGIAST_HOME || os.homedir();
// 2026-09-14: ~/orgiast-claude-rules が stale で新 hook(hook-budget-check) が無言で未登録になった。
// 実行中スクリプトのツリーを基準にし、実行した版の hook を同じ版のツリーから登録する。
const scriptRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only dedicated, automatically refreshed checkouts are eligible by default.
function selectAnchor() {
  if (process.env.ORGIAST_REPO) return path.resolve(process.env.ORGIAST_REPO);
  for (const candidate of [path.join(home, '.claude', 'nightly-repo'), path.join(home, 'orgiast-claude-rules')]) {
    try {
      const git = (...args) => execFileSync('git', ['-C', candidate, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      const branch = git('branch', '--show-current');
      if ((branch && branch !== 'main') || git('status', '--porcelain')) continue;
      const head = git('rev-parse', 'HEAD');
      const main = git('rev-parse', 'refs/remotes/origin/main');
      if (head !== main) {
        // nightly-bootstrap follows origin/main with a detached HEAD. Allow a
        // short sync delay, but never a local/divergent commit or a stale tree.
        git('merge-base', '--is-ancestor', head, main);
        const age = Date.now() / 1000 - Number(git('show', '-s', '--format=%ct', head));
        if (!Number.isFinite(age) || age < 0 || age > 86400) continue;
      }
      if (!fs.existsSync(path.join(candidate, 'tools/register-hooks.mjs'))) continue;
      return candidate;
    } catch { /* missing/ZIP/divergent checkout is not a clean main anchor */ }
  }
  throw new Error(`clean な main / detached HEAD の同期 checkout がありません。自己修復: node "${path.join(scriptRepo, 'tools/onboarding-sync.mjs')}" --force`);
}
let repo;
try { repo = selectAnchor(); } catch (e) { console.error(e.message); process.exit(1); }
// Definitions and runtime must come from the selected anchor too.
if (!process.env.ORGIAST_REPO && path.resolve(repo) !== scriptRepo) {
  const result = (await import('node:child_process')).spawnSync(process.execPath,
    [path.join(repo, 'tools/register-hooks.mjs'), ...process.argv.slice(2)],
    { stdio: 'inherit', env: { ...process.env, ORGIAST_REPO: repo } });
  process.exit(result.status ?? 1);
}
const geminiKey = process.env.ORGIAST_GEMINI_KEY || readGeminiKey();
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const skippedNames = [];
function readGeminiKey() {
  try { return fs.readFileSync(path.join(home, '.gemini', '.env'), 'utf8').split(/\r?\n/).find((x) => x.startsWith('GEMINI_API_KEY='))?.slice(15) || ''; } catch { return ''; }
}
function load(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return raw.trim() ? JSON.parse(raw) : {};
}
function backup(file) { if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak.${stamp}-installer`); }
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(pending, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(pending, file);
  } finally { try { fs.unlinkSync(pending); } catch {} }
  // 配布設定は書けたつもりで終えず、直後にJSONとして同値か読み戻す。
  const written = load(file);
  if (JSON.stringify(written) !== JSON.stringify(value)) throw new Error(`${file} のread-back検査に失敗`);
}
function removeDailySessionHooks(settings) {
  const groups = settings.hooks?.SessionStart;
  if (!Array.isArray(groups)) return 0;
  let removed = 0;
  for (let i = groups.length - 1; i >= 0; i--) {
    if (!Array.isArray(groups[i]?.hooks)) continue;
    const hooks = groups[i].hooks;
    for (let j = hooks.length - 1; j >= 0; j--) {
      if (/(?:^|[\\/\s"'])(?:ai-news-inject|gtasks-pending-notice)\.mjs(?=[\s"']|$)/i.test(String(hooks[j]?.command || ''))) {
        hooks.splice(j, 1);
        removed++;
      }
    }
    if (!hooks.length) groups.splice(i, 1);
  }
  return removed;
}

function commands(groups) { return groups.flatMap((g) => Array.isArray(g?.hooks) ? g.hooks : []).map((h) => String(h?.command || '')); }
// kim 宛の Discord 報告を全PCで止める（kim 2026-10-27 厳命）。claude-watch-inbox の Stop hook は
// 応答の末尾を毎回 claude-code チャンネルへ kim メンション付きで投稿しており、報告が洪水になった主因。
// 対になる SessionStart の返信取得 hook も、投稿を止めれば用済みなので外す。
const KIM_DISCORD_REPORT_HOOKS = {
  Stop: /(?:^|[\\/\s"'])post-stop-to-(?:inbox|discord)\.ps1(?=[\s"']|$)/i,
  SessionStart: /(?:^|[\\/\s"'])get-reply-(?:on-session-start|from-discord)\.ps1(?=[\s"']|$)/i,
};
export function removeKimDiscordReportHooks(settings) {
  let removed = 0;
  for (const [event, pattern] of Object.entries(KIM_DISCORD_REPORT_HOOKS)) {
    const groups = settings.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    for (let i = groups.length - 1; i >= 0; i--) {
      if (!Array.isArray(groups[i]?.hooks)) continue;
      const hooks = groups[i].hooks;
      for (let j = hooks.length - 1; j >= 0; j--) {
        if (pattern.test(String(hooks[j]?.command || ''))) { hooks.splice(j, 1); removed++; }
      }
      if (!hooks.length) groups.splice(i, 1);
    }
  }
  return removed;
}
function add(groups, scriptName, group) {
  // リポの同期が遅れている環境で、存在しないスクリプトを登録して毎回 ENOENT を出すのを防ぐ。
  if (scriptName.endsWith('.mjs') && !fs.existsSync(path.join(repo, 'tools', scriptName))) {
    skippedNames.push(scriptName);
    if (!expectedJson) console.log(`  [skip] ${scriptName} — repo/tools に実ファイルが無いため未登録`);
    return false;
  }
  if (!gateRuntimeReady && scriptName.endsWith('.mjs')) {
    // Do not introduce a new hard denial during a partially downloaded update.
    const source = fs.readFileSync(path.join(repo, 'tools', scriptName), 'utf8');
    if (/GATE_CONTRACT/.test(source)) {
      let legacy = false;
      try { legacy = JSON.parse(fs.readFileSync(path.join(repo, 'tools/gate-rollout-manifest.json'), 'utf8')).gates?.[scriptName.slice(0, -4)]?.legacy === true; } catch {}
      if (!legacy) { skippedNames.push(scriptName); if (!expectedJson) console.log(`  [skip] ${scriptName} — gate runtime 同期待ち`); return false; }
    }
  }
  // 既存PCは .ps1 版が登録済みのことがある(Windows install)。拡張子を無視して重複判定しないと
  // .mjs と .ps1 の二重登録になり、同じ context が2回注入される。
  const base = scriptName.replace(/\.(mjs|ps1)$/, '');
  // A worktree/directory may itself be named after the gate. Compare script
  // filenames, not arbitrary path substrings, or every prior hook looks equal.
  const fileBase = path.posix.basename(base.replace(/\\/g, '/'));
  const escaped = fileBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const scriptPattern = new RegExp(`(?:^|[\\\\/\\s"'])${escaped}\\.(?:mjs|ps1)(?=["'\\s]|$)`);
  if (commands(groups).some((cmd) => scriptPattern.test(cmd))) return false;
  groups.push(group); return true;
}
function setTimeoutFor(groups, scriptName, timeout) {
  let changed = 0;
  for (const group of groups) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
    const expected = String(hook.command || '').includes('gate-hook-runner.mjs') ? Math.max(timeout, 10) + 5 : timeout;
    if (String(hook.command || '').includes(scriptName) && hook.timeout !== expected) { hook.timeout = expected; changed += 1; }
  }
  return changed;
}
export function repairPowerShellExecutionPolicy(hooks) {
  let changed = 0;
  for (const groups of Object.values(hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const hook of (Array.isArray(group?.hooks) ? group.hooks : [])) {
      const current = String(hook?.command || '');
      if (!/^\s*(?:pwsh|powershell)(?:\.exe)?\b/i.test(current) || !/-File\b[^\r\n]*\.ps1(?:["']|\s|$)/i.test(current) || /-ExecutionPolicy\s+Bypass\b/i.test(current)) continue;
      const repaired = /-NoProfile\b/i.test(current)
        ? current.replace(/-NoProfile\b/i, '$& -ExecutionPolicy Bypass')
        : current.replace(/^(\s*(?:pwsh|powershell)(?:\.exe)?\b)/i, '$1 -ExecutionPolicy Bypass');
      if (repaired !== current) { hook.command = repaired; changed += 1; }
    }
  }
  return changed;
}

try {
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const settingsHadBom = fs.existsSync(settingsFile) && fs.readFileSync(settingsFile, 'utf8').startsWith('\uFEFF');
  const settings = expectedJson ? {} : load(settingsFile);
  const before = JSON.stringify(settings);
  let previousManifest;
  try { previousManifest = load(runtimeManifestPath(home)); } catch {}
  const originalHooks = effectiveHooks(settings, previousManifest);
  settings.hooks = structuredClone(originalHooks);
  let added = 0;
  let policyRepaired = 0;
  let costLoopMigrated = 0;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'Notification']) if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  added += removeDailySessionHooks(settings);
  added += removeKimDiscordReportHooks(settings);
  // Repository manifest is the canonical set, including matcher, args and budgets.
  // The old individual definitions are retained only in per-home migration input.
  for (const [event, groups] of Object.entries(repositoryHooks(repo, home))) {
    for (const group of groups) {
      const hook = group.hooks[0];
      const names = [...hook.command.matchAll(/"([^"\r\n]+\.mjs)"/g)];
      const script = names.at(-1)?.[1];
      if (!script) continue;
      const name = path.relative(path.join(repo, 'tools'), script);
      if (add(settings.hooks[event], name, group)) added++;
    }
  }
  costLoopMigrated = Object.values(originalHooks).flatMap(groups => groups.flatMap(g => g.hooks || [])).filter(h => /cost-loop\.ps1/.test(h.command || '')).length;
  const permanentTimeouts = [
    ['pretooluse-delegation-warn.mjs', 5], ['model-agent-guard.mjs', 5],
    ['pretooluse-serial-investigation.mjs', 5], ['current-session.mjs', 5],
    ['cost-loop.mjs', 5], ['rule-compliance-report.mjs', 10],
    ['next-actions-notice.mjs', 10], ['plaud-renewal-notice.mjs', 5],
    ['clear-ack.mjs', 5], ['verify-before-done-detector.ps1', 10],
  ];
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const [name, timeout] of permanentTimeouts) added += setTimeoutFor(groups, name, timeout);
  }
  // 全PC・全アカウントの全セッションで Remote Control を自動開始する(kim 2026-10-09)。CLI と VS Code 拡張の両方がこのキーを読む。
  if (settings.remoteControlAtStartup !== true) { settings.remoteControlAtStartup = true; added += 1; }
  // 全PC・全アカウントの応答・セッション名を日本語に固定する。途中で英語に切り替わった事故の再発防止(cr 2026-10-18)。
  if (settings.language !== 'japanese') { settings.language = 'japanese'; added += 1; }
  // 旧PCは hook が `powershell -NoProfile -File ...ps1` で登録され、実行ポリシーで無音死している。
  policyRepaired = repairPowerShellExecutionPolicy(settings.hooks);
  added += policyRepaired;
  added += wrapRegisteredGates(settings, repo);
  if (!expectedJson) {
    const expected = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--expected-json'], {
      encoding: 'utf8', env: { ...process.env, ORGIAST_REPO: repo }, windowsHide: true,
    }));
    const known = new Set(fs.readdirSync(path.join(repo, 'tools')).map(name => name.replace(/\.(mjs|ps1)$/, '')));
    known.add('discord-drafts-context'); // nested tools/hooks entry is also managed
    const managed = command => {
      const text = String(command || '').replace(/\\/g, '/');
      return [...text.matchAll(/(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))/g)].some(match => {
        const file = match[1] || match[2] || match[3];
        const name = path.posix.basename(file).replace(/\.(mjs|ps1)$/, '');
        return /\/tools\//.test(file) && (known.has(name) || /\/(?:orgiast-main|orgiast-claude-rules|nightly-repo)\/tools\//.test(file));
      });
    };
    // Keep custom hooks from the original input: do not migrate, wrap or rewrite
    // a user's script merely because its basename matches one of our tools.
    const retained = {};
    for (const [event, groups] of Object.entries(originalHooks)) {
      if (!Array.isArray(groups)) continue;
      retained[event] = groups.flatMap(group => {
        const hooks = (group.hooks || []).filter(hook => !managed(hook.command));
        return hooks.length ? [{ ...group, hooks }] : [];
      });
    }
    // Preserve supported legacy migrations outside tools/ (old installer copies).
    for (const [event, groups] of Object.entries(retained)) {
      for (const group of groups) group.hooks = group.hooks.filter(hook =>
        !/(?:ai-news-inject|gtasks-pending-notice|purge-hidden-sessions|purge-closed-sessions|session-list-tidy)\.(?:mjs|ps1|py)(?:["'\s]|$)/.test(hook.command || '') && !/(?:cost-loop|onboarding-sync|verify-before-done-detector|check-e2e-before-stop)\.ps1(?:["'\s]|$)/.test(hook.command || ''));
      retained[event] = groups.filter(group => group.hooks.length);
    }
    policyRepaired = repairPowerShellExecutionPolicy(retained);
    // Retain historical timeout repair for copied hooks, without changing paths.
    for (const groups of Object.values(retained)) for (const [name, timeout] of permanentTimeouts) setTimeoutFor(groups, name, timeout);
    settings.hooks = retained;
    for (const [event, groups] of Object.entries(expected.hooks)) settings.hooks[event] = [...(retained[event] || []), ...groups];
    added = JSON.stringify(settings) === before ? 0 : 1;
  }
  added += removeKimDiscordReportHooks(settings);
  // Reporting uses exactly the registrar's expected set without touching user files.
  if (expectedJson) { console.log(JSON.stringify({ hooks: settings.hooks, skippedNames })); process.exit(0); }
  // 初回配布で空の共有台帳を用意する。不在時 fail-open のまま恒常的に素通りさせない。
  if (settings.hooks.PreToolUse.some(group => (group.hooks || []).some(hook => String(hook.command).includes('share-before-send-gate.mjs')))) {
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.closeSync(fs.openSync(path.join(home, '.claude', 'share-ledger.jsonl'), 'a'));
  }
  const collapsed = collapseHooks(settings.hooks, repo);
  const manifestFile = runtimeManifestPath(home);
  const manifestChanged = JSON.stringify(load(manifestFile)) !== JSON.stringify(collapsed.manifest);
  if (manifestChanged) write(manifestFile, collapsed.manifest);
  settings.hooks = collapsed.hooks;
  added = JSON.stringify(settings) === before ? 0 : 1;
  // 差分が無い時は書かない(日次実行で .bak が積み上がるのを防ぐ)
  if (added || settingsHadBom) { backup(settingsFile); write(settingsFile, settings); }
  if (settingsHadBom) console.log('[register-hooks] settings.json の BOM を除去しました');
  if (policyRepaired || costLoopMigrated) console.log(`hook修復: 実行ポリシー${policyRepaired}件 / cost-loop移行${costLoopMigrated}件`);
  if (hooksOnly) {
    if (added) console.log(`  [OK] settings.json の hook を期待集合へ収束(バックアップ済)`);
    else if (skippedNames.length) console.log(`  [注意] 登録済み(変更なし)。ただし ${skippedNames.length} 本は repo に無く未登録`);
    else console.log('  [OK] hook は既に登録済み(変更なし)');
    if (skippedNames.length) console.log(`[注意] hook ${skippedNames.length} 本が repo に見つからず skip: ${skippedNames.join(', ')}`);
    process.exit(0);
  }

  const claudeFile = path.join(home, '.claude.json');
  backup(claudeFile);
  const claude = load(claudeFile);
  if (!claude.mcpServers || typeof claude.mcpServers !== 'object' || Array.isArray(claude.mcpServers)) claude.mcpServers = {};
  claude.mcpServers['gemini-cli'] = { type: 'stdio', command: 'npx', args: ['-y', 'gemini-mcp-tool'], env: { GEMINI_API_KEY: geminiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_MCP_BACKEND: 'gemini' } };
  write(claudeFile, claude);
  console.log(`  [OK] settings.json${added ? '(hook ' + added + '件追加)' : '(変更なし)'} / .claude.json 更新`);
  if (skippedNames.length) console.log(`[注意] hook ${skippedNames.length} 本が repo に見つからず skip: ${skippedNames.join(', ')}`);
} catch (e) {
  console.error(`  [注意] 設定登録に失敗: ${e.message}`);
  process.exitCode = 1;
}
