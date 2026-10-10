import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { USER_REWORK_PATTERN, isHumanMessage, collectUserReworkStats } from './user-rework-stats.mjs';

test('USER_REWORK_PATTERN は手戻りシグナルを検出する', () => {
  assert.ok(USER_REWORK_PATTERN.test('そうじゃないの？'));
  assert.ok(USER_REWORK_PATTERN.test('そんなはずがない'));
  assert.ok(USER_REWORK_PATTERN.test('また聞かないといけないのか'));
  assert.ok(USER_REWORK_PATTERN.test('何回も言わせるな'));
  assert.ok(USER_REWORK_PATTERN.test('勝手に決めないで'));
  assert.ok(USER_REWORK_PATTERN.test('ちゃんと見て'));
  assert.ok(USER_REWORK_PATTERN.test('そちらでやって'));
  assert.ok(USER_REWORK_PATTERN.test('自分でやって'));
});

test('isHumanMessage はシステムメッセージを除外する', () => {
  assert.equal(isHumanMessage('<local-command-stdout>'), false);
  assert.equal(isHumanMessage('<system-reminder>'), false);
  assert.equal(isHumanMessage('そうじゃないの？'), true);
});

test('collectUserReworkStats はトランスクリプトから集計できる', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rework-test-'));
  try {
    const projDir = path.join(tmpHome, '.claude', 'projects', 'test');
    fs.mkdirSync(projDir, { recursive: true });
    const transcriptPath = path.join(projDir, 'session1.jsonl');

    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '普通のお願い' } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ちゃんと見てって言ったよね' } })
    ];
    fs.writeFileSync(transcriptPath, lines.join('\n'));

    const stats = collectUserReworkStats({ home: tmpHome, days: 7, transcriptPath });
    assert.equal(stats.currentSessionCount, 1);
    assert.equal(stats.sevenDayCount, 1);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
