import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractAddresses, extractMentions, GMAIL_WRITE_ACTIONS, githubHandles, HOOK_MATCHER, isGhWriteCommand, isInternal, judge, judgeBash, loadLedger, SHELL_TOOLS, TARGET } from './internal-recipient-gmail-guard.mjs';

const ledger = JSON.parse(fs.readFileSync(new URL('./internal-recipients.default.json', import.meta.url), 'utf8'));
const hook = (tool_input, action = 'create_draft', account = '') => ({ tool_name: `mcp__claude_ai_Gmail${account}__${action}`, tool_input });
const script = fileURLToPath(new URL('./internal-recipient-gmail-guard.mjs', import.meta.url));
function homeFor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'internal-recipient-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
function run(input, home) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home }, timeout: 5000 });
}

test('社内スタッフへの下書きを拒否し、理由にアドレスを示す', () => {
  const result = judge(hook({ to: 'genbateam.toho@gmail.com' }), ledger);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /\[INTERNAL-RECIPIENT\].*genbateam\.toho@gmail\.com/);
});
test('表示名付きの社内ドメインへの送信を拒否', () => {
  assert.equal(judge(hook({ to: '金功勇 <nishi@orgiast.jp>' }, 'send_message'), ledger).decision, 'block');
});
test('外部顧客への下書きは通す', () => {
  assert.deepEqual(judge(hook({ to: 'customer@example.co.jp' }), ledger), { decision: 'pass', addresses: ['customer@example.co.jp'], internal: [] });
});
test('to が外部でも cc に内部宛があれば拒否', () => {
  assert.equal(judge(hook({ to: 'customer@example.co.jp', cc: ['keiri.orgiast@gmail.com'] }), ledger).decision, 'block');
});
test('Drive など対象外は即 pass', () => {
  assert.deepEqual(judge({ tool_name: 'mcp__claude_ai_Google_Drive__create_file', tool_input: { to: 'nishi@orgiast.jp' } }, null), { decision: 'pass', addresses: [], internal: [] });
});
test('配列、bcc、ネストした宛先オブジェクトを正規化し重複排除する', () => {
  assert.deepEqual(extractAddresses({ to: ['金 <NISHI@ORGIAST.JP>', 'nishi@orgiast.jp'], bcc: 'a@example.com; ATSUOAST3@gmail.com', recipients: [{ emailAddress: { address: 'KIMKONGYONG@gmail.com' } }], body: 'ignore@orgiast.jp', from: 'ignore@toho-kogyo.com', subject: 'ignore@orgiast.jp' }), ['nishi@orgiast.jp', 'a@example.com', 'atsuoast3@gmail.com', 'kimkongyong@gmail.com']);
});
test('ドメインは完全一致で照合する', () => {
  assert.equal(isInternal('person@TOHO-KOGYO.COM', ledger), true);
  for (const addr of ['a@sub.orgiast.jp', 'a@orgiast.jp.evil.com', 'a@fakeorgiast.jp', 'someone@gmail.com']) assert.equal(isInternal(addr, ledger), false);
});
test('全対象操作と番号付きアカウントを判定する', () => {
  for (const action of GMAIL_WRITE_ACTIONS) {
    for (const account of ['', '_2', '_12']) assert.equal(judge(hook({ bcc: 'keiri.orgiast@gmail.com' }, action, account), ledger).decision, 'block');
  }
  assert.equal(judge(hook({ to: 'keiri.orgiast@gmail.com' }, 'read_message'), ledger).decision, 'pass');
});
test('guard の対象 tool 名と hook matcher が一致する', () => {
  const matcher = new RegExp(`^(?:${HOOK_MATCHER})$`);
  for (const action of GMAIL_WRITE_ACTIONS) {
    for (const account of ['', '_2', '_12']) {
      const toolName = `mcp__claude_ai_Gmail${account}__${action}`;
      assert.equal(TARGET.test(toolName), true, `TARGET: ${toolName}`);
      assert.equal(matcher.test(toolName), true, `HOOK_MATCHER: ${toolName}`);
    }
  }
  for (const toolName of ['mcp__claude_ai_Gmail__get_message', 'mcp__claude_ai_Google_Drive__create_file']) {
    assert.equal(matcher.test(toolName), false, toolName);
  }
});
test('ローカル台帳が無ければ default、あればその台帳を使用する', (t) => {
  const home = homeFor(t);
  assert.deepEqual(loadLedger({ home }), ledger);
  const custom = { domains: ['staff.example.com'], addresses: ['staff@example.com'] };
  fs.writeFileSync(path.join(home, '.claude', 'internal-recipients.json'), '\uFEFF' + JSON.stringify(custom));
  assert.deepEqual(loadLedger({ home }), custom);
  assert.equal(judge(hook({ to: 'staff@example.com' }), loadLedger({ home })).decision, 'block');
});
test('壊れたJSON・不正な台帳形式は default に戻り実プロセスも落ちない', (t) => {
  const home = homeFor(t);
  for (const raw of ['{ broken', '{"domains":null,"addresses":[]}']) {
    fs.writeFileSync(path.join(home, '.claude', 'internal-recipients.json'), raw);
    assert.deepEqual(loadLedger({ home }), ledger);
    const result = run(hook({ to: 'genbateam.toho@gmail.com' }), home);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /default/);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const external = run(hook({ to: 'customer@example.co.jp' }), home);
    assert.equal(external.status, 0);
    assert.equal(external.stdout, '');
  }
});
test('stdin→stdout は既存 PreToolUse の deny 契約、pass は無出力', (t) => {
  const home = homeFor(t);
  const input = hook({ to: 'genbateam.toho@gmail.com' });
  const result = run(input, home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: judge(input, ledger).reason } });
  for (const input of [hook({ to: 'customer@example.co.jp' }), { tool_name: 'mcp__claude_ai_Google_Drive__create_file' }]) {
    const pass = run(input, home);
    assert.equal(pass.status, 0);
    assert.equal(pass.stdout, '');
    assert.equal(pass.stderr, '');
  }
});
test('既存配布処理は指定 matcher・timeout で登録し、再実行で重複しない', (t) => {
  const home = homeFor(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(script, path.join(repo, 'tools', path.basename(script)));
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const existing = { matcher: 'Example', hooks: [{ type: 'command', command: 'node existing.mjs' }] };
  fs.writeFileSync(settingsFile, JSON.stringify({ custom: true, hooks: { PreToolUse: [existing] } }));
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./register-hooks.mjs', import.meta.url)), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo }, timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    assert.equal(settings.custom, true);
    assert.deepEqual(settings.hooks.PreToolUse[0], existing);
    const groups = settings.hooks.PreToolUse.filter((group) => group.hooks.some((h) => h.command.includes('internal-recipient-gmail-guard')));
    assert.equal(groups.length, 1);
    assert.equal(groups[0].matcher, HOOK_MATCHER);
    assert.deepEqual(groups[0].hooks, [{ type: 'command', command: `node "${path.join(repo, 'tools', path.basename(script))}"`, timeout: 5 }]);
  }
});
test('既存の古い matcher を重複なしで昇格し、再実行しても変わらない', (t) => {
  const home = homeFor(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true });
  fs.copyFileSync(script, path.join(repo, 'tools', path.basename(script)));
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const oldMatcher = 'mcp__claude_ai_Gmail__create_draft|mcp__claude_ai_Gmail__send_message|mcp__claude_ai_Gmail__update_draft|mcp__claude_ai_Gmail__reply|mcp__claude_ai_Gmail__forward|mcp__claude_ai_Gmail_2__create_draft|mcp__claude_ai_Gmail_2__send_message';
  const command = `node "${path.join(repo, 'tools', path.basename(script))}"`;
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: oldMatcher, hooks: [{ type: 'command', command, timeout: 5 }] }] } }));
  const register = fileURLToPath(new URL('./register-hooks.mjs', import.meta.url));
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  const execute = () => spawnSync(process.execPath, [register, '--hooks-only'], { encoding: 'utf8', env, timeout: 5000 });
  const first = execute();
  assert.equal(first.status, 0, first.stderr);
  const promoted = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const groups = promoted.hooks.PreToolUse.filter((group) => group.hooks.some((item) => item.command.includes('internal-recipient-gmail-guard')));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, HOOK_MATCHER);
  const serialized = JSON.stringify(promoted);
  const second = execute();
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(settingsFile, 'utf8'))), serialized);
  // このrepoにはguard1本しか無い=他hookは全てskip。無言skip廃止により
  // 「変更なし」単独の正常表示にはならず、[注意]とskip行が出る(2026-09-14 実害の再発防止)。
  assert.match(second.stdout, /ただし \d+ 本は repo に無く未登録/);
  assert.match(second.stdout, /\[skip\] /);
  assert.doesNotMatch(second.stdout, /hook は既に登録済み\(変更なし\)/);
});

