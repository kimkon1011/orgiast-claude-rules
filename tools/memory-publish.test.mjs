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

test('CommonJSモジュールを生成し特殊文字を壊さず往復する', () => {
  const f = fixture();
  const body = 'バッククォート ` と ${value}\n改行\\バックスラッシュ\n</script>\n';
  const contents = feedback(body);
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_special.md'), contents);

  const result = publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, now: new Date('2026-09-02T13:00:00.000Z'), emit: () => {} });
  const { generated, bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(result.files, 1);
  assert.equal(result.bytes, fs.statSync(generated).size);
  assert.equal(bundle.version, 1);
  assert.equal(bundle.channel, 'private');
  assert.equal(bundle.generatedAt, '2026-09-02T13:00:00.000Z');
  assert.equal(Number.isNaN(Date.parse(bundle.generatedAt)), false);
  assert.equal(bundle.files['feedback_special.md'], contents);
  assert.match(fs.readFileSync(generated, 'utf8').split('\n')[0], /自動生成。編集しない。コミットしない。/);
});

test('既存の旧memory-bundleディレクトリを削除して1行報告する', () => {
  const f = fixture();
  const legacy = path.join(f.keyserveRepo, 'memory-bundle');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'feedback_stale.md'), '古い');
  const output = [];

  const result = publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: (line) => output.push(line) });

  assert.equal(result.removedLegacyDirectory, true);
  assert.equal(fs.existsSync(legacy), false);
  assert.equal(output.filter((line) => line.includes('旧 memory-bundle/ ディレクトリを削除')).length, 1);
});

test('dry-runは件数とバイト数だけ報告し何も書かない', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_current.md'), feedback('本文'));
  const legacy = path.join(f.keyserveRepo, 'memory-bundle');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'keep.md'), '維持');
  const output = [];

  const result = publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, dryRun: true, emit: (line) => output.push(line) });

  assert.equal(result.files, 1);
  assert.equal(fs.existsSync(path.join(f.keyserveRepo, 'api', '_memory-bundle.generated.js')), false);
  assert.equal(fs.existsSync(path.join(f.keyserveRepo, 'memory-bundle.generated.js')), false);
  assert.equal(fs.existsSync(path.join(legacy, 'keep.md')), true);
  assert.deepEqual(output, [`dry-run: memory bundle: files=1 bytes=${result.bytes}`]);
});

test('出力先が api/_memory-bundle.generated.js になり旧パスの直下ファイルは削除される', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_current.md'), feedback('本文'));
  const legacyFile = path.join(f.keyserveRepo, 'memory-bundle.generated.js');
  fs.writeFileSync(legacyFile, '// 旧・直下配信で漏洩していたファイル');

  const result = publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: () => {} });
  const { generated, bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(generated, path.join(f.keyserveRepo, 'api', '_memory-bundle.generated.js'));
  assert.equal(bundle.files['feedback_current.md'], feedback('本文'));
  assert.equal(result.removedLegacyPath, true);
  assert.equal(fs.existsSync(legacyFile), false);
});

test('memoryが0件でもfilesが空のモジュールを生成する', () => {
  const f = fixture({ withMemoryIndex: false });

  const result = publishMemories({ home: f.home, keyserveRepo: f.keyserveRepo, emit: () => {} });
  const { bundle } = loadGenerated(f.keyserveRepo);

  assert.equal(result.files, 0);
  assert.deepEqual(bundle.files, {});
  assert.equal(bundle.channel, 'private');
  assert.equal(Number.isNaN(Date.parse(bundle.generatedAt)), false);
});
