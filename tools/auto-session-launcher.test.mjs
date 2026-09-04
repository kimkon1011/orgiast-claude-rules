import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  fallbackTreePath,
  launchArgs,
  main,
  planCommands,
  planSharedRepoSyncCommands,
} from './auto-session-launcher.mjs';

const sharedRepo = '/shared/repo';
const pinnedTree = '/private/auto-session/repo';

test('共有リポジトリ自身を origin/main へ同期する4コマンドを計画する', () => {
  assert.deepEqual(planSharedRepoSyncCommands({ sharedRepo }), [
    { label: 'fetch shared repo', cwd: sharedRepo, args: ['fetch', 'origin', 'main', '--quiet'] },
    { label: 'detach shared repo', cwd: sharedRepo, args: ['checkout', '--detach', 'origin/main', '--quiet'] },
    { label: 'reset shared repo', cwd: sharedRepo, args: ['reset', '--hard', 'origin/main', '--quiet'] },
    { label: 'clean shared repo', cwd: sharedRepo, args: ['clean', '-fd', '--quiet'] },
  ]);
});

test('main は pinnedTree の準備前に共有リポジトリ同期コマンドを run へ渡す', async () => {
  const previousRepo = process.env.ORGIAST_REPO;
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_REPO = sharedRepo;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  try {
    const code = await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: () => {},
      readdir: () => [],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(calls.slice(0, 4), planSharedRepoSyncCommands({ sharedRepo }).map(({ args, cwd }) => ({
      command: 'git', args, cwd,
    })));
    assert.equal(calls[4].args[0], 'fetch');
  } finally {
    if (previousRepo === undefined) delete process.env.ORGIAST_REPO; else process.env.ORGIAST_REPO = previousRepo;
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('共有リポジトリ同期失敗は pinnedTree の localStateFailure と fallback に影響しない', async () => {
  const previousRepo = process.env.ORGIAST_REPO;
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_REPO = sharedRepo;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  const bootLogs = [];
  try {
    const code = await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      readdir: () => [],
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === 'git' && options?.cwd === sharedRepo && args[0] === 'checkout') return 1;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.some(({ args }) => args[0] === 'worktree' && args[1] === 'add'), false);
    assert.ok(calls.some(({ cwd, args }) => cwd === pinnedTree && args[0] === 'clean'));
    assert.ok(calls.some(({ command }) => command === process.execPath));
    assert.ok(bootLogs.some((message) => message.includes('detach shared repo')));
    assert.equal(bootLogs.some((message) => message.includes('stale')), false);
  } finally {
    if (previousRepo === undefined) delete process.env.ORGIAST_REPO; else process.env.ORGIAST_REPO = previousRepo;
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

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
    assert.equal(calls.length, 3);
    assert.equal(calls[2].command, process.execPath);
    assert.deepEqual(calls[2].args, launchArgs(pinnedTree, ['--dry-run']));
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

test('detach 失敗時は pinnedTree に破壊的コマンドを一切発行しない', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  try {
    await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: () => {},
      readdir: () => { throw new Error('no such directory'); },
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options?.cwd });
        if (command === 'git' && args[0] === 'fetch') return 0;
        if (command === 'git' && args.join(' ') === 'checkout --detach origin/main --quiet') return 1;
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') return 1;
        return 0;
      },
    });
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
  const pinnedTreeCalls = calls.filter((call) => call.cwd === pinnedTree);
  // detach（失敗した checkout --detach 自体）だけが試行され、reset/clean/stash は一切発行されない。
  assert.deepEqual(pinnedTreeCalls.map((call) => call.args[0]), ['checkout']);
  assert.equal(
    calls.some((call) => call.cwd === pinnedTree && ['reset', 'clean', 'stash'].includes(call.args[0])),
    false,
  );
});

