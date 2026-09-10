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
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  // 配布設定は書けたつもりで終えず、直後にJSONとして同値か読み戻す。
  const written = load(file);
  if (JSON.stringify(written) !== JSON.stringify(value)) throw new Error(`${file} のread-back検査に失敗`);
}
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
  const settings = load(settingsFile);
  let added = 0;
  let policyRepaired = 0;
  let costLoopMigrated = 0;
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) settings.hooks = {};
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']) if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];
  const command = (name, extra = '') => `node "${path.join(repo, 'tools', name)}"${extra}`;
  // 2026-09-06: 9本を別プロセスで動かすと304 Stop中198回が再Stopになったため、
  // ファイル名で旧登録を拾い、PCごとに異なるrepoパスのrunner 1本へ収束させる。
  const oldStopGates = [
    'handoff-quality-gate.mjs', 'stop-gate.mjs', 'manual-request-fullsteps-gate.mjs',
    'handoff-investigation-gate.mjs', 'handoff-info-guard.mjs', 'negative-claim-gate.mjs',
    'report-length-gate.mjs', 'self-check-before-asking-guard.mjs', 'doc-link-drive-guard.mjs',
  ];
  if (fs.existsSync(path.join(repo, 'tools', 'stop-gate-runner.mjs'))) {
    for (const oldName of oldStopGates) added += migrate(settings.hooks.Stop, oldName, 'stop-gate-runner.mjs', command('stop-gate-runner.mjs'));
    if (add(settings.hooks.Stop, 'stop-gate-runner.mjs', { hooks: [{ type: 'command', command: command('stop-gate-runner.mjs'), timeout: 10 }] })) added += 1;
    added += setTimeoutFor(settings.hooks.Stop, 'stop-gate-runner.mjs', 10);
  }
  const session = [
    ['onboarding-sync.mjs', 20, true, ''],
    // あるべき状態への収束(検査→修復→再検査)。onboarding-sync が repo を新しくした後に走る。
    // リポジトリ直接参照・コピー配布なし = main を変えれば全PC追従(配り直し不要)。
    ['setup.mjs', 60, true, ' --converge'],
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
  if (fs.existsSync(path.join(repo, 'tools', 'cost-loop.mjs'))) {
    costLoopMigrated = migrate(settings.hooks.SessionStart, 'cost-loop.ps1', 'cost-loop.mjs', command('cost-loop.mjs'));
    added += costLoopMigrated;
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
  // inline target の予約を次セッションへ同期注入するため async は付けない。
  if (add(settings.hooks.SessionStart, 'session-relaunch.mjs', { hooks: [{ type: 'command', command: command('session-relaunch.mjs', ' --hook'), timeout: 10 }] })) added += 1;
  // Googleタスク上の kim 待ちを毎セッション同期注入するため async は付けない。
  if (add(settings.hooks.SessionStart, 'gtasks-pending-notice.mjs', { hooks: [{ type: 'command', command: command('gtasks-pending-notice.mjs'), timeout: 15 }] })) added += 1;
  added += migrate(settings.hooks.UserPromptSubmit, 'current-session.mjs', 'current-session.mjs', command('current-session.mjs'));
  if (add(settings.hooks.UserPromptSubmit, 'current-session.mjs', { hooks: [{ type: 'command', command: command('current-session.mjs'), timeout: 5 }] })) added += 1;
  added += migrate(settings.hooks.UserPromptSubmit, 'delegation-gate', 'cost-routing-gate.mjs', command('cost-routing-gate.mjs'));
  if (add(settings.hooks.UserPromptSubmit, 'cost-routing-gate.mjs', { hooks: [{ type: 'command', command: command('cost-routing-gate.mjs') }] })) added += 1;
  // additionalContext を返すため同期実行。高額モデル・肥大セッションを純ローカルで検知する。
  if (add(settings.hooks.UserPromptSubmit, 'expensive-session-guard.mjs', { hooks: [{ type: 'command', command: command('expensive-session-guard.mjs'), timeout: 5 }] })) added += 1;
  // 完成済み指示書の候補を同期注入するため async は付けない。
  if (add(settings.hooks.UserPromptSubmit, 'makimono-gate.mjs', { hooks: [{ type: 'command', command: command('makimono-gate.mjs'), timeout: 6 }] })) added += 1;
  // userへ頼む前に自動取得・復元・自動設定を毎プロンプトで先に検討させる。
  if (add(settings.hooks.UserPromptSubmit, 'automation-first-reminder.mjs', { hooks: [{ type: 'command', command: command('automation-first-reminder.mjs'), timeout: 5 }] })) added += 1;
  // 過去に受領済みのクレデンシャルをuserへ再質問する前に復元経路を注入する。
  if (add(settings.hooks.UserPromptSubmit, 'credentials-reminder.mjs', { hooks: [{ type: 'command', command: command('credentials-reminder.mjs'), timeout: 5 }] })) added += 1;
  added += migrate(settings.hooks.PreToolUse, 'pretooluse-delegation-warn.ps1', 'pretooluse-delegation-warn.mjs', command('pretooluse-delegation-warn.mjs'));
  if (add(settings.hooks.PreToolUse, 'pretooluse-delegation-warn.mjs', { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: command('pretooluse-delegation-warn.mjs') }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'pretooluse-bash-delegation.mjs', { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: command('pretooluse-bash-delegation.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'pretooluse-lane-guard.mjs', { matcher: 'Bash|PowerShell|Edit|Write|MultiEdit', hooks: [{ type: 'command', command: command('pretooluse-lane-guard.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'pretooluse-codex-invocation.mjs', { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: command('pretooluse-codex-invocation.mjs'), timeout: 5 }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'model-agent-guard.mjs', { matcher: 'Agent|Task', hooks: [{ type: 'command', command: command('model-agent-guard.mjs') }] })) added += 1;
  if (add(settings.hooks.PreToolUse, 'internal-recipient-gmail-guard.mjs', { matcher: 'mcp__claude_ai_Gmail__create_draft|mcp__claude_ai_Gmail__send_message|mcp__claude_ai_Gmail__update_draft|mcp__claude_ai_Gmail__reply|mcp__claude_ai_Gmail__forward|mcp__claude_ai_Gmail_2__create_draft|mcp__claude_ai_Gmail_2__send_message', hooks: [{ type: 'command', command: command('internal-recipient-gmail-guard.mjs'), timeout: 5 }] })) added += 1;
  // ヘッドレス実行で消失するバックグラウンド処理を実行前に拒否する。
  if (add(settings.hooks.PreToolUse, 'pretooluse-headless-background.mjs', { matcher: 'Bash|PowerShell|ScheduleWakeup', hooks: [{ type: 'command', command: command('pretooluse-headless-background.mjs'), timeout: 5 }] })) added += 1;
  // read-only調査の逐次実行を検知し、まとめて調査するよう同期注入する。
  if (add(settings.hooks.PreToolUse, 'pretooluse-serial-investigation.mjs', { hooks: [{ type: 'command', command: command('pretooluse-serial-investigation.mjs'), timeout: 5 }] })) added += 1;
  // パイプ等で連結された全ステージが許可済みBashプレフィックスなら自動承認する。
  if (add(settings.hooks.PreToolUse, 'pipe-stage-permissions.mjs', { matcher: 'Bash', hooks: [{ type: 'command', command: command('pipe-stage-permissions.mjs'), timeout: 5 }] })) added += 1;
  // 人に手作業を頼むとき、初見の人でも実行できる手順になっているかを検査する(§1.5.1)。
  if (add(settings.hooks.Stop, 'verify-before-done-detector.mjs', { hooks: [{ type: 'command', command: command('verify-before-done-detector.mjs') }] })) added += 1;
  // kim が読む文書をローカルパスのリンクで渡す違反を止める(モバイルで1クリックで開けない・2026-08-07 kim確定ルール)
  // 作業依頼だけを残して必要なURL・コマンドを省くと、kimが過去ログを探すため同期Stopで差し戻す。
  // 自分で調べられることを user に「確認して教えてください」と外注する応答を止める(§1.1/§1.2)。
  // 同じ判定を AskUserQuestion では *事前* に効かせる。Stop は応答を出したあとなので、
  // user の目に触れる前に止められるのはここだけ(2026-09-01 user 厳命への対応)。
  if (add(settings.hooks.PreToolUse, 'askuser-selfcheck-gate.mjs', { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: command('askuser-selfcheck-gate.mjs'), timeout: 10 }] })) added += 1;
  // 上記4本(handoff-info/quality/investigation/negative-claim)は stop-gate-runner に合流済みなので個別登録しない。
  // コマンドの手渡しに非エンジニア向けの開き方・入力場所・完了確認を必須化する。
  if (add(settings.hooks.Stop, 'handoff-detail-guard.mjs', { hooks: [{ type: 'command', command: command('handoff-detail-guard.mjs'), timeout: 10 }] })) added += 1;
  // 生URLと日本語・全角文字の直接隣接によるリンク破損を差し戻す。
  if (add(settings.hooks.Stop, 'url-format-guard.mjs', { hooks: [{ type: 'command', command: command('url-format-guard.mjs'), timeout: 8 }] })) added += 1;
  // 完了報告にLayer 1/2・e2e等の検証記載がなければ同期警告する。
  if (add(settings.hooks.Stop, 'check-e2e-before-stop.mjs', { hooks: [{ type: 'command', command: command('check-e2e-before-stop.mjs'), timeout: 8 }] })) added += 1;
  // 旧PCは hook が `powershell -NoProfile -File ...ps1` で登録され、実行ポリシーで無音死している。
  policyRepaired = repairPowerShellExecutionPolicy(settings.hooks);
  added += policyRepaired;
  // 差分が無い時は書かない(日次実行で .bak が積み上がるのを防ぐ)
  if (added || settingsHadBom) { backup(settingsFile); write(settingsFile, settings); }
  if (settingsHadBom) console.log('[register-hooks] settings.json の BOM を除去しました');
  if (policyRepaired || costLoopMigrated) console.log(`hook修復: 実行ポリシー${policyRepaired}件 / cost-loop移行${costLoopMigrated}件`);
  if (hooksOnly) { console.log(added ? `  [OK] settings.json に hook を ${added} 件追加(バックアップ済)` : '  [OK] hook は既に登録済み(変更なし)'); process.exit(0); }

  const claudeFile = path.join(home, '.claude.json');
  backup(claudeFile);
  const claude = load(claudeFile);
  if (!claude.mcpServers || typeof claude.mcpServers !== 'object' || Array.isArray(claude.mcpServers)) claude.mcpServers = {};
  claude.mcpServers['gemini-cli'] = { type: 'stdio', command: 'npx', args: ['-y', 'gemini-mcp-tool'], env: { GEMINI_API_KEY: geminiKey, GEMINI_CLI_TRUST_WORKSPACE: 'true', GEMINI_MCP_BACKEND: 'gemini' } };
  write(claudeFile, claude);
  console.log(`  [OK] settings.json${added ? '(hook ' + added + '件追加)' : '(変更なし)'} / .claude.json 更新`);
} catch (e) {
  console.error(`  [注意] 設定登録に失敗: ${e.message}`);
  process.exitCode = 1;
}
