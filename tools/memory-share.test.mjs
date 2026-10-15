import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exportMemories, installSharedMemories } from './memory-share.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-share-'));
  const home = path.join(root, 'home');
  const repoRoot = path.join(root, 'repo');
  const memoryDir = path.join(home, '.claude', 'projects', 'project-a', 'memory');
  fs.mkdirSync(path.join(memoryDir, 'index'), { recursive: true });
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# MEMORY\n\n## ドメイン索引\n- **既存** 説明 → [index/old.md](index/old.md) (1件)\n');
  fs.writeFileSync(path.join(memoryDir, 'index', 'old.md'), '# 既存\n\n（MEMORY.md から辿られるサブ索引。新規はここへ1行足す）\n\n- [既存](../feedback_old.md)\n');
  return { root, home, repoRoot, memoryDir };
}

function memory(description, type = 'feedback', body = '本文') {
  return `---\nname: sample\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n\n${body}\n`;
}

function exportOptions(f, extra = {}) { return { home: f.home, outDir: path.join(f.repoRoot, 'memory-shared'), channel: 'public', emit: () => {}, ...extra }; }


test('feedbackだけをexportし project/reference/user を除外する', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_ok.md'), memory('共有対象'));
  fs.writeFileSync(path.join(f.memoryDir, 'project_private.md'), memory('案件', 'project'));
  fs.writeFileSync(path.join(f.memoryDir, 'reference_private.md'), memory('参照', 'reference'));
  fs.writeFileSync(path.join(f.memoryDir, 'user_private.md'), memory('利用者', 'user'));
  const result = exportMemories(exportOptions(f));
  assert.equal(result.exported, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.repoRoot, 'memory-shared')).sort(), ['EXCLUDED.md', 'feedback_ok.md', 'manifest.json']);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'manifest.json')));
  assert.equal(manifest.files[0].description, '共有対象');
});

test('トップレベル type: feedback にも対応する', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_top.md'), '---\ndescription: 上位type\ntype: feedback\n---\n本文\n');
  assert.equal(exportMemories(exportOptions(f)).exported, 1);
});

test('ドットで始まるfeedbackバックアップはexportせず対象外ファイルとしてログに出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, '.memory-bak-20260101-x.md'), memory('古い複製'));
  const result = exportMemories(exportOptions(f, { emit: (line) => output.push(line) }));
  assert.equal(result.exported, 0);
  assert.match(output.join('\n'), /除外\(対象外ファイル\): \.memory-bak-20260101-x\.md — バックアップ\/隠しファイル/);
  assert.doesNotMatch(output.join('\n'), /除外\((?:資格情報|顧客情報)\): \.memory-bak/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'EXCLUDED.md'), 'utf8'), /\.memory-bak-20260101-x\.md/);
});

test('チルダで終わるfeedbackバックアップはexportせず対象外ファイルとしてログに出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_x.md~'), memory('エディタの複製'));
  const result = exportMemories(exportOptions(f, { emit: (line) => output.push(line) }));
  assert.equal(result.exported, 0);
  assert.match(output.join('\n'), /除外\(対象外ファイル\): feedback_x\.md~ — バックアップ\/隠しファイル/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'EXCLUDED.md'), 'utf8'), /feedback_x\.md~/);
});

test('対象外ファイルと同居しても正常なfeedbackは引き続きexportする', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_ok.md'), memory('共有対象'));
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_copy.bak.md'), memory('バックアップ'));
  const result = exportMemories(exportOptions(f));
  assert.equal(result.exported, 1);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'memory-shared', 'feedback_ok.md')), true);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'memory-shared', 'feedback_copy.bak.md')), false);
});

test('Discord webhook URL はexportせず理由を1行出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_webhook.md'), memory('危険', 'feedback', 'https://discord.com/api/webhooks/123/token-value'));
  const result = exportMemories(exportOptions(f, { emit: (line) => output.push(line) }));
  assert.equal(result.exported, 0); assert.equal(result.excluded, 1);
  assert.equal(output.filter((line) => line.startsWith('除外(資格情報):')).length, 1);
  assert.match(output[0], /feedback_webhook\.md.*秘密パターン Discord webhook URL に一致/);
});