test('detach 失敗時は使い捨て fallback tree を作ってそこから起動する', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const fixedNow = new Date(2026, 8, 3, 0, 30, 1);
  const fallbackTree = fallbackTreePath(pinnedTree, fixedNow);
  const calls = [];
  const bootLogs = [];
  try {
    const code = await main(['--count', 'all'], {
      now: () => fixedNow,
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0] || candidate === launchArgs(fallbackTree, [])[0],
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      readdir: () => { throw new Error('no such directory'); },
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'git' && args[0] === 'fetch') return 0;
        if (command === 'git' && args.join(' ') === 'checkout --detach origin/main --quiet') return 1;
        if (command === 'git' && args.join(' ') === `worktree add --detach ${fallbackTree} origin/main`) return 0;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.ok(calls.some((call) => call.command === 'git'
      && call.args.join(' ') === `worktree add --detach ${fallbackTree} origin/main`));
    const launchCall = calls.find((call) => call.command === process.execPath);
    assert.deepEqual(launchCall.args, launchArgs(fallbackTree, ['--count', 'all']));
    assert.ok(bootLogs.some((message) => message.includes(`launched from ${fallbackTree}`)));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('fetch のみ失敗した場合は fallback tree を作らず既存 tree からそのまま起動する', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const calls = [];
  const bootLogs = [];
  try {
    const code = await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      readdir: () => { throw new Error('no such directory'); },
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'git' && args[0] === 'fetch') return 1;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls.some((call) => call.command === 'git' && call.args[0] === 'worktree'), false);
    const launchCall = calls.find((call) => call.command === process.execPath);
    assert.deepEqual(launchCall.args, launchArgs(pinnedTree, []));
    assert.ok(bootLogs.some((message) => message.includes('警告は非致命')));
    assert.ok(bootLogs.some((message) => message.includes(`launched from ${pinnedTree}`)));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('fallback tree の作成にも失敗したら stale マーカーを残して既存 tree から起動する', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const bootLogs = [];
  try {
    const code = await main([], {
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: (message) => bootLogs.push(message),
      readdir: () => { throw new Error('no such directory'); },
      run: async (command, args) => {
        if (command === 'git' && args[0] === 'fetch') return 0;
        if (command === 'git' && args.join(' ') === 'checkout --detach origin/main --quiet') return 1;
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'add') return 1;
        return 0;
      },
    });
    assert.equal(code, 0);
    assert.ok(bootLogs.some((message) => message.includes('stale')));
    assert.ok(bootLogs.some((message) => message.includes(`launched from ${pinnedTree}`)));
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});

test('3日より古い fallback tree だけ削除し、掃除が失敗しても起動まで到達する', async () => {
  const previousTree = process.env.ORGIAST_AUTO_SESSION_TREE;
  process.env.ORGIAST_AUTO_SESSION_TREE = pinnedTree;
  const fixedNow = new Date(2026, 8, 3, 0, 30, 1);
  const oldFallback = fallbackTreePath(pinnedTree, new Date(2026, 7, 25, 0, 0, 0));
  const recentFallback = fallbackTreePath(pinnedTree, new Date(2026, 8, 2, 12, 0, 0));
  const dir = path.dirname(pinnedTree);
  const calls = [];
  try {
    const code = await main([], {
      now: () => fixedNow,
      exists: (candidate) => candidate === launchArgs(pinnedTree, [])[0],
      log: () => {},
      bootLog: () => {},
      readdir: (target) => (target === dir
        ? [path.basename(oldFallback), path.basename(recentFallback), 'unrelated-dir']
        : []),
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === 'git' && args[0] === 'fetch') return 0;
        if (command === 'git' && args[0] === 'worktree' && args[1] === 'remove') return 1;
        return 0;
      },
    });
    assert.equal(code, 0);
    // 実装は path.join(dir, entry) でパスを組み立てる（OS のセパレータに正規化される）ため、
    // 期待値も同じ組み立て方で比較する。
    const expectedRemovedPath = path.join(dir, path.basename(oldFallback));
    assert.ok(calls.some((call) => call.command === 'git'
      && call.args.join(' ') === `worktree remove --force ${expectedRemovedPath}`));
    assert.equal(
      calls.some((call) => call.command === 'git' && call.args.some((arg) => arg.includes(path.basename(recentFallback)))),
      false,
    );
  } finally {
    if (previousTree === undefined) delete process.env.ORGIAST_AUTO_SESSION_TREE; else process.env.ORGIAST_AUTO_SESSION_TREE = previousTree;
  }
});
