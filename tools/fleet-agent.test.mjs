import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { collectStatus, main, processDirective, targetMatches } from './fleet-agent.mjs';

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-agent-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

function response(directives) {
  return { ok: true, json: async () => ({ version: 1, directives }) };
}

test('オプトイン無しの prompt は claude を起動せず通知も同じ id で1回だけ', async () => {
  const home = tempHome();
  const oldHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  const posts = [];
  let spawned = 0;
  const directive = { id: 'p-1', kind: 'prompt', targets: 'all', why: '確認', body: '秘密ではない本文', createdBy: 'kim' };
  try {
    const dependencies = { fetch: async () => response([directive]), post: async (message) => posts.push(message), spawnImpl: () => { spawned += 1; throw new Error('must not spawn'); } };
    await main(['--once'], dependencies);
    await main(['--once'], dependencies);
  } finally {
    if (oldHome === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = oldHome;
  }
  assert.equal(spawned, 0);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /未オプトイン/);
  assert.match(posts[0], /承諾するにはこの1コマンド/);
});

test('未許可 kind は実行せず警告する', async () => {
  const home = tempHome();
  const posts = [];
  const result = await processDirective({ id: 'bad-1', kind: 'shell', targets: 'all' }, { home, repo: process.cwd(), label: 'PC', hostname: 'host', dryRun: false, post: async (message) => posts.push(message) });
  assert.equal(result.action, 'denied');
  assert.match(posts[0], /未許可 kind『shell』/);
});

test('targets は label / hostname の部分一致で、対象外をスキップする', () => {
  assert.equal(targetMatches('開発', 'kim開発機', 'DESKTOP-1'), true);
  assert.equal(targetMatches('TOP-1', '別PC', 'DESKTOP-123'), true);
  assert.equal(targetMatches('営業', 'kim開発機', 'DESKTOP-1'), false);
  assert.equal(targetMatches('', 'x', 'y'), true);
});

test('expiresAt 超過は実行しない', async () => {
  let posted = false;
  const result = await processDirective({ id: 'old', kind: 'status', targets: 'all', expiresAt: '2000-01-01T00:00:00Z' }, { home: tempHome(), repo: process.cwd(), label: 'PC', hostname: 'host', dryRun: false, post: async () => { posted = true; } });
  assert.equal(result.action, 'expired');
  assert.equal(posted, false);
});

test('status は webhook URL と API key を伏せる', () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'hooks', 'onboarding-sync.log'), 'done https://discord.com/api/webhooks/123/SECRET API_KEY=topsecret\n');
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'person@example.com' } }));
  const run = (_program, args) => {
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (args.includes('--count')) return { status: 0, stdout: '2\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const status = collectStatus({ home, repo: process.cwd(), label: 'PC', hostname: 'host', run, platform: 'linux' });
  assert.doesNotMatch(status.text, /SECRET|topsecret|discord\.com\/api\/webhooks/);
  assert.match(status.text, /\[REDACTED\]/);
});

function statusWithPowerShell(stdout, status = 0, stderr = '') {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const run = (program, args) => {
    if (program === 'powershell') return { status, stdout, stderr };
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (args.includes('--count')) return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return collectStatus({ home, repo: process.cwd(), label: 'kim-PC', hostname: 'DESKTOP-2D0R4LI', run, platform: 'win32' });
}

test('status は成功タスク名を出さず確認件数を表示する', () => {
  const result = statusWithPowerShell(JSON.stringify([{ name: 'ClaudeSuccess', result: 0, last: '2026-09-02' }]));
  assert.match(result.text, /夜間ジョブ=失敗なし\(1件確認\)/);
  assert.doesNotMatch(result.text, /ClaudeSuccess/);
});

test('status は失敗したタスクだけを表示する', () => {
  const result = statusWithPowerShell(JSON.stringify([
    { name: 'ClaudeFailed', result: 1, last: '2026-09-02' },
    { name: 'ClaudeSuccess', result: 0, last: '2026-09-02' },
  ]));
  assert.match(result.text, /ClaudeFailed\(result=1\)/);
  assert.doesNotMatch(result.text, /ClaudeSuccess/);
});

test('status は実行中と未実行を失敗に数えない', () => {
  const result = statusWithPowerShell(JSON.stringify([
    { name: 'ClaudeRunning', result: 267009 },
    { name: 'ClaudeNeverRun', result: 267011 },
  ]));
  assert.match(result.text, /夜間ジョブ=失敗なし\(2件確認\)/);
  assert.doesNotMatch(result.text, /ClaudeRunning|ClaudeNeverRun/);
});

test('status は PowerShell の非0終了と壊れたJSONを明示し他項目も残す', () => {
  for (const result of [statusWithPowerShell('', 1, 'PowerShell unavailable'), statusWithPowerShell('{broken')]) {
    assert.match(result.text, /夜間ジョブ=取得できませんでした/);
    assert.match(result.text, /hostname=DESKTOP-2D0R4LI/);
    assert.match(result.text, /repo=main/);
    assert.match(result.text, /残TODO=/);
  }
});

test('status は大量の失敗を行単位で省略して1800字以内にする', () => {
  const tasks = Array.from({ length: 200 }, (_, index) => ({ name: `ClaudeFailure${String(index).padStart(3, '0')}`, result: 1 }));
  const result = statusWithPowerShell(JSON.stringify(tasks));
  assert.ok(result.text.length <= 1800, `length=${result.text.length}`);
  assert.match(result.text, /…\(他\d+件を省略\)/);
  assert.match(result.text, /hostname=DESKTOP-2D0R4LI/);
  assert.match(result.text, /account=kim@orgiast\.jp/);
  assert.ok(result.text.split('\n').every((line) => !line.endsWith('ClaudeFail')));
});

test('status は ConvertTo-Json の単一オブジェクトも扱う', () => {
  const result = statusWithPowerShell(JSON.stringify({ name: 'ClaudeOnlyFailure', result: 1, last: '2026-09-02' }));
  assert.match(result.text, /ClaudeOnlyFailure\(result=1\)/);
});

function memoryHome({ shared, indexed } = {}) {
  const home = tempHome();
  const memoryDir = path.join(home, '.claude', 'projects', 'proj1', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), indexed
    ? '# MEMORY\n\n## ドメイン索引\n- [他PCからの共有知見](index/shared.md)\n'
    : '# MEMORY\n\n## ドメイン索引\n- [別の索引](index/other.md)\n');
  if (shared && shared.length) {
    const sharedDir = path.join(memoryDir, 'shared');
    fs.mkdirSync(sharedDir, { recursive: true });
    for (const name of shared) fs.writeFileSync(path.join(sharedDir, name), `# ${name}\n`);
  }
  return home;
}

