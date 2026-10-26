import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

test('setup converge timeout covers Node updates on new and existing PCs, idempotently', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-node-runtime-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const run = () => execFileSync(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'], {
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo },
  });
  run();
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks).filter((hook) => hook.command.includes('setup.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].timeout, 1200);
  hooks[0].timeout = 60;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  run();
  const repaired = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(repaired.hooks.SessionStart.flatMap((group) => group.hooks).find((hook) => hook.command.includes('setup.mjs')).timeout, 1200);
  run();
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, 'utf8')), repaired);
});

test('既存PowerShell hookへExecutionPolicy Bypassを補いcost-loopをmjsへ移行する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ command: 'powershell -NoProfile -NonInteractive -File "C:\\x\\cost-loop.ps1"' }] }],
    UserPromptSubmit: [{ hooks: [{ command: 'pwsh -NoProfile -File "C:\\x\\custom.ps1"' }] }],
    Stop: [{ hooks: [{ command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\x\\done.ps1"' }] }],
  } }));
  const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks || [])).map((hook) => hook.command);
  assert.ok(commands.some((command) => command.includes('cost-loop.mjs')));
  assert.ok(!commands.some((command) => command.includes('cost-loop.ps1')));
  assert.ok(commands.find((command) => command.includes('custom.ps1')).includes('-NoProfile -ExecutionPolicy Bypass'));
  assert.equal((commands.find((command) => command.includes('done.ps1')).match(/-ExecutionPolicy Bypass/gi) || []).length, 1);
  assert.match(stdout, /hook修復: 実行ポリシー1件 \/ cost-loop移行1件/);
  const shareGroups = settings.hooks.PreToolUse.filter(group => group.hooks.some(hook => hook.command.includes('share-before-send-gate.mjs')));
  assert.equal(shareGroups.length, 1);
  const domainGroups = settings.hooks.PreToolUse.filter(group => group.hooks.some(hook => hook.command.includes('recipient-domain-gate.mjs')));
  assert.equal(domainGroups.length, 1);
  const mailGroups = settings.hooks.PreToolUse.filter(group => group.hooks.some(hook => hook.command.includes('mail-draft-account-gate.mjs')));
  assert.equal(mailGroups.length, 1);
  const consistencyGroups = settings.hooks.PreToolUse.filter(group => group.hooks.some(hook => hook.command.includes('mail-consistency-gate.mjs')));
  assert.equal(consistencyGroups.length, 1);
  assert.equal(consistencyGroups[0].matcher, 'Bash|PowerShell');
  for (const action of ['create_draft', 'update_draft', 'send_message', 'reply', 'forward']) {
    for (const connector of ['Gmail', 'Gmail_2']) assert.match(`mcp__claude_ai_${connector}__${action}`, new RegExp(mailGroups[0].matcher));
  }
  for (const name of ['Bash', 'PowerShell', 'mcp__claude_ai_Gmail_2__send_message']) assert.match(name, new RegExp(domainGroups[0].matcher));
  assert.equal(domainGroups[0].hooks.find(hook => hook.command.includes('recipient-domain-gate.mjs')).timeout, 30);
  assert.match('mcp__claude_ai_Discord__send_dm', new RegExp(shareGroups[0].matcher));
  assert.match('mcp__claude_ai_Gmail__create_draft', new RegExp(shareGroups[0].matcher));
  assert.equal(fs.readFileSync(path.join(home, '.claude/share-ledger.jsonl'), 'utf8'), '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('session-relaunch hook は同期で1本だけ登録され、再実行で重複しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-relaunch-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const second = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command).includes('session-relaunch'));
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].command, /session-relaunch\.mjs" --hook$/);
  assert.equal(hooks[0].timeout, 10);
  assert.equal('async' in hooks[0], false);
  const planHooks = settings.hooks.UserPromptSubmit.flatMap(group => group.hooks || []).filter(hook => hook.command.includes('plan-usage-report.mjs'));
  assert.equal(planHooks.length, 1);
  assert.match(planHooks[0].command, /plan-usage-report\.mjs" --hook$/);
  assert.match(second, /hook は既に登録済み\(変更なし\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('stop-gate-runner hook は timeout 30 で Stop に登録される', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-report-length-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo },
  });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.Stop.flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command).includes('stop-gate-runner.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].timeout, 30);
  assert.equal('async' in hooks[0], false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('旧Stop gate 9本をrunner 1本へ移行し無関係なStop hookを残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-runner-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const old = ['handoff-quality-gate.mjs','stop-gate.mjs','manual-request-fullsteps-gate.mjs','handoff-investigation-gate.mjs','handoff-info-guard.mjs','negative-claim-gate.mjs','report-length-gate.mjs','self-check-before-asking-guard.mjs','doc-link-drive-guard.mjs'];
  const hooks = old.map((name) => ({ hooks: [{ type: 'command', command: `node "C:\\old\\tools\\${name}"` }] }));
  hooks.push({ hooks: [{ type: 'command', command: 'powershell -NoProfile -File "C:\\keep.ps1"' }, { type: 'command', command: 'node "C:\\keep-tool.mjs"' }] });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: hooks } }));
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const commands = settings.hooks.Stop.flatMap((group) => group.hooks || []).map((hook) => hook.command);
  assert.equal(commands.filter((value) => value.includes('stop-gate-runner.mjs')).length, 1);
  assert.ok(old.every((name) => !commands.some((value) => value.includes(name))));
  assert.ok(commands.some((value) => value.includes('keep.ps1')));
  assert.ok(commands.some((value) => value.includes('keep-tool.mjs')));
  assert.ok(fs.readdirSync(path.dirname(settingsFile)).some((name) => /^settings\.json\.bak\..+-installer$/.test(name)));
});

