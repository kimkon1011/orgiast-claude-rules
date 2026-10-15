import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishMemories } from './memory-publish.mjs';

const require = createRequire(import.meta.url);

function fixture({ withMemoryIndex = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-publish-'));
  const home = path.join(root, 'home');
  const keyserveRepo = path.join(root, 'keyserve');
  const memoryDir = path.join(home, '.claude', 'projects', 'project-a', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.mkdirSync(keyserveRepo, { recursive: true });
  if (withMemoryIndex) fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# MEMORY\n');
  return { root, home, keyserveRepo, memoryDir };
}

function feedback(body) {
  return `---\nname: sample\ndescription: test\nmetadata:\n  type: feedback\n---\n\n${body}`;
}

function loadGenerated(keyserveRepo) {
  const generated = path.join(keyserveRepo, 'api', '_memory-bundle.generated.js');
  delete require.cache[require.resolve(generated)];
  return { generated, bundle: require(generated) };
}

test('CommonJSモジュールを生成し特殊文字を壊さず往復する', async () => {
  const f = fixture();
  const body = 'バッククォート ` と ${value}\n改行\\バックスラッシュ\n</script>\n';
  const contents = feedback(body);
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_special.md'), contents);

  const result = await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, now: new Date('2026-09-02T13:00:00.000Z'), emit: async () => {} });
  const { generated, bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(result.files, 2);
  assert.equal(result.bytes, fs.statSync(generated).size);
  assert.equal(bundle.version, 2);
  assert.ok(bundle.source.pc);
  assert.equal(bundle.source.account, '');
  assert.equal(bundle.generatedAt, '2026-09-02T13:00:00.000Z');
  assert.equal(Number.isNaN(Date.parse(bundle.generatedAt)), false);
  assert.equal(bundle.files['feedback_special.md'], contents);
  assert.match(fs.readFileSync(generated, 'utf8').split('\n')[0], /自動生成。編集しない。コミットしない。/);
});

test('既存の旧memory-bundleディレクトリを削除して1行報告する', async () => {
  const f = fixture();
  const legacy = path.join(f.keyserveRepo, 'memory-bundle');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'feedback_stale.md'), '古い');
  const output = [];

  const result = await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: (line) => output.push(line) });

  assert.equal(result.removedLegacyDirectory, true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(output.filter((line) => line.includes('旧 memory-bundle/ ディレクトリを削除')).length, 1);
});

test('dry-runは件数とバイト数だけ報告し何も書かない', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_current.md'), feedback('本文'));
  const legacy = path.join(f.keyserveRepo, 'memory-bundle');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'keep.md'), '維持');
  const output = [];

  const result = await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, dryRun: true, emit: (line) => output.push(line) });

  assert.equal(result.files, 2);
  assert.equal(fs.existsSync(path.join(f.keyserveRepo, 'api', '_memory-bundle.generated.js')), false);
  assert.equal(fs.existsSync(path.join(f.keyserveRepo, 'memory-bundle.generated.js')), false);
  assert.equal(fs.existsSync(path.join(legacy, 'keep.md')), true);
  assert.deepEqual(output, [`dry-run: memory bundle: files=2 bytes=${result.bytes}`]);
});

test('出力先が api/_memory-bundle.generated.js になり旧パスの直下ファイルは削除される', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_current.md'), feedback('本文'));
  const legacyFile = path.join(f.keyserveRepo, 'memory-bundle.generated.js');
  fs.writeFileSync(legacyFile, '// 旧・直下配信で漏洩していたファイル');

  const result = await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: async () => {} });
  const { generated, bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(generated, path.join(f.keyserveRepo, 'api', '_memory-bundle.generated.js'));
  assert.equal(bundle.files['feedback_current.md'], feedback('本文'));
  assert.equal(result.removedLegacyPath, true);
  assert.equal(fs.existsSync(legacyFile), false);
});

test('memoryが0件でもfilesが空のモジュールを生成する', async () => {
  const f = fixture({ withMemoryIndex: false });

  const result = await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: async () => {} });
  const { bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(result.files, 0);
  assert.deepEqual(bundle.files, {});
  assert.ok(bundle.source.pc);
  assert.equal(bundle.source.account, '');
  assert.equal(Number.isNaN(Date.parse(bundle.generatedAt)), false);
});

