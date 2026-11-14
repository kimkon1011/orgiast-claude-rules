import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectPII, redactPII, formatSchema,
  pullSkills, pushSkills, pullSharedMemory, pushSharedMemory,
  NOTION_SKILL_SCHEMA, NOTION_MEMORY_SCHEMA } from './notion-skill-sync.mjs';

// ── PII 検出 ──────────────────────────────────────────────

test('detectPII: 案件IDを検出する', () => {
  const result = detectPII('案件 C0056 のブース仕様');
  assert.ok(result.some(r => r.label === '案件ID'));
});

test('detectPII: クリーンなテキストは空配列', () => {
  const result = detectPII('ブースのサイズは6m x 4mです。');
  assert.equal(result.length, 0);
});

test('detectPII: 法人名を検出する', () => {
  const result = detectPII('株式会社オージャストの最新事例');
  assert.ok(result.some(r => r.label === '法人名'));
});

test('detectPII: API キーを検出する', () => {
  const result = detectPII('sk-ant-abcdefghijklmnopqrstuvwxyz123456');
  assert.ok(result.some(r => r.label === 'API キー'));
});

test('detectPII: firstOnly で最初の1件だけ', () => {
  const result = detectPII('C0056 株式会社テスト', { firstOnly: true });
  assert.equal(result.length, 1);
});

// ── PII マスキング ────────────────────────────────────────

test('redactPII: 案件IDをマスクする', () => {
  const masked = redactPII('案件 C0056 の仕様');
  assert.ok(!masked.includes('C0056'));
  assert.ok(masked.includes('C'));
});

test('redactPII: クリーンなテキストはそのまま', () => {
  const input = 'ブースサイズは6m×4mです。';
  assert.equal(redactPII(input), input);
});

// ── スキーマ ──────────────────────────────────────────────

test('formatSchema: SKILLS の Markdown 出力にプロパティ表を含む', () => {
  const md = formatSchema('SKILLS', 'markdown');
  assert.ok(md.includes('Name'));
  assert.ok(md.includes('Description'));
  assert.ok(md.includes('Body'));
  assert.ok(md.includes('AI-Platform'));
  assert.ok(md.includes('週次レビュー'));
});

test('formatSchema: MEMORIES の Markdown 出力を含む', () => {
  const md = formatSchema('MEMORIES', 'markdown');
  assert.ok(md.includes('Title'));
  assert.ok(md.includes('NeedsReview'));
  assert.ok(md.includes('セキュリティルール'));
});

test('formatSchema: notion format は JSON を返す', () => {
  const json = formatSchema('SKILLS', 'notion');
  const parsed = JSON.parse(json);
  assert.equal(parsed.object, 'database');
  assert.ok(parsed.properties.Name);
});

// ── pullSkills ─────────────────────────────────────────────

test('pullSkills: 共有先が存在しない場合はエラー', () => {
  const result = pullSkills({ sharedInboxPath: '/nonexistent/path' });
  assert.ok(result.errors.some(e => e.includes('利用できません')));
});

test('pullSkills: skills/ がない場合はエラー', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-test-'));
  const result = pullSkills({ sharedInboxPath: tmpDir });
  assert.ok(result.errors.some(e => e.includes('見つかりません')));
});

// ── pushSkills ─────────────────────────────────────────────

test('pushSkills: 共有先が存在しない場合はエラー', () => {
  const result = pushSkills({ sharedInboxPath: '/nonexistent/path' });
  assert.ok(result.errors.some(e => e.includes('利用できません')));
});

// ── pullSharedMemory ───────────────────────────────────────

test('pullSharedMemory: 共有先が存在しない場合はエラー', () => {
  const result = pullSharedMemory({ sharedInboxPath: '/nonexistent/path' });
  assert.ok(result.errors.some(e => e.includes('利用できません')));
});

// ── pushSharedMemory ───────────────────────────────────────

test('pushSharedMemory: 共有先が存在しない場合はエラー', () => {
  const result = pushSharedMemory({ sharedInboxPath: '/nonexistent/path' });
  assert.ok(result.errors.some(e => e.includes('利用できません')));
});

// ── 実際のファイルI/O テスト ──────────────────────────────