test('日次通知hookは新規登録せず既存の混在groupからも削除する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-gtasks-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [
    { hooks: [{ command: 'node "C:\\old\\ai-news-inject.mjs"' }, { command: 'node keep.mjs' }] },
    { hooks: [{ command: 'node /old/gtasks-pending-notice.mjs' }] },
  ] } }));
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const second = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks || [])
    .filter((hook) => /ai-news-inject|gtasks-pending-notice/.test(String(hook.command)));
  assert.equal(hooks.length, 0);
  assert.ok(settings.hooks.SessionStart.some(g => g.hooks.some(h => h.command === 'node keep.mjs')));
  assert.match(second, /hook は既に登録済み\(変更なし\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('手間削減hook 8本を正しいイベントへ登録しstop-gateは登録しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-parity-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const names = (event) => settings.hooks[event].flatMap((group) => group.hooks || []).map((hook) => path.basename([...String(hook.command).matchAll(/"([^"]+\.mjs)"/g)].at(-1)?.[1] || ''));
  assert.deepEqual(['automation-first-reminder.mjs', 'credentials-reminder.mjs', 'playbook-inject.mjs'].every((name) => names('UserPromptSubmit').includes(name)), true);
  assert.deepEqual(['pretooluse-headless-background.mjs', 'pretooluse-line-broadcast-guard.mjs', 'pretooluse-serial-investigation.mjs', 'pipe-stage-permissions.mjs'].every((name) => names('PreToolUse').includes(name)), true);
  assert.deepEqual(['auto-progress-ledger.mjs', 'stop-gate-runner.mjs', 'handoff-detail-guard.mjs', 'url-format-guard.mjs', 'check-e2e-before-stop.mjs'].every((name) => names('Stop').includes(name)), true);
  assert.equal(Object.values(settings.hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).some((hook) => /(?:^|[\\/])stop-gate\.mjs/.test(String(hook.command))), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('手間削減hook 8本は2回実行しても各1本のまま', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-parity-idempotent-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const commands = Object.values(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).map((hook) => String(hook.command));
  for (const name of ['auto-progress-ledger', 'automation-first-reminder', 'credentials-reminder', 'pretooluse-headless-background', 'pretooluse-line-broadcast-guard', 'pretooluse-serial-investigation', 'stop-gate-runner', 'handoff-detail-guard', 'pipe-stage-permissions', 'url-format-guard', 'check-e2e-before-stop']) {
    assert.equal(commands.filter((command) => command.includes(name)).length, 1, `${name} must be unique`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('lane guard は指定matcher・timeoutで登録される', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'register-lane-')), repo=path.resolve('.');
  execFileSync(process.execPath,[path.join(repo,'tools','register-hooks.mjs'),'--hooks-only'],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repo}});
  const group=JSON.parse(fs.readFileSync(path.join(home,'.claude','settings.json'),'utf8')).hooks.PreToolUse.find((x)=>x.hooks?.some((h)=>h.command.includes('pretooluse-lane-guard')));
  assert.equal(group.matcher,'Bash|PowerShell|Edit|Write|MultiEdit'); assert.equal(group.hooks[0].timeout,15);
});

test('gemini MCP 使用量hookはPostToolUseにmatcher付きで1本だけ登録される', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'register-gemini-mcp-')), repo=path.resolve('.');
  const env={...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repo};
  execFileSync(process.execPath,[path.join(repo,'tools','register-hooks.mjs'),'--hooks-only'],{env});
  execFileSync(process.execPath,[path.join(repo,'tools','register-hooks.mjs'),'--hooks-only'],{env});
  const settings=JSON.parse(fs.readFileSync(path.join(home,'.claude','settings.json'),'utf8'));
  const hooks=settings.hooks.PostToolUse.flatMap((group)=>group.hooks||[]).filter((hook)=>String(hook.command).includes('gemini-mcp-usage-hook.mjs'));
  assert.equal(hooks.length,1);
  assert.equal(settings.hooks.PostToolUse.find((group)=>(group.hooks||[]).some((hook)=>String(hook.command).includes('gemini-mcp-usage-hook.mjs'))).matcher,'mcp__gemini-cli__(?:ask-gemini|geminiChat|googleSearch)');
  assert.equal(hooks[0].timeout,10);
  fs.rmSync(home,{recursive:true,force:true});
});

