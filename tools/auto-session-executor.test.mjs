import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EXECUTOR_SYNC_TTL_MS,
  autoSessionExecutor,
  buildCheapCodeArgs,
  buildCodexDoArgs,
  codexDoLaneEnabled,
  cheapProvidersAllCooling,
  buildClaudeHeadlessArgs,
  claudeFallbackEnabled,
  alternateCheapProvider,
  executorWorktreePath,
  parseAutoSessionEnvText,
  planExecutorWorktreeSync,
  prepareExecutorRoot,
  recordFallbackToClaude,
  recordSkippedNoExecutor,
} from './auto-session-executor.mjs';

test('claudeFallbackEnabled は既定無効で env またはファイルから明示的に有効化する', () => {
  const home = makeHome();
  try {
    assert.equal(claudeFallbackEnabled({}, home), false);
    assert.equal(claudeFallbackEnabled({ ORGIAST_AUTO_SESSION_CLAUDE_FALLBACK: '1' }, home), true);
    writeAutoSessionEnv(home, 'ORGIAST_AUTO_SESSION_CLAUDE_FALLBACK=On\n');
    assert.equal(claudeFallbackEnabled({}, home), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('alternateCheapProvider はキーと cooldown を確認して反対側だけを返す', () => {
  const home = makeHome();
  try {
    assert.equal(alternateCheapProvider('glm', home), null);
    fs.writeFileSync(path.join(home, '.claude', 'deepseek.env'), 'DEEPSEEK_API_KEY=ds\n');
    fs.writeFileSync(path.join(home, '.claude', 'zai.env'), 'ZAI_API_KEY=zai\n');
    assert.equal(alternateCheapProvider('glm', home), 'deepseek');
    assert.equal(alternateCheapProvider('deepseek', home), 'glm');
    fs.writeFileSync(path.join(home, '.claude', 'provider-cooldown.json'), JSON.stringify({ deepseek: { until: Date.now() + 60000 } }));
    assert.equal(alternateCheapProvider('glm', home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordSkippedNoExecutor は no-cheap-executor の行を追記する', () => {
  const home = makeHome();
  try {
    recordSkippedNoExecutor({ home, provider: 'glm', reason: 'cheap-code/glm exit 1', now: new Date('2026-09-07T00:00:00Z') });
    const row = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').trim());
    assert.equal(row.category, 'unrouted');
    assert.deepEqual({ provider: row.provider, model: row.model, status: row.status }, { provider: 'skipped', model: 'none', status: 'no-cheap-executor' });
    assert.equal(row.reason, 'cheap-code/glm exit 1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('recordSkippedNoExecutor は stderr の末尾200字を stderrTail に残し、空なら付けない', () => {
  const home = makeHome();
  try {
    recordSkippedNoExecutor({ home, provider: 'glm', reason: 'codex-do exit 1', stderr: `${'x'.repeat(300)}無人枠 8/8` });
    recordSkippedNoExecutor({ home, provider: 'glm', reason: 'codex-do exit 1', stderr: '  ' });
    const [withTail, without] = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(withTail.stderrTail.length, 200);
    assert.ok(withTail.stderrTail.endsWith('無人枠 8/8'));
    assert.equal('stderrTail' in without, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-cheap-code-test-'));
  try {
    fs.mkdirSync(path.join(repoRoot, 'tools'));
    fs.writeFileSync(path.join(repoRoot, 'tools', 'cheap-code.mjs'), '');
    const args = buildCheapCodeArgs({ repoRoot, provider: 'glm', promptFile: 'C:/tmp/p.md', cwd: 'C:/work' });
    assert.equal(args[0], path.join(repoRoot, 'tools', 'cheap-code.mjs'));
    assert.ok(args.includes('--provider'));
    assert.ok(args.includes('glm'));
    assert.ok(args.includes('--prompt-file'));
    assert.ok(args.includes('C:/tmp/p.md'));
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('buildCheapCodeArgs は cheap-code.mjs がない repoRoot を明示的に拒否する', () => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orgiast-cheap-code-missing-test-'));
  try {
    assert.throws(
      () => buildCheapCodeArgs({ repoRoot, provider: 'glm', promptFile: 'C:/tmp/p.md', cwd: 'C:/work' }),
      /cheap-code\.mjs が見つかりません/
    );
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

// 2026-10-25: PR #1091 の修正が main に入った後も、実行役を pinned tree(セッションが作業ブランチを
// 切る tree)から読んでいたため、同じ夜の後続セッションが修正前 cheap-code で走った。
// 実行役は origin/main の専用 worktree から読み、セッション開始ごとに同期する。
test('planExecutorWorktreeSync は worktree が無ければ origin/main から detached で作る', () => {
  const commands = planExecutorWorktreeSync({ repoRoot: 'C:/repo', executorRoot: 'C:/home/.claude/auto-session-executor', hasTree: false });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].cwd, 'C:/repo');
  assert.deepEqual(commands[0].args, ['worktree', 'add', '--detach', 'C:/home/.claude/auto-session-executor', 'origin/main']);
});

test('planExecutorWorktreeSync は既存 worktree を fetch→reset→clean で origin/main に合わせる', () => {
  const commands = planExecutorWorktreeSync({ repoRoot: 'C:/repo', executorRoot: 'C:/exec', hasTree: true });
  assert.deepEqual(commands.map((command) => command.label), ['fetch executor origin/main', 'reset executor', 'clean executor']);
  // fetch だけは ref を共有する repoRoot 側で行い、reset/clean は専用 worktree だけを触る。
  assert.equal(commands[0].cwd, 'C:/repo');
  assert.equal(commands[1].cwd, 'C:/exec');
  assert.deepEqual(commands[1].args, ['reset', '--hard', 'origin/main', '--quiet']);
});

test('prepareExecutorRoot は同期した専用 worktree を返し、TTL 内は再実行しない', () => {
  const calls = [];
  const state = { root: '', at: 0 };
  let created = false;
  const exists = (file) => created && String(file).endsWith(path.join('tools', 'cheap-code.mjs'));
  const run = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    if (args[0] === 'worktree') created = true;
    return { status: 0, stderr: '' };
  };
  const options = { repoRoot: 'C:/repo', home: 'C:/home', env: {}, now: 1000, exists, run, state };
  const root = prepareExecutorRoot(options);
  assert.equal(root, executorWorktreePath('C:/home'));
  assert.equal(calls.length, 1); // 初回は worktree 作成のみ
  assert.equal(prepareExecutorRoot({ ...options, now: 1000 + EXECUTOR_SYNC_TTL_MS - 1 }), root);
  assert.equal(calls.length, 1); // TTL 内はキャッシュ
  prepareExecutorRoot({ ...options, now: 1000 + EXECUTOR_SYNC_TTL_MS });
  assert.equal(calls.length, 4); // 次は fetch/reset/clean
});

test('prepareExecutorRoot は同期に失敗しても repoRoot で続行し、例外を投げない', () => {
  const logs = [];
  const root = prepareExecutorRoot({
    repoRoot: 'C:/repo', home: 'C:/home', env: {}, state: { root: '', at: 0 },
    exists: () => false,
    run: () => ({ status: 1, stderr: 'network down' }),
    log: (message) => logs.push(message),
  });
  assert.equal(root, 'C:/repo');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /network down/);
});

test('prepareExecutorRoot は ORGIAST_EXECUTOR_ROOT の明示指定を最優先する', () => {
  const root = prepareExecutorRoot({
    repoRoot: 'C:/repo', home: 'C:/home', env: { ORGIAST_EXECUTOR_ROOT: 'D:/pinned-executor' },
    state: { root: '', at: 0 }, run: () => assert.fail('明示指定では git を実行しない'),
  });
  assert.equal(root, 'D:/pinned-executor');
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
    // settings.json の permissions.defaultMode に依存せず常に明示で auto を渡す
    // (2026-09-17: 実機の settings.json に defaultMode が無く無人実行が承認待ちで停止していたため)。
    assert.equal(different[different.indexOf('--permission-mode') + 1], 'auto');
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

test('buildCodexDoArgs は prompt-file/cwd/origin を順に渡し、欠落を拒否する', () => {
  const repoRoot = makeHome();
  try {
    const options = { repoRoot, promptFile: '/tmp/prompt file.md', cwd: '/tmp/work dir' };
    assert.throws(() => buildCodexDoArgs(options), /codex-do\.mjs が見つかりません/);
    fs.mkdirSync(path.join(repoRoot, 'tools'));
    fs.writeFileSync(path.join(repoRoot, 'tools', 'codex-do.mjs'), '');
    assert.deepEqual(buildCodexDoArgs(options), [path.join(repoRoot, 'tools', 'codex-do.mjs'), '--prompt-file', options.promptFile, '--cwd', options.cwd, '--origin', 'unattended']);
  } finally { fs.rmSync(repoRoot, { recursive: true, force: true }); }
});

test('codexDoLaneEnabled は既定有効でファイル指定を env より優先する', () => {
  const home = makeHome();
  try {
    const env = { ORGIAST_HOME: home };
    assert.equal(codexDoLaneEnabled(env), true);
    for (const value of ['0', 'false', 'OFF', ' off ']) {
      assert.equal(codexDoLaneEnabled({ ...env, ORGIAST_AUTO_SESSION_CODEX_LANE: value }), false);
    }
    writeAutoSessionEnv(home, 'ORGIAST_AUTO_SESSION_CODEX_LANE=on\n');
    assert.equal(codexDoLaneEnabled({ ...env, ORGIAST_AUTO_SESSION_CODEX_LANE: '0' }), true);
    writeAutoSessionEnv(home, 'ORGIAST_AUTO_SESSION_CODEX_LANE=false\n');
    assert.equal(codexDoLaneEnabled({ ...env, ORGIAST_AUTO_SESSION_CODEX_LANE: '1' }), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('cheapProvidersAllCooling は両方の until が未来の場合だけ true を返す', () => {
  const home = makeHome();
  const file = path.join(home, '.claude', 'provider-cooldown.json');
  try {
    assert.equal(cheapProvidersAllCooling('glm', home, 1000), false);
    fs.writeFileSync(file, JSON.stringify({ glm: { until: 1001 }, deepseek: { until: 2000 } }));
    for (const provider of ['glm', 'deepseek']) assert.equal(cheapProvidersAllCooling(provider, home, 1000), true);
    assert.equal(cheapProvidersAllCooling('other', home, 1000), false);
    assert.equal(cheapProvidersAllCooling('glm', home, 1001), false);
    fs.writeFileSync(file, JSON.stringify({ glm: { until: 2000 } }));
    assert.equal(cheapProvidersAllCooling('glm', home, 1000), false);
    fs.writeFileSync(file, 'broken');
    assert.equal(cheapProvidersAllCooling('glm', home, 1000), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
