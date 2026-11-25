import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./kim-inbox-backfill-kind.mjs', import.meta.url));

function seed(dir, overrides = {}) {
  const id = overrides.id || 'ki-20261123000000-' + String(Math.random()).slice(2, 6);
  const item = {
    id,
    kind: 'ask',
    status: 'open',
    createdAt: new Date().toISOString(),
    text: overrides.text || 'テスト用の通知です',
    source: overrides.source || 'auto-progress-done',
    shownSessions: [],
    shownCount: 0,
    ...overrides,
    id,
  };
  const filePath = path.join(dir, id + '.json');
  fs.writeFileSync(filePath, JSON.stringify(item, null, 2) + '\n');
  return { id, filePath };
}

function runCli(dir, ...args) {
  return JSON.parse(execFileSync(process.execPath, [cli, '--dir', dir, '--format', 'json', ...args], {
    env: { ...process.env },
    encoding: 'utf8',
  }));
}

function readItem(dir, id) {
  return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8'));
}

function mtime(dir, id) {
  return fs.statSync(path.join(dir, id + '.json')).mtimeMs;
}

test('dry-run ではファイルが変更されない', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, { id: 'ki-20261123000000-aaaa', text: '進捗完了の報告です', source: 'auto-progress-done' });
  const beforeMtime = mtime(tmpDir, 'ki-20261123000000-aaaa');
  const beforeContent = fs.readFileSync(path.join(tmpDir, 'ki-20261123000000-aaaa.json'), 'utf8');

  const result = runCli(tmpDir);
  assert.equal(result.total, 1);
  assert.ok('demotable' in result);

  const afterMtime = mtime(tmpDir, 'ki-20261123000000-aaaa');
  const afterContent = fs.readFileSync(path.join(tmpDir, 'ki-20261123000000-aaaa.json'), 'utf8');
  assert.equal(beforeMtime, afterMtime, 'dry-run では mtime が変わらない');
  assert.equal(beforeContent, afterContent, 'dry-run ではファイル内容が完全一致');
});

test('status: answered の ask は降格されない', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-bbbb',
    status: 'answered',
    answeredAt: '2026-11-23T12:00:00.000Z',
    answer: '不要',
    source: 'auto-progress-done',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 0, 'answered は対象外');
});

test('kind: info は対象にならない', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-cccc',
    kind: 'info',
    source: 'auto-progress-done',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 0, 'info は対象外');
});

test('source が対象外の ask は降格されない', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-dddd',
    source: 'login-health',
    text: 'ログイン確認をお願いします',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 1);
  assert.equal(result.demotable, 0);
  assert.equal(result.kept, 1);
  assert.equal(result.items[0].demote, false);
  assert.match(result.items[0].reason, /対象外/);
});

test('stalled-session-resume-overdue で text に承認を含むものは据え置き', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-eeee',
    source: 'stalled-session-resume-overdue',
    text: '【要対応】承認待ちの案件です',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 1);
  assert.equal(result.demotable, 0);
  assert.equal(result.kept, 1);
  assert.equal(result.items[0].demote, false);
});

test('stalled-session-resume-overdue で text に判断ワードなしは降格', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-ffff',
    source: 'stalled-session-resume-overdue',
    text: '進捗報告：作業が完了しました',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 1);
  assert.equal(result.demotable, 1);
  assert.equal(result.items[0].demote, true);
});

test('auto-progress-start-expired で判断ワードなしは降格', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-a7a7',
    source: 'auto-progress-start-expired',
    text: '自動進行の開始が期限切れになりました',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 1);
  assert.equal(result.demotable, 1);
  assert.equal(result.items[0].demote, true);
  assert.equal(result.items[0].id, 'ki-20261123000000-a7a7');
});

test('--apply で kind が info に変わり kindBefore と kindBackfilledAt が追記される', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-b0b0',
    source: 'auto-progress-start-expired',
    text: '単なる期限切れの通知です',
  });

  const dry = runCli(tmpDir);
  assert.equal(dry.demotable, 1);

  const result = runCli(tmpDir, '--apply');
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0], 'ki-20261123000000-b0b0');

  const saved = readItem(tmpDir, 'ki-20261123000000-b0b0');
  assert.equal(saved.kind, 'info');
  assert.equal(saved.kindBefore, 'ask');
  assert.ok(typeof saved.kindBackfilledAt === 'string');
  assert.ok(Date.parse(saved.kindBackfilledAt) > 0);
  assert.equal(saved.status, 'open', 'status は不変');
});

test('auto-progress-done で判断不要な decide は降格、判断が必要な decide は据え置き', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 判断不要（報告のみ）になるテキスト
  seed(tmpDir, {
    id: 'ki-20261123000000-c0c0',
    source: 'auto-progress-done',
    text: '自動進行の完了報告です。特に kim の操作は不要です。',
  });

  // 判断が必要なテキスト（承認待ちを含む）
  seed(tmpDir, {
    id: 'ki-20261123000000-d0d0',
    source: 'auto-progress-done',
    text: '【要対応】作業が完了しました。kim がすること: 確認してください',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 2);

  const demotable = result.items.filter(r => r.demote);
  const kept = result.items.filter(r => !r.demote);
  assert.equal(demotable.length, 1, 'c0c0 は判断不要で降格');
  assert.equal(kept.length, 1, 'd0d0 は判断必要で据え置き');
  assert.equal(demotable[0].id, 'ki-20261123000000-c0c0');
  assert.equal(kept[0].id, 'ki-20261123000000-d0d0');
});

test('既存の kindBefore が無いファイルでも上書きできる', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  seed(tmpDir, {
    id: 'ki-20261123000000-e0e0',
    source: 'stalled-session-resume-overdue',
    text: '通知のみのメッセージです',
  });

  const result = runCli(tmpDir, '--apply');
  assert.equal(result.applied.length, 1);

  const saved = readItem(tmpDir, 'ki-20261123000000-e0e0');
  assert.equal(saved.kind, 'info');
  assert.equal(saved.kindBefore, 'ask');
});

test('複数件混在で正しく分類される', t => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-backfill-kind-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // 降格対象: auto-progress-start-expired で判断ワードなし
  seed(tmpDir, {
    id: 'ki-20261123000000-f0f0',
    source: 'auto-progress-start-expired',
    text: '通知のみ',
  });
  // 降格対象: auto-progress-done で判断不要
  seed(tmpDir, {
    id: 'ki-20261123000000-a1a1',
    source: 'auto-progress-done',
    text: '完了しました。判断不要です。',
  });
  // 据え置き: stalled-session-resume-overdue で判断ワードあり
  seed(tmpDir, {
    id: 'ki-20261123000000-b2b2',
    source: 'stalled-session-resume-overdue',
    text: '【要対応】承認待ちの案件があります',
  });
  // 据え置き: 対象外 source
  seed(tmpDir, {
    id: 'ki-20261123000000-c3c3',
    source: 'login-health',
    text: 'ログイン確認',
  });

  const result = runCli(tmpDir);
  assert.equal(result.total, 4);
  assert.equal(result.demotable, 2);
  assert.equal(result.kept, 2);
});