test('staleツリーパス・雑matcherのgemini MCP 使用量hookをrepo実ファイルへ収束させる', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'register-gemini-mcp-stale-')), repo=path.resolve('.');
  const file=path.join(home,'.claude','settings.json'); fs.mkdirSync(path.dirname(file),{recursive:true});
  // 実ファイルが存在しないパスへの手動登録 + 全ツールにマッチする雑なmatcher(2026-09-18 実機で発見した状態)
  fs.writeFileSync(file,JSON.stringify({hooks:{PostToolUse:[{matcher:'mcp__gemini-cli__.*',hooks:[{type:'command',command:`node "C:\\Users\\x\\orgiast-claude-rules\\tools\\gemini-mcp-usage-hook.mjs"`,timeout:10}]}]}}));
  execFileSync(process.execPath,[path.join(repo,'tools','register-hooks.mjs'),'--hooks-only'],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repo}});
  const groups=JSON.parse(fs.readFileSync(file,'utf8')).hooks.PostToolUse;
  assert.equal(groups.flatMap((group)=>group.hooks||[]).filter((hook)=>String(hook.command).includes('gemini-mcp-usage-hook')).length,1);
  assert.equal(groups.find((group)=>(group.hooks||[]).some((hook)=>String(hook.command).includes('gemini-mcp-usage-hook'))).matcher,'mcp__gemini-cli__(?:ask-gemini|geminiChat|googleSearch)');
  assert.ok(groups.find((group)=>(group.hooks||[]).some((hook)=>String(hook.command).includes('gemini-mcp-usage-hook'))).hooks[0].command.includes(path.join(repo,'tools','gemini-mcp-usage-hook.mjs')));
  fs.rmSync(home,{recursive:true,force:true});
});

