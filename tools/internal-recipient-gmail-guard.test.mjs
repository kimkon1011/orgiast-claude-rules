import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractAddresses, isInternal, judge, loadLedger } from './internal-recipient-gmail-guard.mjs';

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
  for (const action of ['create_draft', 'send_message', 'update_draft', 'reply', 'forward']) {
    for (const account of ['', '_2', '_12']) assert.equal(judge(hook({ bcc: 'keiri.orgiast@gmail.com' }, action, account), ledger).decision, 'block');
  }
  assert.equal(judge(hook({ to: 'keiri.orgiast@gmail.com' }, 'read_message'), ledger).decision, 'pass');
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
    assert.equal(groups[0].matcher, 'mcp__claude_ai_Gmail__create_draft|mcp__claude_ai_Gmail__send_message|mcp__claude_ai_Gmail__update_draft|mcp__claude_ai_Gmail__reply|mcp__claude_ai_Gmail__forward|mcp__claude_ai_Gmail_2__create_draft|mcp__claude_ai_Gmail_2__send_message');
    assert.deepEqual(groups[0].hooks, [{ type: 'command', command: `node "${path.join(repo, 'tools', path.basename(script))}"`, timeout: 5 }]);
  }
});
