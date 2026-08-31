import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const script = path.resolve('tools/ai-news-inject.mjs');

function runWithDataAge(days) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-news-inject-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'ai-news-digest.md'),
    '<!-- AI-NEWS-START -->\nテストニュース\n<!-- AI-NEWS-END -->\n',
  );

  if (days !== null) {
    const dataDir = path.join(claudeDir, 'line-openchat');
    fs.mkdirSync(dataDir);
    // 実際に line-store.mjs が書くレコードと同じ形にすること。
    // ts を ISO 文字列で書いた fixture はテストを通してしまい、数値を読めないバグを隠した。
    const ts = Date.now() - days * 86400000;
    const record = { id: 'a1b2c3d4e5f60718', chat: '生成AI', sender: 'テスト', text: 'test', ts, receivedAt: new Date(ts).toISOString() };
    fs.writeFileSync(path.join(dataDir, '2026-08.jsonl'), `${JSON.stringify(record)}\n`);
  }

  try {
    return execFileSync(process.execPath, [script], {
      encoding: 'utf-8',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('jsonl が無ければ未取り込みを知らせる', () => {
  assert.match(runWithDataAge(null), /まだ1件も取り込まれていません/);
});

test('最新 ts が1日前なら警告しない', () => {
  const output = runWithDataAge(1);
  assert.equal(output, 'テストニュース\n');
});

test('最新 ts が5日前ならそろそろと知らせる', () => {
  assert.match(runWithDataAge(5), /最後の取り込みから 5 日。そろそろ/);
});

test('最新 ts が10日前なら期限接近を警告する', () => {
  assert.match(runWithDataAge(10), /⚠ 最後の取り込みから 10 日/);
});

test('最新 ts が20日前なら期限超過を警告する', () => {
  assert.match(runWithDataAge(20), /🔴 最後の取り込みから 20 日/);
});
