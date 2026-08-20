import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkVersionDrift, formatDriftLine, gitBlobSha } from './version-drift.mjs';

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'version-drift-'));
  fs.mkdirSync(path.join(repo, 'tools'));
  const content = Buffer.from('hello\n');
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), content);
  const tree = { sha: 'root', tree: [{ path: 'tools/a.mjs', mode: '100644', type: 'blob', sha: gitBlobSha(content) }] };
  return { repo, tree };
}

test('一致する内容は ok', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const result = await checkVersionDrift({ repo, tree, statusPaths: [] });
  assert.equal(result.status, 'ok'); assert.deepEqual(result.drifted, []);
});

test('git status にない不一致は旧版 drift', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), 'changed\n');
  const result = await checkVersionDrift({ repo, tree, statusPaths: [] });
  assert.equal(result.status, 'drift'); assert.deepEqual(result.drifted, [{ path: 'tools/a.mjs', reason: '旧版' }]);
});

test('git status にある不一致は wip', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), 'changed\n');
  const result = await checkVersionDrift({ repo, tree, statusPaths: new Set(['tools/a.mjs']) });
  assert.equal(result.status, 'wip'); assert.deepEqual(result.drifted, []); assert.deepEqual(result.wip, ['tools/a.mjs']);
});

test('欠落ファイルは drift', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.unlinkSync(path.join(repo, 'tools', 'a.mjs'));
  const result = await checkVersionDrift({ repo, tree, statusPaths: [] });
  assert.equal(result.status, 'drift'); assert.equal(result.drifted[0].reason, '欠落');
});

test('API失敗かつキャッシュ無しは unknown', async (t) => {
  const { repo } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'missing-cache.json');
  const result = await checkVersionDrift({ repo, cacheFile, fetchTree: async () => { throw new Error('offline'); } });
  assert.equal(result.status, 'unknown'); assert.match(formatDriftLine(result), /照合できず/);
});

test('formatDriftLine は4分岐のアイコンを返す', () => {
  assert.match(formatDriftLine({ status: 'drift', drifted: [{ path: 'tools/a.mjs', reason: '旧版' }] }), /^🚨/);
  assert.match(formatDriftLine({ status: 'wip', wip: ['tools/a.mjs'] }), /^⚠️/);
  assert.match(formatDriftLine({ status: 'ok', checked: 1 }), /^✅/);
  assert.match(formatDriftLine({ status: "unknown" }), /^⚠️.*照合できず/);
});

test('blob SHA は git 互換の既知値', () => {
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('index 無しでも CRLF の作業ツリーを LF と比較できる', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), 'hello\r\n');
  const result = await checkVersionDrift({ repo, tree, statusPaths: [], indexShas: new Map() });
  assert.equal(result.status, 'ok'); assert.equal(result.method, 'content');
});

test('index が上流と一致すれば作業ツリーが異なっても ok', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), 'changed\n');
  const indexShas = new Map([['tools/a.mjs', tree.tree[0].sha]]);
  const result = await checkVersionDrift({ repo, tree, statusPaths: ['tools/a.mjs'], indexShas });
  assert.equal(result.status, 'ok'); assert.equal(result.method, 'index');
});

test('index が上流と不一致で status にあれば wip', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const indexShas = new Map([['tools/a.mjs', gitBlobSha('changed\n')]]);
  const result = await checkVersionDrift({ repo, tree, statusPaths: ['tools/a.mjs'], indexShas });
  assert.equal(result.status, 'wip'); assert.deepEqual(result.wip, ['tools/a.mjs']);
});

test('index が上流と不一致で status になければ旧版 drift', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const indexShas = new Map([['tools/a.mjs', gitBlobSha('changed\n')]]);
  const result = await checkVersionDrift({ repo, tree, statusPaths: [], indexShas });
  assert.equal(result.status, 'drift'); assert.deepEqual(result.drifted, [{ path: 'tools/a.mjs', reason: '旧版' }]);
});

test('ヌルバイト入りの不一致は LF 正規化しない', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  tree.tree[0].sha = gitBlobSha(Buffer.from([0x61, 0x0a, 0x00]));
  fs.writeFileSync(path.join(repo, 'tools', 'a.mjs'), Buffer.from([0x61, 0x0d, 0x0a, 0x00]));
  const result = await checkVersionDrift({ repo, tree, statusPaths: [], indexShas: new Map() });
  assert.equal(result.status, 'drift');
});

test('VERSION_DRIFT_SKIP=1 は照合せず、行も出さない', async () => {
  process.env.VERSION_DRIFT_SKIP = '1';
  try {
    const result = await checkVersionDrift({ fetchTree: async () => { throw new Error('叩いてはいけない'); } });
    assert.equal(result.status, 'skipped');
    assert.equal(formatDriftLine(result), '');
  } finally { delete process.env.VERSION_DRIFT_SKIP; }
});

test('headSha が一致するキャッシュは fetchTree を呼ばず使う', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ headSha: 'abc123', tree }));
  const result = await checkVersionDrift({ repo, cacheFile, statusPaths: [], lsRemote: async () => 'abc123\trefs/heads/main', fetchTree: async () => { throw new Error('呼んではいけない'); } });
  assert.equal(result.status, 'ok'); assert.equal(result.headSha, 'abc123');
});

test('headSha が不一致なら TTL 内でも新しいツリーを取得する', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'cache.json');
  const oldTree = { ...tree, tree: [{ ...tree.tree[0], sha: gitBlobSha('old\n') }] };
  fs.writeFileSync(cacheFile, JSON.stringify({ headSha: 'old', tree: oldTree }));
  let fetched = 0;
  const result = await checkVersionDrift({ repo, cacheFile, statusPaths: [], lsRemote: async () => 'new\trefs/heads/main', fetchTree: async () => { fetched += 1; return tree; } });
  assert.equal(fetched, 1); assert.equal(result.status, 'ok'); assert.equal(result.headSha, 'new');
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { headSha: 'new', tree });
});

test('旧形式キャッシュは無視して再取得する', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify(tree));
  let fetched = 0;
  const result = await checkVersionDrift({ repo, cacheFile, statusPaths: [], lsRemote: async () => 'new\trefs/heads/main', fetchTree: async () => { fetched += 1; return tree; } });
  assert.equal(fetched, 1); assert.equal(result.status, 'ok');
});

test('lsRemote が空なら TTL 内のキャッシュを使う', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ headSha: 'cached', tree }));
  const result = await checkVersionDrift({ repo, cacheFile, statusPaths: [], lsRemote: async () => '', fetchTree: async () => { throw new Error('呼んではいけない'); } });
  assert.equal(result.status, 'ok'); assert.equal(result.headSha, 'cached');
});

test('lsRemote のタイムアウトは 8000ms', async (t) => {
  const { repo, tree } = fixture(); t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const cacheFile = path.join(repo, 'cache.json');
  let receivedTimeout;
  await checkVersionDrift({ repo, cacheFile, statusPaths: [], lsRemote: async (timeoutMs) => { receivedTimeout = timeoutMs; return ''; }, fetchTree: async () => tree });
  assert.equal(receivedTimeout, 8000);
});
