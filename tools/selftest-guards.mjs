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
function makeTempHome(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function writeCostEnforce(home, mode) {
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'cost-enforce.json'), JSON.stringify({ mode }));
}

test('model-agent-guard: Fable5 deny', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-deny-test-'));
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('Fable5明示指定: allow作成後は同一セッションで許可', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-allow-test-'));
  const sessionId = 'selftest-fable-session';
  const gate = run('cost-routing-gate.mjs', { prompt: 'Fable5で要約して', session_id: sessionId }, [], { ORGIAST_HOME: temp });
  const allowPath = path.join(temp, '.claude', 'fable-allow.json');
  assert(fs.existsSync(allowPath), gate.stdout || gate.stderr || 'allowファイルが作成されない');
  const allow = JSON.parse(fs.readFileSync(allowPath, 'utf8'));
  assert(allow.sessionId === sessionId && Date.parse(allow.until) > Date.now(), JSON.stringify(allow));
  const guard = run('model-agent-guard.mjs', { session_id: sessionId, tool_name: 'Agent', tool_input: { model: 'fable', prompt: '要約して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(guard.stdout);
  assert(output.hookSpecificOutput.permissionDecision !== 'deny' && output.hookSpecificOutput.additionalContext.includes('§1.16例外'), guard.stdout || guard.stderr);
});
test('Fable5例外: 期限切れallowはdeny', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-expired-test-'));
  const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'fable-allow.json'), JSON.stringify({ until: new Date(Date.now() - 1000).toISOString(), sessionId: 'expired' }));
  const r = run('model-agent-guard.mjs', { session_id: 'expired', tool_name: 'Agent', tool_input: { model: 'fable', prompt: 'x' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout); assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('Fable5否定指定: allowを作成しない', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-fable-negative-test-'));
  const r = run('cost-routing-gate.mjs', { prompt: 'Fable5は使うな', session_id: 'negative' }, [], { ORGIAST_HOME: temp });
  assert(!fs.existsSync(path.join(temp, '.claude', 'fable-allow.json')), r.stdout || r.stderr);
});
test('model-agent-guard: 実装は warn', () => {
  const temp = makeTempHome('orgiast-model-agent-warn-test-');
  writeCostEnforce(temp, 'warn');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'ログイン機能を実装して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout);
  assert(output.hookSpecificOutput.additionalContext && !output.hookSpecificOutput.permissionDecision, r.stdout || r.stderr);
});
test('model-agent-guard: block昇格時は実装委譲を deny', () => {
  const temp = makeTempHome('orgiast-model-agent-block-test-');
  writeCostEnforce(temp, 'block');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { model: 'sonnet', prompt: 'ログイン機能を実装して' } }, [], { ORGIAST_HOME: temp });
  const output = JSON.parse(r.stdout);
  assert(output.hookSpecificOutput.permissionDecision === 'deny', r.stdout || r.stderr);
});
test('model-agent-guard: Explore 調査は無出力', () => {
  const temp = makeTempHome('orgiast-model-agent-explore-test-');
  const r = run('model-agent-guard.mjs', { tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: '設定を調査して' } }, [], { ORGIAST_HOME: temp });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('model-agent-guard: Write は無出力', () => {
  const temp = makeTempHome('orgiast-model-agent-write-test-');
  const r = run('model-agent-guard.mjs', { tool_name: 'Write', tool_input: {} }, [], { ORGIAST_HOME: temp });
  assert(r.stdout === '', `stdout=${r.stdout}`);
});
test('cost-routing-gate: 実装宣言', () => {
  const temp = makeTempHome('orgiast-routing-implementation-test-');
  const r = run('cost-routing-gate.mjs', { prompt: 'ログイン機能を実装して' }, [], { ORGIAST_HOME: temp });
  JSON.parse(r.stdout); assert(r.stdout.includes('[委譲判定]'), r.stdout || r.stderr);
});
test('cost-routing-gate: 300件は夜間バッチ', () => {
  const temp = makeTempHome('orgiast-routing-batch-test-');
  const r = run('cost-routing-gate.mjs', { prompt: '300件の会社を分類して' }, [], { ORGIAST_HOME: temp });
  assert(r.stdout.includes('夜間バッチ') && r.stdout.includes('§2.8.1') && r.stdout.includes('batch-enqueue'), r.stdout || r.stderr);
});
test('cost-routing-gate: codex語で全体を無効化しない', () => {
  const temp = makeTempHome('orgiast-routing-codex-test-');
  const r = run('cost-routing-gate.mjs', { prompt: 'Codexとか使ってやすくしてる？' }, [], { ORGIAST_HOME: temp });
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
test('codex-do: --cwd 省略でも指示文が消えない', () => {
  const temp = makeTempHome('orgiast-codex-args-test-');
  const r = run('codex-do.mjs', undefined, ['ログイン機能を実装して', '--dry-run'], { ORGIAST_HOME: temp });
  assert(r.status !== 2 && !/使い方:/.test(r.stderr || ''), '第1引数が捨てられている');
  assert(/ログイン機能を実装して/.test(r.stdout || ''), '指示文がプロンプトに含まれない');
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
