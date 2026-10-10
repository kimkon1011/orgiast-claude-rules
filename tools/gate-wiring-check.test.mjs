import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyze, extractRunnerGates, formatReport, normalizeGateName } from './gate-wiring-check.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const checker = path.join(toolsDir, 'gate-wiring-check.mjs');

// 実リポジトリのファイルに依存させず、一時ディレクトリに擬似ファイルを作って検証する。
function makeRepo(t, { runnerGates, manifestGates }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runner = path.join(dir, 'stop-gate-runner.mjs');
  const manifest = path.join(dir, 'gate-rollout-manifest.json');
  const body = runnerGates.map(n => `    ['${n}', () => ({ decision: 'pass' })],`).join('\n');
  fs.writeFileSync(runner, `export async function evaluateGates() {\n  const gates = [\n${body}\n  ];\n  return gates;\n}\n`);
  fs.writeFileSync(manifest, JSON.stringify({
    version: 1,
    gates: Object.fromEntries(manifestGates.map(n => [n, { rollout: 'deny', legacy: true }])),
  }, null, 2));
  return { dir, runner, manifest };
}

function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [checker, ...args], { encoding: 'utf8', ...options });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('runner にあるのにマニフェスト未登録なら exit 1 になり、そのゲート名が出る', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['alpha-gate', 'beta-gate'], manifestGates: ['alpha-gate'] });
  const { status, stdout } = runCli(['--runner', runner, '--manifest', manifest]);
  assert.equal(status, 1);
  assert.match(stdout, /beta-gate/);
  assert.doesNotMatch(stdout, /^  - alpha-gate$/m);
  // 追記すべき登録内容まで出すこと（rollout を deny 以外に書き換える変異を検出する）。
  assert.match(stdout, /"rollout": "deny"/);
});

test('すべて登録済みなら exit 0', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['alpha-gate', 'beta-gate'], manifestGates: ['alpha-gate', 'beta-gate'] });
  const { status, stdout } = runCli(['--runner', runner, '--manifest', manifest]);
  assert.equal(status, 0);
  assert.match(stdout, /すべてマニフェストに登録済み/);
});

test('control-group-gate は control-group-stop-gate に正規化され、誤検知しない', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['control-group-gate'], manifestGates: ['control-group-stop-gate'] });
  const { status, stdout } = runCli(['--runner', runner, '--manifest', manifest]);
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /未登録: \d+ 件/);
  assert.match(stdout, /control-group-gate → control-group-stop-gate/);
  assert.equal(normalizeGateName('control-group-gate'), 'control-group-stop-gate');
  assert.equal(normalizeGateName('other-gate'), 'other-gate');
});

test('マニフェストにしか無いゲートは exit 0 のまま警告として出る', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['alpha-gate'], manifestGates: ['alpha-gate', 'ghost-gate'] });
  const { status, stdout } = runCli(['--runner', runner, '--manifest', manifest]);
  assert.equal(status, 0);
  assert.match(stdout, /⚠ マニフェストにあるのに runner に無い: 1 件/);
  assert.match(stdout, /ghost-gate/);
});

test('--json で機械可読出力になる', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['alpha-gate', 'beta-gate'], manifestGates: ['alpha-gate', 'ghost-gate'] });
  const { status, stdout } = runCli(['--json', '--runner', runner, '--manifest', manifest]);
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.runnerGates, ['alpha-gate', 'beta-gate']);
  assert.deepEqual(parsed.missingFromManifest, ['beta-gate']);
  assert.deepEqual(parsed.deadInManifest, ['ghost-gate']);
});

test('環境変数でもパスを差し替えられる', t => {
  const { runner, manifest } = makeRepo(t, { runnerGates: ['alpha-gate'], manifestGates: ['alpha-gate'] });
  const env = { ...process.env, GATE_WIRING_RUNNER: runner, GATE_WIRING_MANIFEST: manifest };
  assert.equal(runCli([], { env }).status, 0);
  const bad = makeRepo(t, { runnerGates: ['alpha-gate'], manifestGates: [] });
  assert.equal(runCli([], { env: { ...process.env, GATE_WIRING_RUNNER: bad.runner, GATE_WIRING_MANIFEST: bad.manifest } }).status, 1);
});

test('runner のゲート名抽出は `const gates = [` の中だけを見る', () => {
  const source = [
    "const unrelated = ['not-a-gate', () => 1];",
    'export async function evaluateGates() {',
    '  const gates = [',
    "    ['alpha-gate', () => ({ decision: 'pass' })],",
    "    ['beta-gate', () => { return { decision: 'pass' }; }],",
    '  ];',
    "  return gates.find(([name]) => name === 'alpha-gate');",
    '}',
  ].join('\n');
  assert.deepEqual(extractRunnerGates(source), ['alpha-gate', 'beta-gate']);
  assert.throws(() => extractRunnerGates('export const x = 1;\n'), /const gates = \[/);
});

test('async 矢印関数や引数つきのエントリでも抽出できる', () => {
  const source = [
    '  const gates = [',
    "    ['async-gate', async () => ({ decision: 'pass' })],",
    "    ['arg-gate', (ctx) => ({ decision: 'pass' })],",
    '  ];',
  ].join('\n');
  assert.deepEqual(extractRunnerGates(source), ['async-gate', 'arg-gate']);
  const report = analyze({ runnerSource: source, manifest: { gates: { 'async-gate': {}, 'arg-gate': {} } } });
  assert.equal(report.ok, true);
  assert.deepEqual(report.scanWarnings, []);
});

test('要素数と抽出数が食い違ったら取りこぼしの警告を出す', () => {
  const source = [
    '  const gates = [',
    "    ['ok-gate', () => 1],",
    "    ['broken-gate', function () { return 2; }],",
    '  ];',
  ].join('\n');
  const report = analyze({ runnerSource: source, manifest: { gates: { 'ok-gate': {}, 'broken-gate': {} } } });
  assert.equal(report.scanWarnings.length, 1);
  assert.match(report.scanWarnings[0], /一致しません/);
  assert.match(formatReport({ ...report, runnerPath: 'r', manifestPath: 'm' }), /⚠ .*一致しません/);
});

test('analyze は重複したゲート名を1件に畳む', () => {
  const source = "const gates = [\n    ['dup-gate', () => 1],\n    ['dup-gate', () => 2],\n  ];";
  const report = analyze({ runnerSource: source, manifest: { gates: { 'dup-gate': {} } } });
  assert.deepEqual(report.runnerGates, ['dup-gate']);
  assert.equal(report.ok, true);
  assert.match(formatReport({ ...report, runnerPath: 'r', manifestPath: 'm' }), /runner 登録ゲート: 1 件/);
});

test('マニフェストが読めないときは exit 2 でエラーを出す', t => {
  const { runner } = makeRepo(t, { runnerGates: ['alpha-gate'], manifestGates: ['alpha-gate'] });
  const missing = path.join(path.dirname(runner), 'missing.json');
  const { status, stderr } = runCli(['--runner', runner, '--manifest', missing]);
  assert.equal(status, 2);
  assert.match(stderr, /実行できません/);
  // --json 側でも失敗を成功と報告しないこと（ok を true に書き換える変異を検出する）。
  const json = runCli(['--json', '--runner', runner, '--manifest', missing]);
  assert.equal(json.status, 2);
  assert.equal(JSON.parse(json.stderr).ok, false);
});