test('deploy state compares actual bundle hash, skips stable next-day publish, verifies HMAC', async () => {
  const f = fixture(); const calls = [];
  fs.mkdirSync(path.join(f.memoryDir, 'index')); fs.writeFileSync(path.join(f.memoryDir, 'index/a.md'), '# domain');
  const env = { ORGIAST_KEYSERVE_PC: 'publisher', ORGIAST_MEMORYSERVE_REPO: f.keyserveRepo };
  const options = { home: f.home, env, deploy: true, verify: true, platform: 'linux', emit: () => {},
    spawnSyncImpl: (file, args, opts) => { calls.push({ file, args, opts }); return { status: 0, stdout: 'deploying\nhttps://deployment.example.invalid\n' }; },
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).search, '?manifest=1'); assert.equal(options.headers['x-orgiast-pc'], 'publisher'); assert.ok(options.headers['x-orgiast-auth']);
      return new Response(JSON.stringify(loadGenerated(f.keyserveRepo).bundle));
    } };
  const first = await publishMemories({ ...options, now: new Date('2026-10-15') });
  assert.equal(first.deploy, 'yes'); assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'vercel'); assert.deepEqual(calls[0].args, ['deploy', '--prod', '--yes']);
  assert.equal(calls[0].opts.shell, false); assert.equal(calls[0].opts.cwd, f.keyserveRepo);
  const statePath = path.join(f.home, '.claude/memory-publish-state.json');
  const state = JSON.parse(fs.readFileSync(statePath));
  const { createHash } = await import('node:crypto');
  assert.equal(state.sha256, createHash('sha256').update(fs.readFileSync(loadGenerated(f.keyserveRepo).generated)).digest('hex'));
  assert.equal(state.deploymentUrl, 'https://deployment.example.invalid');
  assert.equal(loadGenerated(f.keyserveRepo).bundle.files['index/a.md'], '# domain');
  assert.equal((await publishMemories({ ...options, now: new Date('2026-10-16') })).deploy, 'skip');
  assert.equal(calls.length, 1);
  fs.writeFileSync(path.join(f.memoryDir, 'index/a.md'), '# changed');
  assert.equal((await publishMemories({ ...options, now: new Date('2026-10-17') })).deploy, 'yes');
  assert.equal(calls.length, 2);
});
test('dry-run deploy/verify writes nothing and invokes neither process nor network', async () => {
  const f = fixture();
  await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, dryRun: true, deploy: true, verify: true, emit: () => {},
    spawnSyncImpl: () => assert.fail('spawn'), fetchImpl: () => assert.fail('fetch') });
  assert.deepEqual(fs.readdirSync(f.keyserveRepo), []);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/memory-publish-state.json')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/memory-bundle')), false);
});
test('failed deployment or verification does not save successful state', async () => {
  for (const failure of ['deploy', 'verify']) {
    const f = fixture();
    await assert.rejects(publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, deploy: true, verify: true, platform: 'linux', emit: () => {},
      spawnSyncImpl: () => ({ status: failure === 'deploy' ? 1 : 0, stdout: 'https://deployment.example.invalid' }),
      fetchImpl: async () => new Response(JSON.stringify({ version: 2, generatedAt: 'wrong' })) }), /NG:/);
    assert.equal(fs.existsSync(path.join(f.home, '.claude/memory-publish-state.json')), false);
  }
});

test('nightly CLI deploy skips PCs other than kim-PC without any writes', async () => {
  const { run } = await import('./memory-publish.mjs');
  const f = fixture();
  const result = await run(['--deploy', '--verify'], { home: f.home, env: { ORGIAST_KEYSERVE_PC: 'receiver' }, emit: () => {}, spawnSyncImpl: () => assert.fail('spawn') });
  assert.equal(result.skipped, 'not-kim-pc');
  assert.equal(fs.existsSync(path.join(f.home, '.claude/memory-publish-state.json')), false);
});
test('Windows resolves vercel.cmd then runs its Node entry without a shell', async () => {
  const { vercelCommand } = await import('./memory-publish.mjs');
  const f = fixture();
  const cli = path.join(f.root, 'node_modules/vercel/dist/vc.js');
  fs.mkdirSync(path.dirname(cli), { recursive: true }); fs.writeFileSync(cli, '// fixture');
  const command = vercelCommand({ platform: 'win32', spawnSyncImpl: (file, args, options) => {
    assert.equal(file, 'where.exe'); assert.deepEqual(args, ['vercel.cmd']); assert.equal(options.shell, false);
    return { status: 0, stdout: path.join(f.root, 'vercel.cmd') + '\r\n' };
  } });
  assert.equal(command.file, process.execPath); assert.deepEqual(command.args, [cli]);
});

test('bundle records configured keyserve PC and OAuth account without exporting user memories', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.home, '.claude/keyserve.env'), 'ORGIAST_KEYSERVE_PC=kim-PC\n');
  fs.writeFileSync(path.join(f.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'sender@example.invalid' } }));
  fs.writeFileSync(path.join(f.memoryDir, 'user.md'), '---\nmetadata:\n  type: user\n---\nuser profile');
  await publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, env: {}, emit: () => {} });
  const { bundle } = loadGenerated(f.keyserveRepo);
  assert.deepEqual(bundle.source, { pc: 'kim-PC', account: 'sender@example.invalid' });
  assert.equal(bundle.files['user.md'], undefined);
});