test('既存hookの恒久timeoutをイベント・パス表記を問わず収束する', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'register-timeouts-')), repo=path.resolve('.');
  const file=path.join(home,'.claude','settings.json'); fs.mkdirSync(path.dirname(file),{recursive:true});
  const wanted=[['pretooluse-delegation-warn.mjs',5],['model-agent-guard.mjs',5],['pretooluse-serial-investigation.mjs',5],['current-session.mjs',5],['cost-loop.mjs',5],['rule-compliance-report.mjs',10],['next-actions-notice.mjs',10],['plaud-renewal-notice.mjs',5],['clear-ack.mjs',5],['verify-before-done-detector.ps1',10]];
  fs.writeFileSync(file,JSON.stringify({hooks:{Stop:wanted.map(([name])=>({hooks:[{type:'command',command:`pwsh -File "C:\\\\Users\\\\uers\\\\.claude\\\\hooks\\\\${name}"`}]}))}}));
  execFileSync(process.execPath,[path.join(repo,'tools','register-hooks.mjs'),'--hooks-only'],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repo}});
  const hooks=JSON.parse(fs.readFileSync(file,'utf8')).hooks.Stop.flatMap((g)=>g.hooks||[]);
  for(const [name,timeout] of wanted) { const migrated=name==='verify-before-done-detector.ps1'; assert.equal(hooks.find((h)=>h.command.includes(migrated?'verify-before-done-detector.mjs':name)).timeout,migrated?15:timeout,name); }
  fs.rmSync(home,{recursive:true,force:true});
});

test('guard本体が未同期でもregister-hooksは落ちず、既存hookを保ったまま完走する', () => {
  // matcher の正本は guard 側にあるが、同期途中のPCでは guard がまだ無いことがある。
  // 静的に import すると ERR_MODULE_NOT_FOUND で register-hooks 全体が落ち、
  // hook が1本も登録されない(全hookの停止)。fail-open をここで固定する。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-failopen-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-repo-'));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(path.resolve('tools', 'register-hooks.mjs'), path.join(repo, 'tools', 'register-hooks.mjs'));
  assert.ok(!fs.existsSync(path.join(repo, 'tools', 'internal-recipient-gmail-guard.mjs')));
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const existing = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node existing.mjs' }] };
  fs.writeFileSync(settingsFile, JSON.stringify({ custom: true, hooks: { PreToolUse: [existing] } }));
  const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
  assert.equal(typeof stdout, 'string');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(settings.custom, true);
  assert.deepEqual(settings.hooks.PreToolUse[0], existing);
  assert.ok(!settings.hooks.PreToolUse.some((group) => (group.hooks || []).some((hook) => String(hook.command).includes('internal-recipient-gmail-guard'))));
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('ORGIAST_REPO明示時は指定された同期途中のツリーからhookを登録する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-own-tree-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-own-tree-repo-'));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  for (const name of ['register-hooks.mjs', 'session-relaunch.mjs']) {
    fs.copyFileSync(path.resolve('tools', name), path.join(repo, 'tools', name));
  }
  const env = { ...process.env, ORGIAST_HOME: home };
  env.ORGIAST_REPO = repo;
  const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const relaunch = settings.hooks.SessionStart.flatMap((group) => group.hooks || [])
    .find((hook) => String(hook.command).includes('session-relaunch.mjs'));
  assert.ok(relaunch);
  assert.ok(relaunch.command.includes(repo));
  assert.match(stdout, /\[skip\] hook-budget-check\.mjs/);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test('hook実ファイルのskipがある時は注意を出し変更なしと正常表示しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-skip-home-'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-skip-repo-'));
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(path.resolve('tools', 'register-hooks.mjs'), path.join(repo, 'tools', 'register-hooks.mjs'));
  const env = { ...process.env, ORGIAST_HOME: home };
  env.ORGIAST_REPO = repo;
  const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  assert.match(stdout, /\[注意\]/);
  assert.doesNotMatch(stdout, /hook は既に登録済み\(変更なし\)/);
  assert.ok((stdout.match(/\[skip\]/g) || []).length >= 5);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});
