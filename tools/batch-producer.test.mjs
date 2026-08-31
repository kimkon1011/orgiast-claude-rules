import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { produce } from './batch-producer.mjs';

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-producer-'));
  const project = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'open-session.jsonl'), '{"type":"user","message":"未完了を直す"}\n');
  return home;
}

test('同じ日の未クローズセッション要約を二重投入しない', () => {
  const home = fixture();
  const now = new Date('2026-08-28T12:00:00Z');
  assert.equal(produce({ home, now, sessionSummaryEnabled: true }).filter((job) => job.jobType === 'unclosed-session-summary').length, 1);
  assert.equal(produce({ home, now, sessionSummaryEnabled: true }).length, 0);
  const pending = fs.readFileSync(path.join(home, '.claude', 'batch-queue', 'pending.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(pending.filter((job) => job.jobType === 'unclosed-session-summary').length, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test('既定ではセッション要約を積まずスキップ理由を残す', () => {
  const home = fixture();
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: false });
  assert.ok(!made.some((job) => job.jobType === 'unclosed-session-summary'));
  assert.deepEqual(made.skipped, ['session-summary(既定OFF)']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('明示的に有効化した場合だけセッション要約を積む', () => {
  const home = fixture();
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: true });
  assert.ok(made.some((job) => job.jobType === 'unclosed-session-summary'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('ORGIAST_BATCH_SESSION_SUMMARY=1 のときだけ既定引数でセッション要約を積む', () => {
  const previous = process.env.ORGIAST_BATCH_SESSION_SUMMARY;
  const homeOff = fixture();
  const homeOn = fixture();
  try {
    delete process.env.ORGIAST_BATCH_SESSION_SUMMARY;
    assert.ok(!produce({ home: homeOff, now: new Date('2026-08-28T12:00:00Z') }).some((job) => job.jobType === 'unclosed-session-summary'));
    process.env.ORGIAST_BATCH_SESSION_SUMMARY = '1';
    assert.ok(produce({ home: homeOn, now: new Date('2026-08-28T12:00:00Z') }).some((job) => job.jobType === 'unclosed-session-summary'));
  } finally {
    if (previous === undefined) delete process.env.ORGIAST_BATCH_SESSION_SUMMARY;
    else process.env.ORGIAST_BATCH_SESSION_SUMMARY = previous;
    fs.rmSync(homeOff, { recursive: true, force: true });
    fs.rmSync(homeOn, { recursive: true, force: true });
  }
});

test('既定OFFでもバッチ結果の日次ダイジェストは積む', () => {
  const home = fixture();
  const queue = path.join(home, '.claude', 'batch-queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'results-2026-08-27.jsonl'), `${JSON.stringify({ id: 'result', jobType: 'other', text: '成果' })}\n`);
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z'), sessionSummaryEnabled: false });
  assert.ok(made.some((job) => job.jobType === 'results-daily-digest'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('当日のresultsに同種があればpendingが空でも再投入しない', () => {
  const home = fixture();
  const queue = path.join(home, '.claude', 'batch-queue');
  fs.mkdirSync(queue, { recursive: true });
  fs.writeFileSync(path.join(queue, 'results-2026-08-28.jsonl'), `${JSON.stringify({ id: 'done', jobType: 'unclosed-session-summary', batchDate: '2026-08-28', text: '済' })}\n`);
  const made = produce({ home, now: new Date('2026-08-28T12:00:00Z') });
  assert.ok(!made.some((job) => job.jobType === 'unclosed-session-summary'));
  assert.ok(made.some((job) => job.jobType === 'results-daily-digest'));
  fs.rmSync(home, { recursive: true, force: true });
});
