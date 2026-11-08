import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isReadOnlyToolUse } from './usage-stats.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pretooluse-serial-investigation.mjs');
function fixture() { return fs.mkdtempSync(path.join(os.tmpdir(), 'serial-investigation-')); }
function run(home, input) { return spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } }); }
function call(home, command = 'cat foo.txt', session_id = 's') { return run(home, { session_id, tool_name: 'Bash', tool_input: { command } }); }
function assertNeverDenies(result) { assert.equal(result.status, 0); assert.doesNotMatch(result.stdout, /permissionDecision[^\n]*deny/); }

test('warns on the fourth read-only call and resets the counter', () => { const home = fixture(); for (let i = 0; i < 3; i++) { const result = call(home); assert.equal(result.stdout, ''); assertNeverDenies(result); } const fourth = call(home); assert.match(fourth.stdout, /additionalContext/); assert.match(fourth.stdout, /まとめて/); assert.match(fourth.stdout, /Explore/); assertNeverDenies(fourth); for (let i = 0; i < 3; i++) assert.equal(call(home).stdout, ''); });
test('a writing command resets the counter', () => { const home = fixture(); for (let i = 0; i < 3; i++) call(home); assert.equal(call(home, 'echo x > f').stdout, ''); for (let i = 0; i < 3; i++) assert.equal(call(home).stdout, ''); });
test('never denies and broken stdin exits zero', () => { const home = fixture(); for (const input of [{ tool_name: 'Write', tool_input: {} }, { tool_name: 'Read', tool_input: {} }, '{broken']) assertNeverDenies(run(home, input)); });
test('isReadOnlyToolUse is conservative', () => { assert.equal(isReadOnlyToolUse('Bash', { command: 'cd /x && grep foo bar' }), true); assert.equal(isReadOnlyToolUse('Bash', { command: 'cat > f <<EOF' }), false); assert.equal(isReadOnlyToolUse('Bash', { command: 'node tools/codex-do.mjs ...' }), false); assert.equal(isReadOnlyToolUse('Read', {}), true); assert.equal(isReadOnlyToolUse('Write', {}), false); });

test('userFacingは5回調査しても警告せずカウントを保存する', t => {
  const home = fixture(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude', 'session-lane'), { recursive: true }); fs.writeFileSync(path.join(home, '.claude', 'session-lane', 's.json'), JSON.stringify({ userFacing: true }));
  for (let i = 0; i < 5; i++) assert.equal(call(home).stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', '.serial-investigation.json'))).s.count, 5);
});
test('過去ログGrepはカウントもリセットもしない', t => {
  const home = fixture(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  call(home); call(home); call(home);
  assert.equal(run(home, { session_id: 's', tool_name: 'Grep', tool_input: { path: 'C:\\Users\\x\\.claude\\projects', pattern: 'MacroDroid' } }).stdout, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', '.serial-investigation.json'))).s.count, 3);
  const result = call(home); assert.match(result.stdout, /additionalContext/); assert.doesNotMatch(result.stdout, /70%/);
});
