import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { xUrlContext } from './x-url-route-hint.mjs';

const hook = input => spawnSync(process.execPath, ['tools/x-url-route-hint.mjs'], { input, encoding: 'utf8' });
test('X/twitterの投稿URLで1行のadditionalContextを出す', () => {
  for (const url of ['https://x.com/user/status/123?s=20', 'https://twitter.com/user/status/456', 'x.com/i/web/status/789']) {
    const result = hook(JSON.stringify({ prompt: `これを読む「${url}」` }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    const output = JSON.parse(result.stdout).hookSpecificOutput;
    assert.equal(output.hookEventName, 'UserPromptSubmit');
    assert.match(output.additionalContext, /^\[X投稿の読み方\].*node ".*tools[/\\]grok-x-fetch.mjs" --url https:\/\//);
    assert.match(output.additionalContext, /WebFetch は 402/);
    assert.equal(output.additionalContext.split('\n').length, 1);
  }
});
test('投稿URLなし・不正JSONは無音でexit 0', () => {
  for (const prompt of ['普通の質問', 'https://x.com/user', 'https://fxtwitter.com/user/status/123', 'https://evilx.com/user/status/123', 'https://x.com.evil/user/status/123']) {
    assert.equal(xUrlContext({ prompt }), '');
    const result = hook(JSON.stringify({ prompt }));
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
  assert.equal(hook('{broken').stdout, '');
  assert.equal(hook('{broken').status, 0);
});
test('全PC用converge設定と実際の登録に同期フックがある', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'x-route-register-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['tools/register-hooks.mjs', '--expected-json'], {
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: process.cwd() },
  });
  assert.equal(result.status, 0, result.stderr);
  const hooks = JSON.parse(result.stdout).hooks.UserPromptSubmit.flatMap(group => group.hooks).filter(hook => hook.command.includes('x-url-route-hint.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].timeout, 5);
  assert.ok(!hooks[0].async);
  const manifest = JSON.parse(fs.readFileSync('tools/setup-manifest.json', 'utf8'));
  const item = manifest.items.find(item => item.spec.hookScript === 'x-url-route-hint.mjs');
  assert.equal(item.scope, undefined);
  assert.equal(item.severity, 'required');
  assert.deepEqual(item.repair, ['register-hooks.mjs', '--hooks-only']);
});