test('SessionStart lane health は定義元から1本に収束する',()=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'register-lane-health-')), repo=path.resolve('.');
  try {
    fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
    fs.writeFileSync(path.join(home,'.claude/settings.json'),JSON.stringify({hooks:{SessionStart:[{hooks:[{type:'command',command:'node "C:/old/tools/sessionstart-lane-health.mjs"',timeout:3,async:true}]}]}}));
    for(let i=0;i<2;i++) {const r=spawnSync(process.execPath,['tools/register-hooks.mjs','--hooks-only'],{encoding:'utf8',env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repo}});assert.equal(r.status,0,r.stderr);}
    const s=JSON.parse(fs.readFileSync(path.join(home,'.claude/settings.json'),'utf8'));
    const hooks=s.hooks.SessionStart.flatMap(g=>g.hooks).filter(h=>h.command.includes('sessionstart-lane-health.mjs'));
    assert.equal(hooks.length,1);
    assert.deepEqual(hooks[0], { type: 'command', command: `node "${path.join(repo, 'tools', 'sessionstart-lane-health.mjs')}" --hook`, timeout: 5 });
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});

test('mixed roots, wrappers and obsolete tools converge once; custom hooks survive byte-for-byte', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-converge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve('.'), file = path.join(home, '.claude/settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  const run = (...args) => execFileSync(process.execPath, ['tools/register-hooks.mjs', ...args], { env, encoding: 'utf8' });
  const expected = JSON.parse(run('--expected-json')).hooks;
  const custom = { type: 'command', command: 'node "/my-hooks/session-relaunch.mjs"', timeout: 42 };
  const input = structuredClone(expected);
  input.SessionStart.push({ matcher: 'custom', hooks: [custom, { type: 'command', command: 'node "C:\\Users\\x\\orgiast-main\\tools\\retired-hook.mjs"' }] });
  input.SessionStart.push({ hooks: [{ type: 'command', command: 'node "C:/old/tools/session-relaunch.mjs"' }] });
  input.SessionStart[0].hooks[0].command = 'node "C:/Users/x/.claude/hooks/bg-launch.mjs" ' + input.SessionStart[0].hooks[0].command;
  input.PreToolUse[0].matcher = 'wrong';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ customSetting: 17, hooks: input }));
  run('--hooks-only');
  const first = fs.readFileSync(file, 'utf8'), stamp = fs.statSync(file).mtimeMs;
  const result = JSON.parse(first);
  assert.equal(result.customSetting, 17);
  assert.deepEqual(result.hooks, { ...expected, SessionStart: [{ matcher: 'custom', hooks: [custom] }, ...expected.SessionStart] });
  assert.match(run('--hooks-only'), /変更なし/);
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  assert.equal(fs.statSync(file).mtimeMs, stamp);
});

test('automatic anchor prefers clean dedicated main, rejects dirty/feature/ahead checkouts without writing settings', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-anchor-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nightly = path.join(home, '.claude/nightly-repo'), fallback = path.join(home, 'orgiast-claude-rules');
  const makeRepo = repo => {
    fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
    for (const name of ['register-hooks.mjs', 'session-relaunch.mjs']) fs.copyFileSync(path.resolve('tools', name), path.join(repo, 'tools', name));
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main'); git('add', '.');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    return git;
  };
  const git = makeRepo(nightly); makeRepo(fallback);
  const env = { ...process.env, ORGIAST_HOME: home }; delete env.ORGIAST_REPO;
  const run = () => spawnSync(process.execPath, ['tools/register-hooks.mjs', '--expected-json'], { env, encoding: 'utf8' });
  assert.ok(run().stdout.includes(JSON.stringify(nightly).slice(1, -1)));
  git('checkout', '--detach', 'origin/main');
  assert.equal(run().status, 0);
  assert.ok(run().stdout.includes(JSON.stringify(nightly).slice(1, -1)));
  fs.writeFileSync(path.join(nightly, 'dirty'), 'dirty');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  fs.unlinkSync(path.join(nightly, 'dirty'));
  fs.appendFileSync(path.join(nightly, 'tools/session-relaunch.mjs'), '\n// dirty\n');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  git('add', '.');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  git('reset', '--hard', 'HEAD'); git('switch', '-c', 'feature');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  git('switch', 'main'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'ahead');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  git('checkout', '--detach');
  assert.ok(run().stdout.includes(JSON.stringify(fallback).slice(1, -1)));
  fs.writeFileSync(path.join(fallback, 'dirty'), 'dirty');
  assert.equal(run().status, 1);
  assert.match(run().stderr, /onboarding-sync\.mjs" --force/);
  assert.equal(fs.existsSync(path.join(home, '.claude/settings.json')), false);
});

