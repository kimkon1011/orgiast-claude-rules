#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnvText } from './env-kv.mjs';

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

test('parseEnvText: BOM・表記ゆれ・重複・CRLF', () => {
  const parsed = parseEnvText('\uFEFF# comment\r\n export A=v1\r\n B = "v2"\r\n   C = \'v3\' \r\nA=last\r\n');
  assert(parsed.A === 'last' && parsed.B === 'v2' && parsed.C === 'v3', JSON.stringify(parsed));
});
test('env-repair: checkは非破壊、通常実行はbackup付き修復', () => {
  const temp = makeTempHome('orgiast-env-repair-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  const file = path.join(claude, 'groq.env'); const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('GROQ_API_KEY=secret\r\n')]); fs.writeFileSync(file, original);
  const check = run('env-repair.mjs', undefined, ['--check'], { ORGIAST_HOME: temp }); assert(check.stdout.includes('BOM検出: 1件'), check.stdout || check.stderr); assert(fs.readFileSync(file).equals(original), '--checkが書き換えた');
  const repair = run('env-repair.mjs', undefined, [], { ORGIAST_HOME: temp }); const data = fs.readFileSync(file); assert(repair.stdout.includes('BOM修復: 1件') && data.toString() === 'GROQ_API_KEY=secret\r\n', repair.stdout || repair.stderr); assert(fs.readdirSync(claude).some((x) => x.endsWith('-bom')), 'backupなし');
});
test('llm-ask: BOM付きenvのキー状態を値なしで診断', () => {
  const temp = makeTempHome('orgiast-llm-key-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true }); fs.writeFileSync(path.join(claude, 'groq.env'), '\uFEFF export GROQ_API_KEY = "secret-value"\r\n');
  const r = run('llm-ask.mjs', undefined, ['--provider', 'groq', '--print-key-status'], { ORGIAST_HOME: temp, GROQ_API_KEY: '' }); assert(r.status === 0 && r.stdout.includes('設定済み') && !r.stdout.includes('secret-value'), r.stdout || r.stderr);
});
test('hook-selfcheck: BOMを修復し、正常時はBOM報告なし', () => {
  const temp = makeTempHome('orgiast-hook-bom-test-'); const claude = path.join(temp, '.claude'); fs.mkdirSync(claude, { recursive: true });
  // 必須hookを登録済みにしてBOMメッセージだけを観測する。
  const hooks = {}; for (const [event, script] of [['PreToolUse','model-agent-guard.mjs'],['UserPromptSubmit','cost-routing-gate.mjs'],['UserPromptSubmit','session-purpose-gate.mjs'],['SessionStart','hook-selfcheck.mjs']]) (hooks[event] ||= []).push({ hooks: [{ command: script }] }); fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ hooks }));
  const file = path.join(claude, 'groq.env'); fs.writeFileSync(file, '\uFEFFGROQ_API_KEY=x\n'); const first = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo }); assert(first.stdout.includes('BOM を除去しました(1件)') && !fs.readFileSync(file).subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf])), first.stdout || first.stderr);
  const second = run('hook-selfcheck.mjs', undefined, [], { ORGIAST_HOME: temp, ORGIAST_REPO: repo }); assert(!second.stdout.includes('BOM を除去'), second.stdout || second.stderr);
});

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

function makeToolAdoptionTestEnv(prefix) {
  const home = makeTempHome(prefix);
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin, { recursive: true });
  const gemini = path.join(bin, 'gemini'); fs.writeFileSync(gemini, '#!/bin/sh\necho gemini-test\n'); fs.chmodSync(gemini, 0o755);
  return { home, env: { ORGIAST_HOME: home, PATH: bin, DISCORD_COST_WEBHOOK: '' } };
}
test('tool-adoption-check: 新しい同一target stateなら導入をスキップ', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-state-test-');
  const claude = path.join(home, '.claude'); fs.mkdirSync(claude, { recursive: true });
  // 導入先は win32 だと 'wsl'、それ以外は 'native'。'native' 固定で書くと Windows で
  // 重複判定が外れて導入が走り、テストが環境依存で落ちる(実測)。
  const expectedTarget = process.platform === 'win32' ? 'wsl' : 'native';
  fs.writeFileSync(path.join(claude, 'tool-adoption-install.state'), JSON.stringify({ started: new Date().toISOString(), target: expectedTarget }));
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], { ...env, TOOL_ADOPTION_FORCE_MISSING: 'codex', TOOL_ADOPTION_FAKE_DISTRO: 'Ubuntu', TOOL_ADOPTION_INSTALL_CMD: '/bin/echo should-not-run' });
  assert(r.status === 0 && !r.stdout.includes('バックグラウンドで開始しました'), r.stdout || r.stderr);
  assert(!fs.existsSync(path.join(claude, 'tool-adoption-install.log')), '重複導入プロセスが起動された');
});
test('tool-adoption-check: detached導入は同期的にブロックしない', () => {
  const { home, env } = makeToolAdoptionTestEnv('orgiast-adoption-detached-test-');
  const adoptionEnv = { ...env, TOOL_ADOPTION_FORCE_MISSING: 'codex', TOOL_ADOPTION_FAKE_DISTRO: 'Ubuntu', TOOL_ADOPTION_INSTALL_CMD: '/bin/sleep 5' };
  const started = Date.now();
  const r = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], adoptionEnv);
  const elapsed = Date.now() - started;
  assert(r.status === 0 && r.stdout.includes('バックグラウンドで開始しました'), r.stdout || r.stderr);
  assert(elapsed < 3000, `detached起動が ${elapsed}ms ブロックした`);
  const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tool-adoption-install.state'), 'utf8'));
  assert(state.target === 'wsl' || state.target === 'native', JSON.stringify(state));
  const second = run('tool-adoption-check.mjs', undefined, ['--fix', '--dry-run'], adoptionEnv);
  assert(second.status === 0 && !second.stdout.includes('バックグラウンドで開始しました'), second.stdout || second.stderr);
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
