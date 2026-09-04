import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pretooluse-bash-delegation.mjs');
function run(input, home) { return spawnSync(process.execPath, [script], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } }); }
test('long node eval warns', () => { const r = run({ tool_name: 'Bash', tool_input: { command: `node -e "${'x'.repeat(950)}"` } }); assert.equal(r.status, 0); assert.match(r.stdout, /additionalContext/); });
test('plain, short and delegated commands do not warn', () => { for (const command of ['git log --oneline', 'node -e "1+1"', `node tools/llm-ask.mjs "${'x'.repeat(950)}"`]) assert.equal(run({ tool_name: 'Bash', tool_input: { command } }).stdout, ''); });
test('block denies over 1500 chars, override disables deny', () => { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-deleg-')); fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), '{"mode":"block"}'); const input = { tool_name: 'Bash', tool_input: { command: `node -e "${'x'.repeat(1600)}"` } }; assert.match(run(input, home).stdout, /permissionDecision.*deny/); fs.writeFileSync(path.join(home, '.claude', 'cost-enforce-override'), '1'); const output = run(input, home).stdout; assert.doesNotMatch(output, /permissionDecision.*deny/); assert.match(output, /additionalContext/); });
test('mode=block で Codex クールダウン中でも Gemini があれば deny を維持する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-deleg-cooldown-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), '{"mode":"block"}');
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({ codex: { until: Date.now() + 60 * 60_000, reason: 'usage_limit', at: Date.now() } }));
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin);
  const gemini = path.join(bin, process.platform === 'win32' ? 'gemini.cmd' : 'gemini');
  fs.writeFileSync(gemini, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n'); fs.chmodSync(gemini, 0o755);
  const input = { tool_name: 'Bash', tool_input: { command: `node -e "${'x'.repeat(1600)}"` } };
  const output = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, ORGIAST_HOME: home } }).stdout;
  assert.match(output, /permissionDecision.*deny/);
  assert.match(output, /自動フォールバック/);
});
test('mode=block で Codex とフォールバックが使えなければ deny しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-deleg-no-fallback-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), '{"mode":"block"}');
  fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({ codex: { until: Date.now() + 60 * 60_000, reason: 'usage_limit_no_fallback', at: Date.now() } }));
  const input = { tool_name: 'Bash', tool_input: { command: `node -e "${'x'.repeat(1600)}"` } };
  const output = run(input, home).stdout;
  assert.doesNotMatch(output, /permissionDecision.*deny/);
  assert.match(output, /フォールバック\(Gemini 無料枠\)も利用できない/);
});
test('large spec authoring passes but large interpreter heredoc is denied in block mode', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-deleg-kinds-')); fs.mkdirSync(path.join(home, '.claude')); fs.writeFileSync(path.join(home, '.claude', 'cost-enforce.json'), '{"mode":"block"}');
  assert.equal(run({ tool_name: 'Bash', tool_input: { command: `cat > spec.md <<'SPEC_EOF'\n${'x'.repeat(1800)}\nSPEC_EOF` } }, home).stdout, '');
  assert.match(run({ tool_name: 'Bash', tool_input: { command: `python - <<'PY'\n${'x'.repeat(1800)}\nPY` } }, home).stdout, /permissionDecision.*deny/);
});
test('broken stdin exits zero', () => { const r = run('{nope'); assert.equal(r.status, 0); assert.equal(r.stdout, ''); });