test('pullSkills/pushSkills: 実際のファイルラウンドトリップ', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-roundtrip-'));
  const sharedDir = path.join(tmpDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const repoDir = path.join(tmpDir, 'repo');
  const skillsDir = path.join(repoDir, 'skills');

  // テスト用スキルを作成
  fs.mkdirSync(path.join(skillsDir, 'test-skill'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'test-skill', 'SKILL.md'), `---
name: test-skill
description: テスト用スキル
---

# test-skill

テスト用の手順書です。
`);

  // push → shared へ
  const pushResult = pushSkills({ sharedInboxPath: sharedDir, repoDir });
  assert.equal(pushResult.errors.length, 0);
  assert.ok(pushResult.pushed.includes('test-skill'));
  assert.ok(fs.existsSync(path.join(sharedDir, 'skills', 'test-skill', 'SKILL.md')));

  // pull → 別の場所へ復元
  const restoreDir = path.join(tmpDir, 'restore', 'skills');
  fs.mkdirSync(restoreDir, { recursive: true });
  const pullResult = pullSkills({ sharedInboxPath: sharedDir, repoDir: path.join(tmpDir, 'restore') });
  assert.equal(pullResult.errors.length, 0);
  assert.ok(pullResult.pulled.includes('test-skill'));
  assert.ok(fs.existsSync(path.join(tmpDir, 'restore', 'skills', 'test-skill', 'SKILL.md')));
});

test('pullSharedMemory/pushSharedMemory: メモリのラウンドトリップ', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-mem-roundtrip-'));
  const sharedDir = path.join(tmpDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const homeDir = path.join(tmpDir, 'home');
  const memoryDir = path.join(homeDir, '.claude', 'projects', 'd--CLAUDE-md--', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  // テスト用メモリを作成（source 指定あり）
  fs.writeFileSync(path.join(memoryDir, 'test-memory.md'), `---
name: test-memory
description: テスト用メモリ
metadata:
  type: feedback
---

# Test Memory

これはテスト用のメモリです。
`);

  // push（AI生成）
  const pushResult = pushSharedMemory({ sharedInboxPath: sharedDir, homeDir, source: 'gemini' });
  assert.equal(pushResult.errors.length, 0);
  assert.ok(pushResult.pushed.some(e => e.startsWith('test-memory')));
  assert.ok(fs.existsSync(path.join(sharedDir, 'cross-ai-memory', 'test-memory.md')));

  // プッシュされたファイルに needsReview フラグがあることを確認
  const pushedContent = fs.readFileSync(path.join(sharedDir, 'cross-ai-memory', 'test-memory.md'), 'utf8');
  assert.ok(pushedContent.includes('needsReview: true'));
  assert.ok(pushedContent.includes('source: gemini'));

  // pull → 別の場所へ復元
  const restoreHome = path.join(tmpDir, 'restore-home');
  const pullResult = pullSharedMemory({ sharedInboxPath: sharedDir, homeDir: restoreHome });
  assert.equal(pullResult.errors.length, 0);
  assert.ok(pullResult.pulled.some(e => e.startsWith('test-memory')));
});

test('pushSharedMemory: PIIを含むメモリはスキップされる', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nss-pii-'));
  const sharedDir = path.join(tmpDir, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const homeDir = path.join(tmpDir, 'home');
  const memoryDir = path.join(homeDir, '.claude', 'projects', 'd--CLAUDE-md--', 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  fs.writeFileSync(path.join(memoryDir, 'customer-data.md'), `---
name: customer-data
description: 顧客データ（PIIテスト）
---

案件 C0056 の情報: 株式会社テスト様
`);
  const result = pushSharedMemory({ sharedInboxPath: sharedDir, homeDir });
  assert.ok(result.errors.some(e => e.includes('PII検出')));
  assert.equal(result.pushed.length, 0);
});

// ── スキーマ整合性 ───────────────────────────────────────

test('SKILLS スキーマに全必須プロパティがある', () => {
  const names = NOTION_SKILL_SCHEMA.properties.map(p => p.name);
  assert.ok(names.includes('Name'));
  assert.ok(names.includes('Body'));
  assert.ok(names.includes('Description'));
  assert.ok(names.includes('NeedsReview'));
});

test('MEMORIES スキーマに全必須プロパティがある', () => {
  const names = NOTION_MEMORY_SCHEMA.properties.map(p => p.name);
  assert.ok(names.includes('Title'));
  assert.ok(names.includes('Body'));
  assert.ok(names.includes('NeedsReview'));
  assert.ok(names.includes('Source'));
});