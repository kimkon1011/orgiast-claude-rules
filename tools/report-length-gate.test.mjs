import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bumpState, judgeReportLength, pruneState } from './report-length-gate.mjs';

const gate = fileURLToPath(new URL('./report-length-gate.mjs', import.meta.url));
const report = lines => ['実装しました', ...Array.from({ length: lines - 1 }, (_, index) => `詳細 ${index + 1}`)].join('\n');

test('3行の完了報告は pass', () => assert.equal(judgeReportLength(report(3), 'デプロイして').decision, 'pass'));
test('12行ちょうどの完了報告は pass', () => assert.equal(judgeReportLength(report(12), 'デプロイして').decision, 'pass'));
test('13行の完了報告は block', () => assert.equal(judgeReportLength(report(13), 'デプロイして').decision, 'block'));
test('30行でも完了報告の語が無ければ pass', () => assert.equal(judgeReportLength(Array(30).fill('詳細').join('\n'), 'デプロイして').decision, 'pass'));
test('説明を求めた発言には長い完了報告でも pass', () => assert.equal(judgeReportLength(report(30), 'なぜ失敗したか調べて').decision, 'pass'));
test('[REPORT-OK] があれば pass', () => assert.equal(judgeReportLength(`${report(30)}\n[REPORT-OK] 詳細が必要`, 'デプロイして').decision, 'pass'));
test('lastHumanText が空なら fail-open', () => assert.equal(judgeReportLength(report(30), '').decision, 'pass'));
test('assistantText が空なら fail-open', () => assert.equal(judgeReportLength('', 'デプロイして').decision, 'pass'));
test('block reason に実際の行数と文字数が入る', () => {
  const text = report(13);
  const result = judgeReportLength(text, 'デプロイして');
  assert.match(result.reason, /13 行/);
  assert.match(result.reason, new RegExp(`${text.length} 文字`));
});

test('同一セッションは連続2回だけ block し3回目以降 pass', () => {
  const now = new Date('2026-09-03T00:00:00Z');
  let state = {};
  let result = bumpState(state, 'session-a', true, now); state = result.state; assert.equal(result.blocked, true);
  result = bumpState(state, 'session-a', true, now); state = result.state; assert.equal(result.blocked, true);
  result = bumpState(state, 'session-a', true, now); state = result.state; assert.equal(result.blocked, false);
  result = bumpState(state, 'session-a', true, now); assert.equal(result.blocked, false);
});

test('24時間より古い状態は捨てる', () => {
  const state = {
    old: { consecutive: 2, updatedAt: '2026-09-01T23:59:59Z' },
    fresh: { consecutive: 1, updatedAt: '2026-09-02T00:00:01Z' },
  };
  assert.deepEqual(pruneState(state, new Date('2026-09-03T00:00:00Z')), { fresh: state.fresh });
});

function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-length-gate-'));
  fs.mkdirSync(path.join(root, '.claude'));
  return root;
}

function transcript(root, assistantText = report(13), humanText = 'デプロイして') {
  const file = path.join(root, 'session.jsonl');
  const entries = [
    { type: 'user', message: { role: 'user', content: humanText } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  ];
  fs.writeFileSync(file, entries.map(JSON.stringify).join('\n') + '\n');
  return file;
}

function run(input, root, enabled = true) {
  const env = { ...process.env, ORGIAST_HOME: root };
  if (enabled) env.ORGIAST_REPORT_LEN_GATE = '1';
  else delete env.ORGIAST_REPORT_LEN_GATE;
  return spawnSync(process.execPath, [gate], { input, encoding: 'utf8', env });
}

test('未有効化なら stdout 空・exit 0', () => {
  const root = tempHome();
  const result = run(JSON.stringify({ transcript_path: transcript(root), session_id: 'disabled' }), root, false);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('有効化した実 transcript の block ケースは block JSON・exit 0', () => {
  const root = tempHome();
  const result = run(JSON.stringify({ transcript_path: transcript(root), session_id: 'blocked' }), root);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});

test('stop_hook_active は何もしない', () => {
  const root = tempHome();
  const result = run(JSON.stringify({ transcript_path: transcript(root), session_id: 'active', stop_hook_active: true }), root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(fs.existsSync(path.join(root, '.claude', 'report-length-ledger.jsonl')), false);
});

test('壊れた JSON は fail-open かつ skipped を記録', () => {
  const root = tempHome();
  const result = run('{broken', root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const entry = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'report-length-ledger.jsonl'), 'utf8'));
  assert.equal(entry.verdict, 'skipped');
  assert.equal(entry.reasonCode, 'invalid-json');
});

test('ledger に excerpt が非空の1行を書く', () => {
  const root = tempHome();
  run(JSON.stringify({ transcript_path: transcript(root), session_id: 'ledger' }), root);
  const lines = fs.readFileSync(path.join(root, '.claude', 'report-length-ledger.jsonl'), 'utf8').trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  assert.ok(JSON.parse(lines[0]).excerpt.length > 0);
});