test('detached anchor accepts recent main ancestors and old exact tips, rejects stale or divergent history', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-anchor-age-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nightly = path.join(home, '.claude/nightly-repo');
  fs.mkdirSync(path.join(nightly, 'tools'), { recursive: true });
  for (const name of ['register-hooks.mjs', 'session-relaunch.mjs']) fs.copyFileSync(path.resolve('tools', name), path.join(nightly, 'tools', name));
  const git = (...args) => execFileSync('git', ['-C', nightly, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = hoursAgo => {
    const date = new Date(Date.now() - hoursAgo * 3600000).toISOString();
    execFileSync('git', ['-C', nightly, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', `age ${hoursAgo}`],
      { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return git('rev-parse', 'HEAD');
  };
  git('init', '-b', 'main'); git('add', '.');
  const old = commit(48);
  git('update-ref', 'refs/remotes/origin/main', old);
  git('checkout', '--detach', old);
  const env = { ...process.env, ORGIAST_HOME: home }; delete env.ORGIAST_REPO;
  const run = (...args) => spawnSync(process.execPath, ['tools/register-hooks.mjs', ...args], { env, encoding: 'utf8' });
  assert.equal(run('--expected-json').status, 0, 'exact tip is valid even when old');
  const recent = commit(23), tip = commit(0);
  git('update-ref', 'refs/remotes/origin/main', tip);
  git('checkout', '--detach', recent);
  const registered = run('--hooks-only');
  assert.equal(registered.status, 0, registered.stderr);
  const file = path.join(home, '.claude/settings.json');
  const settings = fs.readFileSync(file, 'utf8');
  assert.ok(settings.includes(JSON.stringify(nightly).slice(1, -1)));
  git('checkout', '--detach', old);
  assert.equal(run('--hooks-only').status, 1, 'stale ancestor rejected');
  commit(0);
  assert.equal(run('--hooks-only').status, 1, 'recent divergent detached commit rejected');
  assert.equal(fs.readFileSync(file, 'utf8'), settings, 'rejection preserves settings');
});

test('fleet inbox is registered synchronously for both events, idempotently, with a five-second timeout', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-fleet-hooks-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve('.');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /old/tools/fleet-inbox-context.mjs', timeout: 30, async: true }] }] } }));
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'], { env, stdio: 'pipe' });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'tools/setup-manifest.json'), 'utf8'));
  for (const item of manifest.items.filter(i => i.spec.hookScript === 'fleet-inbox-context.mjs')) {
    const hooks = settings.hooks[item.spec.hookEvent].flatMap(group => group.hooks || []).filter(h => h.command.includes(item.spec.hookScript));
    assert.equal(hooks.length, 1); assert.equal(hooks[0].timeout, item.spec.timeout); assert.equal(hooks[0].async, undefined);
    assert.equal(hooks[0].command, `node "${path.join(repo, 'tools', item.spec.hookScript)}"${item.spec.hookArgs}`);
  }
});

test('E fleet-question-relay Stop hook is synchronous, bounded and idempotent', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-relay-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve('.'), env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { env, encoding: 'utf8' });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const hooks = settings.hooks.Stop.flatMap(g => g.hooks || []).filter(h => h.command.includes('fleet-question-relay.mjs'));
  assert.equal(hooks.length, 1); assert.equal(hooks[0].timeout, 5); assert.equal(hooks[0].async, undefined);
});

test('G8 relay registers Stop PreToolUse AskUserQuestion and Notification idempotently', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-relay-events-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const repo = path.resolve('.'), env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { env, encoding: 'utf8' });
  const { hooks } = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const stop = hooks.Stop.flatMap(g => g.hooks || []).find(h => h.command.includes('fleet-question-relay.mjs'));
  for (const event of ['Stop', 'PreToolUse', 'Notification']) {
    const groups = hooks[event].filter(g => g.hooks?.some(h => h.command.includes('fleet-question-relay.mjs')));
    assert.equal(groups.length, 1);
    const relay = groups[0].hooks.filter(h => h.command.includes('fleet-question-relay.mjs'));
    assert.equal(relay.length, 1); assert.equal(relay[0].timeout, stop.timeout); assert.equal(relay[0].async, undefined);
    if (event === 'PreToolUse') assert.equal(groups[0].matcher, 'AskUserQuestion');
  }
});