test('privateは法人名と案件IDを除外せずpublicだけ除外する', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_company.md'), memory('法人', 'feedback', '取引先は株式会社極秘テストです'));
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_case.md'), memory('案件', 'feedback', '対象案件は C0123 です'));
  const privateResult = exportMemories(exportOptions(f, { channel: 'private' }));
  assert.equal(privateResult.exported, 4);
  const result = exportMemories(exportOptions(f, { channel: 'public', emit: (line) => output.push(line) }));
  assert.equal(result.exported, 0);
  assert.equal(result.excludedCustomerInfo, 2);
  assert.equal(result.excludedSecrets, 0);
  assert.equal(output.filter((line) => line.startsWith('除外(顧客情報):')).length, 2);
  assert.doesNotMatch(output.join('\n'), /除外\(資格情報\)/);
  const excluded = fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'EXCLUDED.md'), 'utf8');
  assert.match(excluded, /feedback_company\.md.*顧客情報（法人名\/案件ID）を含む/);
  assert.match(excluded, /feedback_case\.md.*顧客情報（法人名\/案件ID）を含む/);
  assert.doesNotMatch(excluded, /株式会社極秘テスト|C0123|対象案件/);
});

test('同じ内容で2回exportしてもmemoryとmanifestのmtimeを変えない', async () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_ok.md'), memory('共有対象'));
  exportMemories(exportOptions(f));
  const shared = path.join(f.repoRoot, 'memory-shared', 'feedback_ok.md');
  const manifest = path.join(f.repoRoot, 'memory-shared', 'manifest.json');
  const first = [fs.statSync(shared).mtimeMs, fs.statSync(manifest).mtimeMs];
  await new Promise((resolve) => setTimeout(resolve, 20));
  exportMemories(exportOptions(f));
  assert.deepEqual([fs.statSync(shared).mtimeMs, fs.statSync(manifest).mtimeMs], first);
});


test('private exports all allowed types and indexes, excludes user, opt-outs, backups and secrets', () => {
  const f = fixture();
  for (const type of ['feedback', 'project', 'reference', 'user']) fs.writeFileSync(path.join(f.memoryDir, `${type}.md`), memory(type, type));
  fs.writeFileSync(path.join(f.memoryDir, 'opt.md'), '---\ntype: project\nshare: false\n---\nprivate');
  fs.writeFileSync(path.join(f.memoryDir, 'nested.md'), '---\nmetadata:\n  type: reference\n  share: false # opt out\n---\nprivate');
  fs.writeFileSync(path.join(f.memoryDir, 'secret.md'), memory('secret', 'project', '-----BEGIN PRIVATE KEY-----'));
  for (const dir of ['index.bak-1', '.memory-body-backup-1', 'shared']) {
    fs.mkdirSync(path.join(f.memoryDir, dir)); fs.writeFileSync(path.join(f.memoryDir, dir, 'bad.md'), memory('bad'));
  }
  fs.writeFileSync(path.join(f.memoryDir, 'EXCLUDED.md'), memory('excluded'));
  const logs = [];
  const options = exportOptions(f, { channel: 'private', emit: line => logs.push(line) });
  const result = exportMemories(options);
  assert.equal(result.exported, 5);
  assert.equal(result.excluded, 3);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.outDir, 'manifest.json')));
  assert.deepEqual(manifest.files.map(f => f.name).sort(), ['MEMORY.md', 'feedback.md', 'index/old.md', 'project.md', 'reference.md']);
  assert.equal(logs.filter(line => line.startsWith('除外(共有拒否)')).length, 2);
  fs.unlinkSync(path.join(f.memoryDir, 'index', 'old.md'));
  exportMemories(options);
  assert.equal(fs.existsSync(path.join(options.outDir, 'index', 'old.md')), false);
});

