import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
function setup(lane='implement', model='claude-fable-5', extra={}) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-')); fs.mkdirSync(path.join(home,'.claude','session-lane'),{recursive:true}); fs.writeFileSync(path.join(home,'.claude','session-lane','s.json'),JSON.stringify({lane,toolCalls:extra.toolCalls||0,laneOk:extra.laneOk,at:extra.at||new Date().toISOString(),prompt:extra.prompt||'[LANE-OK]'})); fs.writeFileSync(path.join(home,'t.jsonl'),JSON.stringify({message:{model}})+'\n'); if(extra.config) fs.writeFileSync(path.join(home,'.claude','lane-guard.json'),JSON.stringify(extra.config)); return home; }
function run(home, overrides={}) { const input={session_id:'s',transcript_path:path.join(home,'t.jsonl'),tool_name:'Write',tool_input:{file_path:path.join(home,'x.js')},...overrides}; const r=spawnSync(process.execPath,['tools/pretooluse-lane-guard.mjs'],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,ORGIAST_HOME:home}}); return r.stdout.trim()?JSON.parse(r.stdout):null; }
test('カウントし warnAt 境界で警告',()=>{const h=setup('implement','claude-fable-5',{toolCalls:3}); assert.match(run(h).hookSpecificOutput.additionalContext,/4 回/);});
test('blockAt 境界でdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7}); assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');});
test('consultはblockしない',()=>{const h=setup('consult','claude-fable-5',{toolCalls:7}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('LANE-OKはblockしない',()=>{const h=setup('bulk','claude-fable-5',{toolCalls:7,laneOk:true}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('warn modeでもblockする',()=>{const h=setup('verify','claude-fable-5',{toolCalls:7,config:{mode:'warn'}}); assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');});
for(const model of ['claude-sonnet-5','claude-haiku-4']) test(model+'もdeny',()=>assert.equal(run(setup('implement',model,{toolCalls:7})).hookSpecificOutput.permissionDecision,'deny'));
test('subagentsは除外',()=>{const h=setup(); assert.equal(run(h,{transcript_path:path.join(h,'subagents','x.jsonl')}),null);});
test('委譲コマンドは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/codex-do.mjs --prompt-file x'}}),null);});
test('read-onlyは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'git status'}}),null);});
test('.md編集は除外',()=>{const h=setup(); assert.equal(run(h,{tool_input:{file_path:path.join(h,'x.md')}}),null);});
test('生存レーンありは旧bypass条件でもdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/provider-cooldown.json'),JSON.stringify({codex:{until:Date.now()+3600000,reason:'usage_limit_no_fallback'}}));fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['deepseek']}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/deepseek.*codex-do\.mjs/);});
test('全滅かつ新鮮なprobeでもdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date().toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/全滅なら実装を止め/);});
test('全滅かつ古いprobeはdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date(Date.now()-3600000).toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/lane-doctor\.mjs --probe/);});
test('lane-doctor呼び出しは委譲扱い',()=>{const h=setup('implement','claude-opus-5',{toolCalls:100});assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/lane-doctor.mjs --probe'}}),null);});
test('autopilot-tick呼び出しは委譲扱い',()=>{const h=setup('implement','claude-opus-5',{toolCalls:100});assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/autopilot-tick.mjs post --status running'}}),null);});

test('gateRequired の auto-progress は上限超過後も通し、通常コマンドは deny', t => {
  const h = setup('implement', 'claude-opus-5', { toolCalls: 9 });
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const allowed = 'node tools/auto-progress.mjs --add-check --session S --check "node x" --deadline +7d --label "L"';
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: allowed } }), null);
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: `cd "${h}" && ${allowed}` } }), null);
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: `${allowed}; node tools/foo.mjs` } }).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: 'node tools/foo.mjs' } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('gateRequired matches quoted paths', t => {
  const h = setup('implement', 'claude-opus-5', { toolCalls: 9 });
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const doubleQuote = 'node "C:/Users/uers/.claude/nightly-repo/tools/auto-progress.mjs" --help';
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: doubleQuote } }), null);
  const singleQuote = "node 'C:/Users/uers/.claude/nightly-repo/tools/auto-progress.mjs' --help";
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: singleQuote } }), null);
  const unquoted = 'node C:/Users/uers/.claude/nightly-repo/tools/auto-progress.mjs --help';
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: unquoted } }), null);
  const compound = 'node "x/auto-progress.mjs"; rm -rf x';
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: compound } }).hookSpecificOutput.permissionDecision, 'deny');
});

test('Codex alive deny points directly to codex-do without unavailable wording',t=>{
  const h=setup('implement','claude-opus-5',{toolCalls:7});
  t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
  fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['codex','deepseek']}));
  const r=run(h).hookSpecificOutput;
  assert.equal(r.permissionDecision,'deny');
  assert.match(r.permissionDecisionReason,/Codex は生きている。node tools\/codex-do\.mjs --prompt-file <指示> --cwd <対象> へ渡せ/);
  assert.doesNotMatch(r.permissionDecisionReason,/使えない時/);
});