test('billing and implementation approval register synchronously, globally and idempotently', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-billing-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: path.resolve('.') };
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, ['tools/register-hooks.mjs', '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json')));
  for (const [event, name] of [['SessionStart', 'api-billing-guard'], ['UserPromptSubmit', 'api-billing-guard'], ['PreToolUse', 'api-billing-guard'], ['UserPromptSubmit', 'claude-impl-approval']]) {
    const groups = settings.hooks[event].filter(g => g.hooks.some(h => h.command.includes(name)));
    assert.equal(groups.length, 1); assert.equal(groups[0].matcher, undefined);
    const hook = groups[0].hooks.find(h => h.command.includes(name)); assert.equal(hook.timeout, 5); assert.ok(!hook.async);
  }
});

test('bihin K-column gate registers once with Sheets writes and both shells', async t => {
  const { HOOK_MATCHER } = await import('./bihin-kcol-gate.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-bihin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Reproduce the path/name collision even in CI checkouts named differently.
  const repo = path.join(home, 'bihin-kcol-gate');
  fs.symlinkSync(path.resolve('.'), repo, 'junction');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  for (let n = 0; n < 2; n++) execFileSync(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'], { env, encoding: 'utf8' });
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'));
  const groups = settings.hooks.PreToolUse.filter(g => g.hooks.some(h => h.command.includes('bihin-kcol-gate.mjs')));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, HOOK_MATCHER);
  assert.equal(groups[0].hooks[0].timeout, 15); // runner adds its five-second budget
  assert.match(groups[0].hooks[0].command, /gate-hook-runner/);
});

test('全OSの旧e2e/verify ps1登録を同期Stop mjsへ収束し再実行で不変', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-migration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude/settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const commands = ['C:\\Users\\uers\\.claude\\hooks\\', '/Users/test/.claude/hooks/', '/home/test/.claude/hooks/'].flatMap(root => ['check-e2e-before-stop', 'verify-before-done-detector'].map(name => `pwsh -File "${root}${name}.ps1"`));
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: commands.map(command => ({ command, async: true })) }] } }));
  const run = () => execFileSync(process.execPath, [path.resolve('tools/register-hooks.mjs'), '--hooks-only'], { env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: path.resolve('.') } });
  run();
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const hooks = settings.hooks.Stop.flatMap(g => g.hooks);
  for (const name of ['check-e2e-before-stop', 'verify-before-done-detector']) {
    assert.equal(hooks.filter(h => h.command.includes(name + '.ps1')).length, 0);
    const current = hooks.filter(h => h.command.includes(name + '.mjs'));
    assert.equal(current.length, 1);
    assert.notEqual(current[0].async, true);
  }
  run(); assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), settings);
});
