import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { exportMemories, installSharedMemories } from './memory-share.mjs';

const script = fileURLToPath(new URL('./memory-share.mjs', import.meta.url));

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

test('feedbackだけをexportし project/reference/user を除外する', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_ok.md'), memory('共有対象'));
  fs.writeFileSync(path.join(f.memoryDir, 'project_private.md'), memory('案件', 'project'));
  fs.writeFileSync(path.join(f.memoryDir, 'reference_private.md'), memory('参照', 'reference'));
  fs.writeFileSync(path.join(f.memoryDir, 'user_private.md'), memory('利用者', 'user'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  assert.equal(result.exported, 1);
  assert.deepEqual(fs.readdirSync(path.join(f.repoRoot, 'memory-shared')).sort(), ['EXCLUDED.md', 'feedback_ok.md', 'manifest.json']);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'manifest.json')));
  assert.equal(manifest.files[0].description, '共有対象');
});

test('トップレベル type: feedback にも対応する', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_top.md'), '---\ndescription: 上位type\ntype: feedback\n---\n本文\n');
  assert.equal(exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} }).exported, 1);
});

test('ドットで始まるfeedbackバックアップはexportせず対象外ファイルとしてログに出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, '.memory-bak-20260101-x.md'), memory('古い複製'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: (line) => output.push(line) });
  assert.equal(result.exported, 0);
  assert.match(output.join('\n'), /除外\(対象外ファイル\): \.memory-bak-20260101-x\.md — バックアップ\/隠しファイル/);
  assert.doesNotMatch(output.join('\n'), /除外\((?:資格情報|顧客情報)\): \.memory-bak/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'EXCLUDED.md'), 'utf8'), /\.memory-bak-20260101-x\.md/);
});

test('チルダで終わるfeedbackバックアップはexportせず対象外ファイルとしてログに出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_x.md~'), memory('エディタの複製'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: (line) => output.push(line) });
  assert.equal(result.exported, 0);
  assert.match(output.join('\n'), /除外\(対象外ファイル\): feedback_x\.md~ — バックアップ\/隠しファイル/);
  assert.doesNotMatch(fs.readFileSync(path.join(f.repoRoot, 'memory-shared', 'EXCLUDED.md'), 'utf8'), /feedback_x\.md~/);
});

test('対象外ファイルと同居しても正常なfeedbackは引き続きexportする', () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_ok.md'), memory('共有対象'));
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_copy.bak.md'), memory('バックアップ'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  assert.equal(result.exported, 1);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'memory-shared', 'feedback_ok.md')), true);
  assert.equal(fs.existsSync(path.join(f.repoRoot, 'memory-shared', 'feedback_copy.bak.md')), false);
});

test('Discord webhook URL はexportせず理由を1行出す', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_webhook.md'), memory('危険', 'feedback', 'https://discord.com/api/webhooks/123/token-value'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: (line) => output.push(line) });
  assert.equal(result.exported, 0); assert.equal(result.excluded, 1);
  assert.equal(output.filter((line) => line.startsWith('除外(資格情報):')).length, 1);
  assert.match(output[0], /feedback_webhook\.md.*秘密パターン Discord webhook URL に一致/);
});

test('法人名と案件IDを顧客情報として除外しEXCLUDED.mdには本文を残さない', () => {
  const f = fixture(); const output = [];
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_company.md'), memory('法人', 'feedback', '取引先は株式会社極秘テストです'));
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_case.md'), memory('案件', 'feedback', '対象案件は C0123 です'));
  const result = exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: (line) => output.push(line) });
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
  exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  const shared = path.join(f.repoRoot, 'memory-shared', 'feedback_ok.md');
  const manifest = path.join(f.repoRoot, 'memory-shared', 'manifest.json');
  const first = [fs.statSync(shared).mtimeMs, fs.statSync(manifest).mtimeMs];
  await new Promise((resolve) => setTimeout(resolve, 20));
  exportMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  assert.deepEqual([fs.statSync(shared).mtimeMs, fs.statSync(manifest).mtimeMs], first);
});

test('発信元PCではローカル直下と同名のmemoryをスキップする', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repoRoot, 'memory-shared'));
  fs.writeFileSync(path.join(f.repoRoot, 'memory-shared', 'feedback_same.md'), memory('同じ'));
  fs.writeFileSync(path.join(f.memoryDir, 'feedback_same.md'), memory('同じ'));
  const output = [];
  const result = installSharedMemories({ home: f.home, repoRoot: f.repoRoot, emit: (line) => output.push(line) });
  assert.equal(result.skipped, 1); assert.equal(fs.existsSync(path.join(f.memoryDir, 'shared', 'feedback_same.md')), false);
  assert.match(output.join('\n'), /ローカル直下に同名memoryあり/);
});

test('installを2回実行してもMEMORY.mdの索引行は1本だけ', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repoRoot, 'memory-shared'));
  fs.writeFileSync(path.join(f.repoRoot, 'memory-shared', 'feedback_remote.md'), memory('遠隔の知見'));
  installSharedMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  installSharedMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  const contents = fs.readFileSync(path.join(f.memoryDir, 'MEMORY.md'), 'utf8');
  assert.equal((contents.match(/他PCからの共有知見/g) || []).length, 1);
  assert.match(contents, /\[index\/shared\.md\]\(index\/shared\.md\) \(1件\)/);
});

test('index/shared.mdを既存indexと同じ見出し・説明リンク書式で生成する', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.repoRoot, 'memory-shared'));
  fs.writeFileSync(path.join(f.repoRoot, 'memory-shared', 'feedback_remote.md'), memory('遠隔の知見'));
  const result = installSharedMemories({ home: f.home, repoRoot: f.repoRoot, emit: () => {} });
  const contents = fs.readFileSync(path.join(f.memoryDir, 'index', 'shared.md'), 'utf8');
  assert.equal(result.indexed, 1);
  assert.match(contents, /^# 他PCからの共有知見\n\n（MEMORY\.md から辿られるサブ索引。[^\n]+）\n\n- \[遠隔の知見\]\(\.\.\/shared\/feedback_remote\.md\)\n$/);
});

test('memoryが1件も無いhomeのCLIはexit 0', () => {
  const f = fixture();
  const empty = path.join(f.root, 'empty-home'); fs.mkdirSync(empty);
  const child = spawnSync(process.execPath, [script, '--install', '--json'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: empty } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { installed: 0, skipped: 0, unchanged: 0, indexed: 0 });
});