const digest = text => crypto.createHash('sha256').update(text).digest('hex');
function remote(files, generatedAt = '2026-10-15T00:00:00Z') {
  const entries = Object.entries(files);
  const source = { pc: 'publisher', account: 'sender@example.invalid' };
  const manifest = { version: 2, generatedAt, source, parts: entries.length, files: entries.map(([name, content], part) => ({ name, sha256: digest(content), bytes: Buffer.byteLength(content), part })) };
  const calls = [];
  return { manifest, calls, fetchImpl: async (url, options) => {
    const query = new URL(url).searchParams; calls.push(new URL(url).search);
    assert.ok(options.headers['x-orgiast-auth']);
    const part = Number(query.get('part'));
    return new Response(JSON.stringify(query.has('manifest') ? manifest : { version: 2, generatedAt, source, part, parts: entries.length, files: Object.fromEntries([entries[part]]) }));
  } };
}
function receiver(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-receiver-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'shared-memory');
  return { home, dir, options: { home, env: { ORGIAST_KEYSERVE_PC: 'receiver' }, emit: () => {} } };
}
test('new PC installs manifest/parts, annotates index, fetches only changed parts and prunes files', async t => {
  const f = receiver(t);
  const a = remote({ 'MEMORY.md': '# index', 'index/a.md': '# domain', 'old.md': 'old' });
  const first = await installSharedMemories({ ...f.options, fetchImpl: a.fetchImpl });
  assert.equal(first.installed, 3);
  const index = fs.readFileSync(path.join(f.dir, 'MEMORY.md'), 'utf8');
  assert.match(index, /<!-- orgiast-shared-memory -->/);
  assert.match(index, /sender@example.invalid（publisher）/);
  assert.ok(index.endsWith('# index'));
  a.calls.length = 0;
  const same = await installSharedMemories({ ...f.options, fetchImpl: a.fetchImpl });
  assert.equal(same.unchanged, 3); assert.deepEqual(a.calls, ['?manifest=1']);
  fs.writeFileSync(path.join(f.dir, 'README.md'), 'keep');
  const b = remote({ 'MEMORY.md': '# index', 'index/a.md': '# changed' });
  const next = await installSharedMemories({ ...f.options, fetchImpl: b.fetchImpl });
  assert.deepEqual(b.calls, ['?manifest=1', '?part=1']);
  assert.equal(next.updated, 1); assert.equal(next.removed, 1);
  assert.equal(fs.existsSync(path.join(f.dir, 'old.md')), false);
  assert.equal(fs.readFileSync(path.join(f.dir, 'README.md'), 'utf8'), 'keep');
  const state = JSON.parse(fs.readFileSync(path.join(f.dir, '.state.json')));
  assert.equal(state.files['index/a.md'], digest('# changed'));
  assert.deepEqual(state.source, b.manifest.source);
  const c = remote({ 'MEMORY.md': '# index', 'index/a.md': '# changed' }, '2026-10-16T00:00:00Z');
  await installSharedMemories({ ...f.options, fetchImpl: c.fetchImpl });
  assert.deepEqual(c.calls, ['?manifest=1', '?part=0']);
  assert.match(fs.readFileSync(path.join(f.dir, 'MEMORY.md'), 'utf8'), /2026-10-16/);
});
test('source PC skips by explicit identity or 50% root name overlap only without configured identity', async t => {
  const f = receiver(t);
  const a = remote({ 'a.md': 'a', 'b.md': 'b' });
  const explicit = await installSharedMemories({ ...f.options, env: { ORGIAST_KEYSERVE_PC: 'publisher' }, fetchImpl: a.fetchImpl });
  assert.equal(explicit.skipped, 2); assert.equal(fs.existsSync(f.dir), false);
  const local = path.join(f.home, '.claude/projects/p/memory'); fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'a.md'), 'local');
  const fallback = await installSharedMemories({ ...f.options, env: {}, fetchImpl: a.fetchImpl });
  assert.equal(fallback.skipped, 2);
  const received = await installSharedMemories({ ...f.options, fetchImpl: a.fetchImpl });
  assert.equal(received.installed, 2);
  assert.equal(fs.readFileSync(path.join(local, 'a.md'), 'utf8'), 'local');
});
test('offline v2 layout and dry-run need no network or local auto-memory', async t => {
  const f = receiver(t); const fromDir = path.join(f.home, 'bundle');
  fs.mkdirSync(path.join(fromDir, 'index'), { recursive: true });
  fs.writeFileSync(path.join(fromDir, 'MEMORY.md'), '# memory'); fs.writeFileSync(path.join(fromDir, 'index/a.md'), '# a');
  const options = { ...f.options, fromDir, fetchImpl: () => assert.fail('network') };
  assert.equal((await installSharedMemories({ ...options, dryRun: true })).installed, 2);
  assert.equal(fs.existsSync(f.dir), false);
  assert.equal((await installSharedMemories(options)).installed, 2);
  assert.equal(fs.readFileSync(path.join(f.dir, 'index/a.md'), 'utf8'), '# a');
});
test('invalid paths, hashes and mixed generations leave installed files and state intact', async t => {
  const f = receiver(t); const initial = remote({ 'a.md': 'a' });
  await installSharedMemories({ ...f.options, fetchImpl: initial.fetchImpl });
  const before = fs.readFileSync(path.join(f.dir, '.state.json'), 'utf8');
  for (const failure of ['path', 'hash', 'generation', '401', 'json']) {
    const a = remote({ 'b.md': 'b' });
    if (failure === 'path') a.manifest.files[0].name = '../escape.md';
    if (failure === 'hash') a.manifest.files[0].sha256 = digest('wrong');
    const fetchImpl = async (url, options) => {
      if (failure === '401') return new Response('', { status: 401 });
      if (failure === 'json') return new Response('{broken');
      const response = await a.fetchImpl(url, options);
      const body = await response.json();
      if (failure === 'generation' && new URL(url).searchParams.has('part')) body.generatedAt = 'other';
      return new Response(JSON.stringify(body));
    };
    const result = await installSharedMemories({ ...f.options, fetchImpl });
    assert.ok(result.error, failure);
    assert.equal(fs.readFileSync(path.join(f.dir, '.state.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(f.dir, 'a.md'), 'utf8'), 'a');
  }
});
