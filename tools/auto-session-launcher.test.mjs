import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { launchArgs, main, planCommands } from './auto-session-launcher.mjs';

const sharedRepo = '/shared/repo';
const pinnedTree = '/private/auto-session/repo';

test('共有リポジトリに対して fetch 以外の更新操作を計画しない', () => {
  const commands = planCommands({ sharedRepo, pinnedTree, treeExists: true });
  const sharedCommands = commands.filter(({ cwd }) => cwd === sharedRepo);
  assert.deepEqual(sharedCommands.map(({ args }) => args), [['fetch', 'origin', 'main', '--quiet']]);
  assert.equal(sharedCommands.some(({ args }) => args.some((arg) => ['checkout', 'pull', 'reset', 'clean'].includes(arg))), false);
});

test('専用 tree がない場合は detached worktree を追加する', () => {
  const commands = planCommands({ sharedRepo, pinnedTree, treeExists: false });
  const add = commands.find(({ args }) => args[0] === 'worktree');
  assert.deepEqual(add, {
    label: 'create pinned worktree',
    cwd: sharedRepo,
    args: ['worktree', 'add', '--detach', pinnedTree, 'origin/main'],
  });
});

test('既存の専用 tree は origin/main へ reset して残骸を clean する', () => {
  const commands = planCommands({ sharedRepo, pinnedTree, treeExists: true });
  const order = commands.filter(({ cwd }) => cwd === pinnedTree).map(({ args }) => args[0]);
  // reset がブランチ ref を巻き込まないよう、必ず detach が先に来る。
  assert.deepEqual(order, ['checkout', 'reset', 'clean']);
  assert.ok(commands.some((command) => command.cwd === pinnedTree
    && command.args.join(' ') === 'checkout --detach origin/main --quiet'));
  assert.ok(commands.some((command) => command.cwd === pinnedTree
    && command.args.join(' ') === 'reset --hard origin/main --quiet'));
  assert.ok(commands.some((command) => command.cwd === pinnedTree
    && command.args.join(' ') === 'clean -fd --quiet'));
});

test('launchArgs は専用 tree の auto-session に元の引数を透過する', () => {
  assert.deepEqual(
    launchArgs(pinnedTree, ['--dry-run', '値']),
    [path.join(pinnedTree, 'tools', 'auto-session.mjs'), '--dry-run', '値'],
  );
});

test('fetch 失敗でも既存の専用 tree があれば子を起動する', async () => {
  const previousRepo = process.env.ORGIAST_REPO;
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_REPO = sharedRepo;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  const logs = [];
  const bootLogs = [];
  try {
    const code = await main(['--dry-run'], {
      // 用意できているかは worktree ディレクトリではなく起動対象ファイルで判定される。
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: (message) => logs.push(message),
      bootLog: (message) => bootLogs.push(message),
      run: async (command, args, options) => {
        calls.push({ command, args, options });
        return command === 'git' ? 1 : 23;
      },
    });
    assert.equal(code, 23);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, process.execPath);
    assert.deepEqual(calls[1].args, launchArgs(pinnedTree, ['--dry-run']));
    assert.ok(logs.some((message) => message.includes('警告')));
    assert.ok(bootLogs.some((message) => message.includes('警告は非致命')));
  } finally {
    if (previousRepo === undefined) delete process.env.ORGIAST_REPO; else process.env.ORGIAST_REPO = previousRepo;
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('準備コマンド失敗時は stderr の末尾を警告に残す', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const logs = [];
  const bootLogs = [];
  try {
    await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: (message) => logs.push(message),
      bootLog: (message) => bootLogs.push(message),
      run: async (command) => command === 'git'
        ? { code: 1, stderrTail: '致命的なエラーの本文' }
        : 0,
    });
    assert.ok(logs.some((message) => message.includes('stderr: 致命的なエラーの本文')));
    assert.ok(bootLogs.some((message) => message.includes('stderr: 致命的なエラーの本文')));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('最終起動失敗時は stderr の末尾を boot log に残す', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const bootLogs = [];
  try {
    const code = await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      run: async (command) => command === 'git'
        ? 0
        : { code: 1, stderrTail: '本体の致命的なエラー' },
    });
    assert.equal(code, 1);
    assert.ok(bootLogs.some((message) => message.includes('stderr: 本体の致命的なエラー')));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('専用 tree を用意できない場合だけ 1 を返して子を起動しない', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  const bootLogs = [];
  try {
    const code = await main([], {
      exists: () => false,
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      run: async (command, args) => {
        calls.push({ command, args });
        return args[0] === 'fetch' ? 0 : 1;
      },
    });
    assert.equal(code, 1);
    assert.equal(calls.every(({ command }) => command === 'git'), true);
    assert.ok(bootLogs.some((message) => message.includes('abort')));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});
