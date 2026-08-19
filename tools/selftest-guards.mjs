#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const toolsDir = path.join(repo, 'tools');
let failed = 0;
function run(script, input, args = [], env = {}) {
  const result = spawnSync(process.execPath, [path.join(toolsDir, script), ...args], {
    input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env }, cwd: repo,
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}
function test(name, fn) {
  try { fn(); console.log(`PASS ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL ${name}: ${error.message}`); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

test('model-agent-guard: Fable5 deny', () => {
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' } });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('model-agent-guard: 実装は warn', () => {
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'ログイン機能を実装して' } });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.additionalContext, r.stdout || r.stderr);
});
test('model-agent-guard: Explore 調査は無出力', () => {
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: '設定を調査して' } });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('model-agent-guard: Write は無出力', () => {
  const r = run('model-agent-guard.mjs', { tool_name: 'Write', tool_input: {} });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('cost-routing-gate: 実装宣言', () => {
  const r = run('cost-routing-gate.mjs', { prompt: 'ログイン機能を実装して' });
  JSON.parse(r.stdout); assert(r.stdout.includes('[委譲判定]'), r.stdout || r.stderr);
});
test('cost-routing-gate: 300件は夜間バッチ', () => {
  const r = run('cost-routing-gate.mjs', { prompt: '300件の会社を分類して' });
  assert(r.stdout.includes('夜間バッチ') && r.stdout.includes('§2.8.1') && r.stdout.includes('batch-enqueue'), r.stdout || r.stderr);
});
test('cost-routing-gate: codex語で全体を無効化しない', () => {
  const r = run('cost-routing-gate.mjs', { prompt: 'Codexとか使ってやすくしてる？' });
  assert(r.stdout.includes('additionalContext') && r.stdout.includes('監督の担当'), r.stdout || r.stderr);
});
test('hook-selfcheck: 偽HOMEで欠落を自動修復', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-hook-test-'));
  const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'settings.json'), '{}\n');
  const r = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo });
  const settings = JSON.parse(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8'));
  assert(r.stdout.includes('欠落していたため自動登録'), r.stdout || r.stderr);
  assert(JSON.stringify(settings).includes('model-agent-guard.mjs') && JSON.stringify(settings).includes('cost-routing-gate.mjs'), '必須hookが登録されていない');
});
test('codex-do: dry-run に MEMORY.md を同梱', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-codex-test-'));
  const target = path.join(temp, 'target'); fs.mkdirSync(target, { recursive: true });
  const slug = target.replace(/[^a-z0-9]/gi, '-').toLowerCase();
  const memoryDir = path.join(temp, '.claude', 'projects', slug, 'memory'); fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), 'SELFTEST_MEMORY_MARKER\n');
  const r = run('codex-do.mjs', undefined, ['テスト実装', '--cwd', target, '--dry-run'], { ORGIAST_HOME: temp });
  assert(r.status === 0 && r.stdout.includes('SELFTEST_MEMORY_MARKER'), r.stdout || r.stderr);
});

if (failed) { console.log(`\n${failed} FAIL`); process.exit(1); }
console.log('\nALL PASS');