test('userFacing consultは5回呼んでも警告しない、過去ログは数えない', t => {
  const h = setup('consult'); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const file = path.join(h, '.claude', 'session-lane', 's.json'); fs.writeFileSync(file, JSON.stringify({ lane: 'consult', userFacing: true, toolCalls: 0 }));
  for (let i = 0; i < 5; i++) assert.equal(run(h), null);
  assert.equal(run(h, { tool_name: 'Grep', tool_input: { path: '~/.claude/projects', pattern: 'MacroDroid' } }), null);
  assert.equal(JSON.parse(fs.readFileSync(file)).toolCalls, 5);
});
test('override file no longer bypasses; session approval does', t => {
  const h = setup('implement','claude-sonnet-5',{toolCalls:7}); t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
  fs.writeFileSync(path.join(h,'.claude/cost-enforce-override'),'1');
  assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');
  fs.writeFileSync(path.join(h,'.claude/claude-impl-allow.json'),JSON.stringify({sessionId:'s',marker:'[CLAUDE-IMPL-OK]',until:new Date(Date.now()+3500000).toISOString()}));
  assert.equal(run(h),null);
});

test('LANE-OK state cannot bypass with negative prompt or after 60 minutes', t => {
  for (const extra of [{prompt:'[LANE-OK] 禁止'}, {at:new Date(Date.now()-3600001).toISOString()}]) {
    const h=setup('implement','claude-sonnet-5',{toolCalls:7,laneOk:true,...extra}); t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
    assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');
  }
});

for (const tool_name of ['Bash', 'PowerShell']) {
  test(`${tool_name}: operator scripts neither count nor warn/deny`, t => {
    for (const toolCalls of [0, 3, 8, 100]) {
      const h = setup('implement', 'claude-opus-5', { toolCalls });
      t.after(() => fs.rmSync(h, { recursive: true, force: true }));
      const commands = [
        ...['click', 'paste', 'key', 'shot'].map(action => `powershell -STA -File ~/.claude/tools/line-pc-act.ps1 -Action ${action}`),
        'powershell -File ~/.claude/tools/line-send.ps1',
        ...['make-desktop-launcher', 'notify-kim', 'discord-dm', 'fleet-mail'].map(name => `node ~/.claude/tools/${name}.mjs`),
      ];
      for (const command of commands) {
        assert.equal(run(h, { tool_name, tool_input: tool_name === 'Bash' ? { command } : { script: command } }), null, command);
        assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, toolCalls);
      }
    }
  });
  test(`${tool_name}: scratchpad LINE wrappers are exempt only for single invocations`, t => {
    const h = setup('implement', 'claude-opus-5', { toolCalls: 100 });
    t.after(() => fs.rmSync(h, { recursive: true, force: true }));
    const dir = path.join(h, 'scratchpad'); fs.mkdirSync(dir);
    const file = path.join(dir, 'gui sequence.ps1');
    fs.writeFileSync(file, '& ~/.claude/tools/line-pc-act.ps1 -Action click');
    for (const command of [`powershell -STA -File "${file}"`, `pwsh -NoProfile -ExecutionPolicy Bypass -File '${file}'`, `& "${file}"`, `"${file}"`]) {
      assert.equal(run(h, { tool_name, tool_input: { command } }), null, command);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, 100);
    }
    const outside = path.join(h, 'outside.ps1'); fs.copyFileSync(file, outside);
    const ordinary = path.join(dir, 'ordinary.ps1'); fs.writeFileSync(ordinary, 'Write-Output hello');
    let expected = 100;
    for (const command of [`powershell -File "${file}"; node build.mjs`, `powershell -File "${file}" && node build.mjs`, `powershell -File "${outside}"`, `powershell -File "${dir}/../outside.ps1"`, `powershell -File "${ordinary}"`, `powershell -File "${dir}/missing.ps1"`, 'node build.mjs']) {
      assert.equal(run(h, { tool_name, tool_input: { command } }).hookSpecificOutput.permissionDecision, 'deny', command);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, ++expected);
    }
  });
}

test('repair log remains callable after lane guard limit in unattended session', t => {
  const h = setup('implement', 'claude-sonnet-5', { toolCalls: 100 });
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: 'node tools/lane-repair-log.mjs --lane deepseek --tried check --result unfixable' } }), null);
});

function calls(home) { return JSON.parse(fs.readFileSync(path.join(home, '.claude/session-lane/s.json'))).toolCalls; }
function codexDown(home) { fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ implementOrder: ['deepseek', 'openrouter'] })); }