// --- GitHub @メンション（gh の書き込み系を Bash/PowerShell 経由で叩く経路） ---
const shellHook = (command, tool = 'Bash') => ({ tool_name: tool, tool_input: { command } });

test('gh pr comment の内部ハンドル @メンションを拒否する', () => {
  const result = judgeBash(shellHook("gh pr comment 529 --body 'LGTM @kimkon1011 確認お願いします'"), ledger);
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.internal, ['kimkon1011']);
  assert.match(result.reason, /\[INTERNAL-MENTION\].*@kimkon1011/);
});
test('大小無視で、issue/PR本文・レビュー・REST コメントも拒否する', () => {
  for (const command of [
    'gh issue create --title x --body "@KimKon1011"',
    'gh pr create --title x --body "@KIMKON1011 レビューお願いします"',
    'gh pr review 12 --comment --body "@kimkon1011"',
    'gh pr edit 3 --body "@kimkon1011"',
    "gh api repos/o/r/issues/1/comments -f body='cc @kimkon1011'",
  ]) assert.equal(judgeBash(shellHook(command), ledger).decision, 'block', command);
});
test('複数ハンドルのうち内部のものだけを理由に出す', () => {
  const result = judgeBash(shellHook('gh pr comment 1 --body "@dependabot @kimkon1011 @octocat"'), ledger);
  assert.deepEqual(result.mentions, ['dependabot', 'kimkon1011', 'octocat']);
  assert.deepEqual(result.internal, ['kimkon1011']);
});
test('外部ハンドル・メンション無しは通す', () => {
  for (const command of [
    'gh pr comment 529 --body "LGTM"',
    'gh pr comment 529 --body "@dependabot rebase"',
    'gh pr comment 529 --body "担当は kim です"',
  ]) assert.equal(judgeBash(shellHook(command), ledger).decision, 'pass', command);
});
test('メールアドレス内の @ はメンションとして拾わない', () => {
  const command = "gh pr comment 1 --body '連絡先は info@kimkon1011.com です'";
  assert.equal(isGhWriteCommand(command), true);
  assert.deepEqual(extractMentions(command), []);
  assert.equal(judgeBash(shellHook(command), ledger).decision, 'pass');
});
test('より長い別ハンドルを前方一致で誤検知しない', () => {
  // ハンドルとして丸ごと切り出すので、台帳の完全一致に落ちない＝deny しない。
  assert.deepEqual(extractMentions('@kimkon1011x @kimkon1011-bot'), ['kimkon1011x', 'kimkon1011-bot']);
  for (const handle of ['@kimkon1011x', '@kimkon1011-bot']) {
    assert.equal(judgeBash(shellHook(`gh pr comment 1 --body "${handle}"`), ledger).decision, 'pass', handle);
  }
});
test('GitHub の書き込み系以外は判定しない', () => {
  for (const command of [
    "git commit -m '@kimkon1011'",
    'gh pr view 529',
    'gh pr list --search "@kimkon1011"',
    'gh api repos/o/r/issues/1',
    'echo "@kimkon1011"',
    'gh issue view 1 --comments',
  ]) assert.deepEqual(judgeBash(shellHook(command), ledger), { decision: 'pass', mentions: [], internal: [] }, command);
});
test('PowerShell 経由でも同じ判定、対象外ツールと空入力は即 pass', () => {
  assert.equal(judgeBash(shellHook("gh pr comment 1 --body '@kimkon1011'", 'PowerShell'), ledger).decision, 'block');
  const other = { tool_name: 'Write', tool_input: { command: "gh pr comment 1 --body '@kimkon1011'" } };
  assert.deepEqual(judgeBash(other, ledger), { decision: 'pass', mentions: [], internal: [] });
  assert.deepEqual(judgeBash(null, ledger), { decision: 'pass', mentions: [], internal: [] });
});
test('githubHandles を持たない台帳でも落ちずに pass する', () => {
  const legacy = { domains: ['orgiast.jp'], addresses: [] };
  assert.deepEqual(githubHandles(legacy), []);
  assert.equal(judgeBash(shellHook("gh pr comment 1 --body '@kimkon1011'"), legacy).decision, 'pass');
});
test('default 台帳が githubHandles を持ち、matcher が Bash/PowerShell を含む', () => {
  assert.deepEqual(ledger.githubHandles, ['kimkon1011']);
  assert.equal(SHELL_TOOLS, 'Bash|PowerShell');
  const matcher = new RegExp(`^(?:${HOOK_MATCHER})$`);
  for (const toolName of ['Bash', 'PowerShell']) assert.equal(matcher.test(toolName), true, toolName);
});
test('githubHandles が配列でない台帳は default に戻る', (t) => {
  const home = homeFor(t);
  fs.writeFileSync(path.join(home, '.claude', 'internal-recipients.json'), JSON.stringify({ domains: [], addresses: [], githubHandles: 'kimkon1011' }));
  assert.deepEqual(loadLedger({ home }), ledger);
  assert.equal(judgeBash(shellHook("gh pr comment 1 --body '@kimkon1011'"), loadLedger({ home })).decision, 'block');
});
test('stdin→stdout で gh メンションを deny し、メンション無しは無出力', (t) => {
  const home = homeFor(t);
  const blocked = run({ tool_name: 'Bash', tool_input: { command: "gh pr comment 529 --body '@kimkon1011 確認お願いします'" } }, home);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stderr, '');
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecisionReason, /\[INTERNAL-MENTION\]/);
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'gh pr comment 529 --body "LGTM"' } },
    { tool_name: 'Bash', tool_input: { command: 'gh pr comment 529 --body "@dependabot rebase"' } },
    { tool_name: 'Bash', tool_input: { command: 'git status --porcelain' } },
    { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' } },
  ]) {
    const pass = run(input, home);
    assert.equal(pass.status, 0, pass.stderr);
    assert.equal(pass.stdout, '');
    assert.equal(pass.stderr, '');
  }
});