function statusForHome(home) {
  const run = (_program, args) => {
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (args.includes('--count')) return { status: 0, stdout: '0\n', stderr: '' };
    return { status: 0, stdout: '[]', stderr: '' };
  };
  return collectStatus({ home, repo: process.cwd(), label: 'PC', hostname: 'host', run, platform: 'linux' });
}

test('status は共有memoryの件数とMEMORY.md参照有無を表示する(届いている)', () => {
  const home = memoryHome({ shared: ['a.md', 'b.md', 'c.md'], indexed: true });
  const result = statusForHome(home);
  assert.match(result.text, /memory=共有3件 \/ MEMORY\.md参照=yes/);
  assert.deepEqual(result.data.sharedMemory, { found: true, count: 3, indexed: true });
});

test('status は共有memoryが未着地・未参照だと0件/noを表示する(届いていない)', () => {
  const home = memoryHome({ indexed: false });
  const result = statusForHome(home);
  assert.match(result.text, /memory=共有0件 \/ MEMORY\.md参照=no/);
  assert.deepEqual(result.data.sharedMemory, { found: true, count: 0, indexed: false });
});

test('status はmemoryディレクトリ自体が無いと memory=なし を表示する', () => {
  const home = tempHome();
  const result = statusForHome(home);
  assert.match(result.text, /memory=なし/);
  assert.deepEqual(result.data.sharedMemory, { found: false, count: 0, indexed: false });
});

test('status はmemory行を追加しても大量の夜間ジョブ失敗込みで1800字以内に収まる(予算回帰)', () => {
  const home = memoryHome({ shared: Array.from({ length: 250 }, (_, index) => `shared-${index}.md`), indexed: true });
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const tasks = Array.from({ length: 200 }, (_, index) => ({ name: `ClaudeFailure${String(index).padStart(3, '0')}`, result: 1 }));
  const run = (program, args) => {
    if (program === 'powershell') return { status: 0, stdout: JSON.stringify(tasks), stderr: '' };
    if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n', stderr: '' };
    if (args.includes('--count')) return { status: 0, stdout: '1\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = collectStatus({ home, repo: process.cwd(), label: 'kim-PC', hostname: 'DESKTOP-2D0R4LI', run, platform: 'win32' });
  assert.ok(result.text.length <= 1800, `length=${result.text.length}`);
  assert.match(result.text, /memory=共有250件 \/ MEMORY\.md参照=yes/);
  assert.match(result.text, /…\(他\d+件を省略\)/);
});

test('ネットワーク不通は例外にせず空結果で終了する', async () => {
  const oldHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = tempHome();
  try {
    assert.deepEqual(await main(['--once'], { fetch: async () => { throw new Error('offline'); } }), []);
  } finally {
    if (oldHome === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = oldHome;
  }
});

test('--dry-run は処理済み id を消費しない', async () => {
  const home = tempHome();
  const oldHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  const directive = { id: 'dry-1', kind: 'prompt', targets: 'all', why: '確認', body: '本文', createdBy: 'kim' };
  try {
    await main(['--once', '--dry-run'], { fetch: async () => response([directive]), post: async () => { throw new Error('POST must not run'); } });
  } finally {
    if (oldHome === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = oldHome;
  }
  assert.equal(fs.existsSync(path.join(home, '.claude', '.fleet-agent-processed')), false);
});

test('opt-in prompt は argv 配列・shell false・stdin EOF で起動する', async () => {
  const home = tempHome();
  fs.writeFileSync(path.join(home, '.claude', 'fleet-agent-optin.json'), '{"accept":["prompt"]}');
  let invocation;
  const spawnImpl = (exe, args, options) => {
    invocation = { exe, args, options, ended: false };
    const child = new EventEmitter();
    child.stdin = { end: () => { invocation.ended = true; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit('data', 'done'); child.emit('close', 0); });
    return child;
  };
  const posts = [];
  const result = await processDirective({ id: 'p-ok', kind: 'prompt', targets: 'all', why: 'test', body: '`literal`' }, { home, repo: process.cwd(), label: 'PC', hostname: 'host', dryRun: false, post: async (message) => posts.push(message), spawnImpl });
  assert.equal(result.action, 'prompt');
  assert.deepEqual(invocation.args, ['-p', '`literal`']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.ended, true);
  assert.match(posts[0], /exit=0/);
});
