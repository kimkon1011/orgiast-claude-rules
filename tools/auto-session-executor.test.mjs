import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  autoSessionExecutor,
  buildCheapCodeArgs,
  buildClaudeHeadlessArgs,
  parseAutoSessionEnvText,
  recordFallbackToClaude,
} from './auto-session-executor.mjs';

function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-ase-test-'));
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  return dir;
}

function writeAutoSessionEnv(home, text) {
  fs.writeFileSync(path.join(home, '.claude', 'auto-session.env'), text, 'utf8');
}

test('autoSessionExecutor は既定 cheap-code で、kim 機体は glm / 他機体は deepseek を選ぶ', () => {
  const home = makeHome();
  try {
    assert.deepEqual(autoSessionExecutor({}, 'kim-PC', home), { executor: 'cheap-code', provider: 'glm' });
    assert.deepEqual(autoSessionExecutor({}, 'nishi-PC', home), { executor: 'cheap-code', provider: 'deepseek' });
    assert.deepEqual(autoSessionExecutor({}, 'TEST-HOST', home), { executor: 'cheap-code', provider: 'deepseek' });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('autoSessionExecutor は ~/.claude/auto-session.env をプロセス env より優先する', () => {
  const home = makeHome();
  try {
    writeAutoSessionEnv(home, 'ORGIAST_AUTO_SESSION_EXECUTOR=claude\nORGIAST_AUTO_SESSION_PROVIDER=haiku\n');
    // ファイル指定は「この機体の固定指定」なので一時envより強い
    assert.deepEqual(
      autoSessionExecutor({ ORGIAST_AUTO_SESSION_EXECUTOR: 'cheap-code', ORGIAST_AUTO_SESSION_PROVIDER: 'glm' }, 'TEST-HOST', home),
      { executor: 'claude', provider: 'haiku' }
    );
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('parseAutoSessionEnvText は BOM・コメント・引用符・空行を処理する', () => {
  const parsed = parseAutoSessionEnvText('\uFEFF# comment\nA=1\nB="quoted value"\nC=x y\n\nD=z\n');
  assert.equal(parsed.A, '1');
  assert.equal(parsed.B, 'quoted value');
  assert.equal(parsed.C, 'x y');
  assert.equal(parsed.D, 'z');
});

test('buildCheapCodeArgs は指示を argv でなく prompt-file で渡す', () => {
  const args = buildCheapCodeArgs({ repoRoot: 'C:/repo', provider: 'glm', promptFile: 'C:/tmp/p.md', cwd: 'C:/work' });
  assert.equal(args[0], path.join('C:/repo', 'tools', 'cheap-code.mjs'));
  assert.ok(args.includes('--provider'));
  assert.ok(args.includes('glm'));
  assert.ok(args.includes('--prompt-file'));
  assert.ok(args.includes('C:/tmp/p.md'));
});

test('buildClaudeHeadlessArgs は既定 sonnet で cwd 違いのときだけ add-dir を増やす', () => {
  const previous = process.env.ORGIAST_AUTO_SESSION_MODEL;
  try {
    delete process.env.ORGIAST_AUTO_SESSION_MODEL;
    const different = buildClaudeHeadlessArgs({ repoCwd: 'C:/repo', historyCwd: 'C:/other' });
    assert.equal(different.filter((a) => a === '--add-dir').length, 2);
    const same = buildClaudeHeadlessArgs({ repoCwd: 'C:/repo', historyCwd: 'C:/repo' });
    assert.equal(same.filter((a) => a === '--add-dir').length, 1);
    assert.ok(different.includes('sonnet'));
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_AUTO_SESSION_MODEL;
    else process.env.ORGIAST_AUTO_SESSION_MODEL = previous;
  }
});

test('recordFallbackToClaude は claude-fallback の行を executor-usage.jsonl に追記する', () => {
  const home = makeHome();
  try {
    const now = new Date('2026-09-07T00:00:00Z');
    recordFallbackToClaude({ home, reason: 'cheap-code/glm exit 1', now });
    const text = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8');
    const row = JSON.parse(text.trim());
    assert.equal(row.provider, 'claude-fallback');
    assert.equal(row.status, 'fallback');
    assert.equal(row.reason, 'cheap-code/glm exit 1');
    assert.equal(row.t, '2026-09-07T00:00:00.000Z');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordFallbackToClaude は appendImpl 差し替えができ、失敗しても例外を投げない', () => {
  const written = [];
  const ret = recordFallbackToClaude({ home: makeHome(), reason: 'x', appendImpl: (file, text, enc) => { written.push([file, text, enc]); }, now: new Date('2026-09-07T00:00:00Z') });
  assert.equal(ret, undefined);
  assert.equal(written.length, 1);
  assert.match(written[0][1], /"provider":"claude-fallback"/);
  // 壊れたホームパス(親が実在ファイル)でも throw しない(無人実行の最終手段なので)
  const home = makeHome();
  const blocker = path.join(home, 'blocker.txt');
  fs.writeFileSync(blocker, 'x', 'utf8');
  assert.doesNotThrow(() => recordFallbackToClaude({ home: path.join(blocker, 'sub'), reason: 'x' }));
});
