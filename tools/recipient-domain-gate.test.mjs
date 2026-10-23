import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { judge } from './recipient-domain-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';
const missing = async () => { throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' }); };
const bad = { resolveMx: missing, resolve4: missing, resolve6: missing };
const good = { ...bad, resolveMx: async () => [{}] };
const opts = resolver => ({ resolver, cachePath: null, warn: () => {} });
const gmail = to => ({ tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to } });
function fixture(t, source = 'fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send"); read("xxx-parsed.json");') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipient-domain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'send mail.mjs'), source);
  fs.writeFileSync(path.join(dir, 'xxx-parsed.json'), JSON.stringify({ to: 'ito@wamu-sr.co.jp' }));
  return { cwd: dir, tool_name: 'Bash', tool_input: { command: 'node.exe "send mail.mjs" --dry-run' } };
}
test('OCR incident script plus sibling JSON denied even dry-run', async t => {
  const input = fixture(t);
  for (const flag of ['', '--dry-run', '--dry', '--send']) {
    input.tool_input.command = `node.exe "send mail.mjs" ${flag}`;
    const result = await judge(input, opts(bad)); assert.equal(result.decision, 'block');
    assert.match(result.reason, /ito@wamu-sr.co.jp/); assert.match(result.reason, /名刺画像・元データ/);
  }
});
test('Gmail actions and nested recipients denied; bodies ignored', async () => {
  for (const action of ['send_message', 'create_draft', 'reply', 'forward', 'update_draft']) {
    const input = { tool_name: `mcp__claude_ai_Gmail_2__${action}`, tool_input: { to: [{ email: 'ito@wamu-sr.co.jp' }] } };
    assert.equal((await judge(input, opts(bad))).decision, 'block');
  }
  const input = gmail('kim@orgiast.jp'); input.tool_input.body = 'ito@wamu-sr.co.jp';
  assert.equal((await judge(input, opts(bad))).decision, 'pass');
});
test('all MX pass, fallback A pass, absent A deny', async t => {
  const input = fixture(t);
  for (const resolver of [good, { ...bad, resolve4: async () => ['1.2.3.4'] }]) assert.equal((await judge(input, opts(resolver))).decision, 'pass');
  assert.equal((await judge(input, opts(bad))).decision, 'block');
});
test('DNS timeout passes and emits a single warning', async () => {
  const warnings = [];
  const result = await judge(gmail('a@example.com'), { ...opts({ ...bad, resolveMx: async () => { throw Object.assign(new Error(), { code: 'ETIMEOUT' }); } }), warn: s => warnings.push(s) });
  assert.equal(result.decision, 'pass'); assert.equal(warnings.length, 1);
});
test('internal only and non-send scripts never query DNS', async t => {
  let calls = 0; const options = opts({ ...bad, resolveMx: async () => { calls++; return []; } });
  assert.equal((await judge(gmail(['kim@orgiast.jp', 'x@sub.orgiast.jp']), options)).decision, 'pass');
  assert.equal((await judge(fixture(t, 'console.log("a@example.com")'), options)).decision, 'pass');
  assert.equal(calls, 0);
});
test('gmail-draft inspects only recipient flags on both shells', async () => {
  for (const tool_name of ['Bash', 'PowerShell']) {
    const input = { tool_name, tool_input: { command: 'node tools/gmail-draft.mjs --to kim@orgiast.jp --body "a@bad.com" --body-file missing.txt' } };
    assert.equal((await judge(input, opts(bad))).decision, 'pass');
    input.tool_input.command += ' --bcc=a@bad.com';
    assert.equal((await judge(input, opts(bad))).decision, 'block');
  }
});
test('script source and named CSV are checked, unrelated siblings ignored', async t => {
  const input = fixture(t, 'gmail.send("a@example.com"); read("list.csv")');
  fs.writeFileSync(path.join(input.cwd, 'list.csv'), 'b@example.com');
  const domains = [];
  assert.equal((await judge(input, opts({ ...good, resolveMx: async d => { domains.push(d); return [{}]; } }))).decision, 'pass');
  assert.deepEqual(domains, ['example.com']);
});
test('oversized data fail open with warning', async t => {
  const input = fixture(t); fs.writeFileSync(path.join(input.cwd, 'xxx-parsed.json'), 'x'.repeat(5 * 1024 * 1024 + 1));
  const warnings = [];
  assert.equal((await judge(input, { ...opts(bad), warn: s => warnings.push(s) })).decision, 'pass');
  assert.equal(warnings.length, 1);
});
test('overall deadline passes and cancels queued domain work', async () => {
  const warnings = []; let calls = 0;
  const result = await judge(gmail(Array.from({ length: 20 }, (_, i) => `a@x${i}.com`)), {
    ...opts({ ...bad, resolveMx: () => { calls++; return new Promise(() => {}); } }), budgetMs: 20, warn: s => warnings.push(s),
  });
  assert.equal(result.decision, 'pass'); assert.equal(calls, 8); assert.equal(warnings.length, 1);
});
test('rollout immediately denies on nonpilot first receipt', () => assert.equal(rolloutMode('recipient-domain-gate', { hostname: 'new-host' }), 'deny'));
test('entrypoint malformed input fails open naturally', () => {
  const child = spawnSync(process.execPath, ['tools/recipient-domain-gate.mjs'], { input: '{', encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0); assert.equal(child.stdout, ''); assert.match(child.stderr, /RECIPIENT-DOMAIN/);
});

test('direct gmail-draft execution checks recipients', async () => {
  assert.equal((await judge({ tool_name: 'Bash', tool_input: { command: './tools/gmail-draft.mjs --to a@bad.com' } }, opts(bad))).decision, 'block');
});

test('draft recipient parsing stops at the next shell command', async () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'node tools/gmail-draft.mjs --to kim@orgiast.jp; echo --to a@bad.com' } };
  assert.equal((await judge(input, opts(bad))).decision, 'pass');
});
test('script resolves after shell directory change', async t => {
  const input = fixture(t);
  input.tool_input.command = `cd "${input.cwd}" && node.exe "send mail.mjs"`;
  input.cwd = os.tmpdir();
  assert.equal((await judge(input, opts(bad))).decision, 'block');
});
