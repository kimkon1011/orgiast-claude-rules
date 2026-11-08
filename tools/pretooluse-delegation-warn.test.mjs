import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pretooluse-delegation-warn.mjs');

function homeWithMode(mode = 'block') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-warn-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), JSON.stringify({ mode }));
  return home;
}

function run(input, home) {
  return spawnSync(process.execPath, [script], {
    input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home },
  });
}

function addFakeGemini(home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const executable = path.join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
  fs.writeFileSync(executable, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  fs.chmodSync(executable, 0o755);
  return bin;
}

const edit = { tool_name: 'Write', tool_input: { file_path: '/project/src/app.js', content: 'code' } };

test('mode=block のまとまった実装は deny する', () => {
  assert.match(run(edit, homeWithMode()).stdout, /permissionDecision.*deny/);
});

test('mode=block で Codex クールダウン中でも Gemini があれば deny を維持する', () => {
  const home = homeWithMode();
  const bin = addFakeGemini(home);
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({
    codex: { until: Date.now() + 60 * 60_000, reason: 'usage_limit', at: Date.now() },
  }));
  const output = spawnSync(process.execPath, [script], { input: JSON.stringify(edit), encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ORGIAST_HOME: home } }).stdout;
  assert.match(output, /permissionDecision.*deny/);
  assert.match(output, /内蔵フォールバック/);
});

test('mode=block で Codex とフォールバックが使えなくても deny する', () => {
  const home = homeWithMode();
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({
    codex: { until: Date.now() + 60 * 60_000, reason: 'usage_limit_no_fallback', at: Date.now() },
  }));
  const output = run(edit, home).stdout;
  assert.match(output, /permissionDecision.*deny/);
  assert.match(output, /全滅なら実装を止め/);
});

test('warn/override cannot bypass; only current session approval can', () => {
  const home = homeWithMode('warn');
  fs.writeFileSync(path.join(home, '.claude/cost-enforce-override'), '1');
  assert.match(run(edit, home).stdout, /permissionDecision.*deny/);
  fs.writeFileSync(path.join(home, '.claude/claude-impl-allow.json'), JSON.stringify({ sessionId: 's', until: new Date(Date.now() + 3500000).toISOString(), marker: '[CLAUDE-IMPL-OK]' }));
  assert.match(run({ ...edit, session_id: 's' }, home).stdout, /additionalContext/);
  assert.match(run({ ...edit, session_id: 'other' }, home).stdout, /permissionDecision.*deny/);
});
test('small edits and excluded paths still pass', () => {
  const home = homeWithMode();
  for (const file_path of ['/project/tools/x.js', '/project/docs/x.js', '/project/tests/x.js', 'C:\\project\\.claude\\x.js', '/project/x.md']) assert.equal(run({ ...edit, tool_input: { file_path } }, home).stdout, '');
  for (const size of [400, 401]) {
    const r = run({ tool_name: 'Edit', tool_input: { file_path: '/project/src/x.js', new_string: 'x'.repeat(size) } }, home);
    if (size === 400) assert.equal(r.stdout, ''); else assert.match(r.stdout, /permissionDecision.*deny/);
  }
});
