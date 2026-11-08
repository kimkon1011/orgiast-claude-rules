import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOOK_MATCHER, judge, overrideActive } from './gmail-connector-url-gate.mjs';

const script = fileURLToPath(new URL('./gmail-connector-url-gate.mjs', import.meta.url));
const gmail = (tool_input) => ({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-url-gate-'));
  fs.mkdirSync(path.join(home, '.claude'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('URL なしの本文は通す', () => assert.equal(judge(gmail({ subject: 'ご連絡', body: 'お世話になっております。' })).decision, 'pass'));
test('https URL 入りの body を止める', () => assert.equal(judge(gmail({ body: '詳細 https://example.com/path' })).decision, 'block'));
test('htmlBody の a href だけでも止める', () => assert.equal(judge(gmail({ htmlBody: '<a href="https://example.com">詳細</a>' })).decision, 'block'));
test('google.com/url?q= を常に止め、理由を明示する', () => {
  const result = judge(gmail({ subject: 'https://www.google.com/url?q=https://example.com&source=gmail' }));
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /貼り戻し/);
});
test('mailto: だけなら通す', () => assert.equal(judge(gmail({ body: 'mailto:sales@example.com' })).decision, 'pass'));
test('Gmail 以外のツールは対象外', () => assert.equal(judge({ tool_name: 'mcp__claude_ai_Discord__send_message', tool_input: { body: 'https://example.com' } }).decision, 'pass'));
test('override が有効期限内なら通る', (t) => {
  const home = fixture(t);
  const file = path.join(home, '.claude', 'gmail-connector-url-gate-override');
  fs.writeFileSync(file, new Date(Date.now() + 3600000).toISOString());
  assert.equal(overrideActive(home), true);
  assert.deepEqual(judge(gmail({ body: 'https://example.com' }), { home }).decision, 'pass');
});
test('全対象 action・アカウント suffix が matcher に一致する', () => {
  const matcher = new RegExp(`^(?:${HOOK_MATCHER})$`);
  for (const action of ['create_draft', 'update_draft', 'send_message', 'reply', 'forward']) {
    for (const suffix of ['', '_2', '_12']) assert.equal(matcher.test(`mcp__claude_ai_Gmail${suffix}__${action}`), true);
  }
});
test('CLI は block 時だけ PreToolUse deny を出す', (t) => {
  const home = fixture(t);
  const run = (input) => spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
  const blocked = run(gmail({ body: 'http://example.com' }));
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, 'deny');
  const passed = run(gmail({ body: 'URL なし' }));
  assert.equal(passed.status, 0, passed.stderr);
  assert.equal(passed.stdout, '');
});
