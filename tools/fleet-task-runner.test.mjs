import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runTask, stripExecMarkers, resolveCwd, formatReply } from './fleet-task-runner.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-task-runner-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(path.join(dir, 'fleet-inbox'), { recursive: true });
  return { home, dir };
}

function writeInbox(dir, id, body) {
  fs.writeFileSync(path.join(dir, 'fleet-inbox', `${id}.json`), JSON.stringify({ id, from: 'other-PC', to: 'kim-PC', kind: 'prompt', body, why: '実装', expiresAt: '2099-01-01T00:00:00Z' }));
}

// codex-do を起動する spawnImpl の代役。ログファイルへ出力を書き、close を発火する。
function spawnDouble(calls, { exitCode = 0, output = 'codex done' } = {}) {
  return (program, args, options) => {
    calls.push({ program, args, options });
    const child = new EventEmitter();
    child.on = EventEmitter.prototype.on.bind(child);
    queueMicrotask(() => {
      try { fs.writeSync(options.stdio[1], output); } catch { /* ignore */ }
      child.emit('close', exitCode);
    });
    return child;
  };
}

// git 呼び出しの代役。
function gitRun(status = ' M tools/x.mjs', log = 'abc123 feat: x') {
  return (program, args) => {
    if (args.includes('status')) return { status: 0, stdout: `${status}\n`, stderr: '' };
    if (args.includes('log')) return { status: 0, stdout: `${log}\n`, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('stripExecMarkers removes the exec marker and optional cwd marker', () => {
  assert.deepEqual(stripExecMarkers('<!-- fleet-exec: codex -->\n本文'), { cwd: null, body: '本文' });
  assert.deepEqual(stripExecMarkers('<!-- fleet-exec: codex -->\n<!-- fleet-exec-cwd: /repo -->\n本文'), { cwd: '/repo', body: '本文' });
  assert.deepEqual(stripExecMarkers('普通の本文'), { cwd: null, body: '普通の本文' });
});

test('resolveCwd accepts only an existing directory with .git', () => {
  // resolveCwd は path.resolve を通すので、Windows では '/file' が 'C:\file' になる。比較側も resolve する。
  const R = (p) => path.resolve(p);
  const exists = (p) => ['/repo', '/repo/.git', '/file'].map(R).includes(p);
  const stat = { isDirectory: () => true };
  const io = { exists, stat: (p) => (p === R('/file') ? { isDirectory: () => false } : stat) };
  // 存在しない → 既定へフォールバック
  assert.match(resolveCwd('/missing', { ownRepo: '/own', exists }).rejected, /存在しません/);
  // ディレクトリでない → 拒否
  assert.match(resolveCwd('/file', { ownRepo: '/own', exists: (p) => p === R('/file'), stat: io.stat }).rejected, /ディレクトリではありません/);
  // .git が無い → 拒否
  assert.match(resolveCwd('/nogit', { ownRepo: '/own', exists: (p) => p === R('/nogit'), stat: io.stat }).rejected, /\.git がありません/);
  // 採用
  assert.deepEqual(resolveCwd('/repo', { ownRepo: '/own', exists, stat: io.stat }), { cwd: path.resolve('/repo'), rejected: null });
  // 未指定 → 既定
  assert.deepEqual(resolveCwd(null, { ownRepo: '/own', exists }), { cwd: process.env.ORGIAST_REPO ?? '/own', rejected: null });
});

test('formatReply renders the fixed header, git sections and output tail', () => {
  const text = formatReply({ exitCode: 0, cwd: '/repo', minutes: 3, gitStatus: ' M x', gitLog: 'abc x', outputTail: 'tail' });
  assert.match(text, /^\[fleet-exec codex\] exit=0 cwd=\/repo 所要=3分/);
  assert.match(text, /git status:\n M x/);
  assert.match(text, /git log:\nabc x/);
  assert.match(text, /--- codex-do 出力末尾 ---\ntail$/);
});

test('runTask writes the result JSON with exit code, cwd, git info and output tail', async t => {
  const f = fixture(t); const spawns = [];
  writeInbox(f.dir, 'mail-1', '<!-- fleet-exec: codex -->\n実装して');
  const result = await runTask({ id: 'mail-1', home: f.home, ownRepo: '/own', spawnImpl: spawnDouble(spawns, { exitCode: 0, output: 'codex output' }), run: gitRun(), now: () => Date.parse('2026-09-21T00:00:00Z') });
  assert.equal(result.exitCode, 0);
  assert.equal(result.cwd, process.env.ORGIAST_REPO ?? '/own');
  assert.equal(result.gitStatus, ' M tools/x.mjs');
  assert.equal(result.gitLog, 'abc123 feat: x');
  assert.match(result.outputTail, /codex output/);
  const written = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-agent-results', 'mail-1.json'), 'utf8'));
  assert.equal(written.exitCode, 0);
  assert.ok(written.startedAt && written.finishedAt);
  // codex-do は --prompt-file / --cwd / --timeout / --kind implement / --origin unattended で起動する
  const args = spawns[0].args;
  assert.ok(args.includes('--prompt-file'));
  assert.ok(args.includes('--cwd'));
  assert.ok(args.includes('--timeout') && args[args.indexOf('--timeout') + 1] === '1800');
  assert.ok(args.includes('--kind') && args[args.indexOf('--kind') + 1] === 'implement');
  assert.ok(args.includes('--origin') && args[args.indexOf('--origin') + 1] === 'unattended');
  // マーカー除去後の本文が prompt ファイルに書かれる
  const promptFile = args[args.indexOf('--prompt-file') + 1];
  assert.equal(fs.readFileSync(promptFile, 'utf8'), '実装して');
});

test('runTask rejects a cwd without .git and records the reason', async t => {
  const f = fixture(t); const spawns = [];
  writeInbox(f.dir, 'mail-2', '<!-- fleet-exec: codex -->\n<!-- fleet-exec-cwd: /definitely/missing -->\n実装して');
  const result = await runTask({ id: 'mail-2', home: f.home, ownRepo: '/own', spawnImpl: spawnDouble(spawns), run: gitRun() });
  assert.equal(result.cwd, process.env.ORGIAST_REPO ?? '/own');
  assert.match(result.cwdRejected, /cwd 指定を拒否/);
  assert.match(result.outputTail, /cwd 指定を拒否/);
});

test('runTask writes a result JSON even when the inbox file is missing', async t => {
  const f = fixture(t);
  const result = await runTask({ id: 'mail-3', home: f.home, ownRepo: '/own', spawnImpl: () => assert.fail('inbox が無いときは起動しない'), run: gitRun() });
  assert.match(result.outputTail, /実行失敗/);
  const written = JSON.parse(fs.readFileSync(path.join(f.dir, 'fleet-agent-results', 'mail-3.json'), 'utf8'));
  assert.match(written.outputTail, /実行失敗/);
});

test('runTask records a non-zero exit code from codex-do', async t => {
  const f = fixture(t);
  writeInbox(f.dir, 'mail-4', '<!-- fleet-exec: codex -->\n実装して');
  const result = await runTask({ id: 'mail-4', home: f.home, ownRepo: '/own', spawnImpl: spawnDouble([], { exitCode: 1, output: 'boom' }), run: gitRun() });
  assert.equal(result.exitCode, 1);
  assert.match(result.outputTail, /exit=1/);
});