test('blockAt 以降の session-claims --release / close-session / node --test は拒否せず回数に入れない', t => {
  const commands = [
    'node tools/session-claims.mjs --release --self s --reason closed',
    'node ~/orgiast-claude-rules/tools/session-claims.mjs --release --self s --reason closed',
    'node "$HOME/orgiast-claude-rules/tools/close-session.mjs" --session s',
    'node ~/.claude/nightly-repo/tools/close-session.mjs --session abc --no-launch',
    'node --test tools/pretooluse-lane-guard.test.mjs',
    'node --test --test-concurrency=1 tools/a.test.mjs tools/b.test.mjs',
    'node.exe --check tools/pretooluse-lane-guard.mjs',
    'cd repo && node --test tools/a.test.mjs',
    'git status --short',
    'git diff --stat',
    'git log -5 --oneline',
    'git --no-pager log -1',
    'cd repo && git status --short && git diff && git log -1',
    'git -C repo diff',
    'node tools/kim-inbox.mjs --status',
    'node tools/kim-inbox.mjs --add --kind info --summary "報告 & 記録" --body-file report.md',
    'node tools/drive-upload.mjs --file "report.md" --folder folderId --authuser kim@example.com',
    'node tools/next-session-rotate.mjs',
    'node tools/next-session-launch.mjs --show-target',
    'rclone copyto report.md remote:name --drive-root-folder-id folderId',
    '& node tools/close-session.mjs --session s',
  ];
  for (const lane of ['implement', 'edit-small', 'verify', 'bulk']) {
    const h = setup(lane, 'claude-opus-5', { toolCalls: 7 });
    t.after(() => fs.rmSync(h, { recursive: true, force: true }));
    codexDown(h);
    for (const tool_name of ['Bash', 'PowerShell']) {
      for (const command of commands) {
        const tool_input = tool_name === 'PowerShell' ? { script: command } : { command };
        assert.equal(run(h, { tool_name, tool_input }), null, `${lane} ${tool_name}: ${command}`);
      }
    }
    assert.equal(calls(h), 7, lane);
    assert.equal(run(h, { tool_input: { file_path: path.join(h, '.claude', 'next-session.md') } }), null);
    assert.equal(calls(h), 7, lane);
  }
});

test('確認コマンドは実装の警告回数を消費しない', t => {
  const h = setup('implement', 'claude-opus-5', { toolCalls: 0 });
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  codexDown(h);
  for (let i = 0; i < 3; i++) assert.equal(run(h, { tool_name: 'Edit', tool_input: { file_path: path.join(h, 'a.js') } }), null);
  for (const command of ['node --test tools/a.test.mjs', 'node tools/session-claims.mjs --release --self s --reason closed', 'git status']) {
    assert.equal(run(h, { tool_name: 'Bash', tool_input: { command } }), null);
  }
  assert.equal(calls(h), 3);
  assert.match(run(h, { tool_name: 'Write', tool_input: { file_path: path.join(h, 'a.js') } }).hookSpecificOutput.additionalContext, /4 回/);
});

test('軽い操作に実装を混ぜると拒否し、Edit/Write の連続は警告のあと拒否する', t => {
  const blocked = setup('implement', 'claude-opus-5', { toolCalls: 100 });
  t.after(() => fs.rmSync(blocked, { recursive: true, force: true }));
  codexDown(blocked);
  const mixed = [
    'node --test tools/a.test.mjs &',
    'node --test tools/a.test.mjs; node tools/foo.mjs',
    'node tools/close-session.mjs --session s && node tools/foo.mjs',
    'node tools/session-claims.mjs --release --self s; rm -rf x',
    'node --check tools/a.mjs > out',
    'node --test -e "fs.writeFileSync(\'a.js\', \'code\')"',
    'node tools/foo.mjs --test',
    'node --test-reporter=spec tools/foo.mjs',
    'node /tmp/close-session.mjs --session s',
    'node tools/foo.mjs',
    'rclone sync a remote:b',
    'node --require ./hook.js tools/close-session.mjs --session s',
  ];
  let expected = 100;
  for (const command of mixed) {
    const result = run(blocked, { tool_name: 'Bash', tool_input: { command } });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny', command);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /Codex が使えない時は deepseek へ。生存レーン: deepseek, openrouter/);
    assert.equal(calls(blocked), ++expected, command);
  }
  const h = setup('implement', 'claude-opus-5', { toolCalls: 0 });
  t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  codexDown(h);
  const edit = () => run(h, { tool_name: 'Edit', tool_input: { file_path: path.join(h, 'impl.js') } });
  const write = () => run(h, { tool_name: 'Write', tool_input: { file_path: path.join(h, 'impl.js') } });
  for (let i = 1; i <= 3; i++) assert.equal(edit(), null, `edit ${i}`);
  assert.match(write().hookSpecificOutput.additionalContext, /4 回/);
  for (let i = 5; i <= 7; i++) assert.match(edit().hookSpecificOutput.additionalContext, new RegExp(`${i} 回`));
  const denied = write();
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /Codex が使えない時は deepseek へ。生存レーン: deepseek, openrouter/);
  assert.equal(calls(h), 8);
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: 'node --test tools/a.test.mjs' } }), null);
  assert.equal(run(h, { tool_name: 'Bash', tool_input: { command: 'node tools/session-claims.mjs --release --self s --reason closed' } }), null);
  assert.equal(run(h, { tool_name: 'PowerShell', tool_input: { script: 'node tools/close-session.mjs --session s' } }), null);
  assert.equal(calls(h), 8);
  assert.equal(edit().hookSpecificOutput.permissionDecision, 'deny');
});
