import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterLandedAndSuppressed, runNextActions } from '../tools/next-actions.mjs';

const candidate = (title, why = '確認が必要') => ({ title, why, first_step: '確認する', source: 'TODO' });
const suppressRules = [{
  regex: /上限プラン.*¥?5,?000/i,
  reason: 'kim 2026-11-18 有料案は出さない',
}];

test('origin/mainに着地済みのPRを参照する候補を理由付きで除外する', () => {
  const stale = candidate('PR #2292 Beeper fallback のマージ承認');
  const result = filterLandedAndSuppressed([stale], { landedPrNumbers: new Set([2292]), suppressRules });
  assert.deepEqual(result.actions, []);
  assert.equal(result.excluded[0].action, stale);
  assert.equal(result.excluded[0].reason, 'PR #2292 は origin/main に着地済み');
});

test('suppress設定に一致する決定済み候補を理由付きで除外する', () => {
  const decided = candidate('LINE 上限プラン B ¥5,000 を選択');
  const result = filterLandedAndSuppressed([decided], { landedPrNumbers: new Set(), suppressRules });
  assert.deepEqual(result.actions, []);
  assert.equal(result.excluded[0].reason, 'kim 2026-11-18 有料案は出さない');
});

test('着地済みPRにもsuppress設定にも当たらない候補は残る', () => {
  const current = candidate('PR#3000 のレビューを行う');
  const result = filterLandedAndSuppressed([current], { landedPrNumbers: new Set([2292]), suppressRules });
  assert.deepEqual(result, { actions: [current], excluded: [] });
});

test('git失敗を表すnullではPR候補を素通しする', () => {
  const candidateWithPr = candidate('PR#2292 のマージを確認');
  const result = filterLandedAndSuppressed([candidateWithPr], { landedPrNumbers: null, suppressRules: [] });
  assert.deepEqual(result, { actions: [candidateWithPr], excluded: [] });
});

test('除外した候補をnext-actions本文の末尾に理由付きで残す', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'next-actions-landed-'));
  const result = await runNextActions({
    home,
    now: new Date('2026-11-24T00:00:00+09:00'),
    args: ['--dry-run'],
    llm: async () => ({ text: JSON.stringify({ actions: [candidate('PR#2292 のマージ承認'), candidate('継続作業')] }) }),
    execImpl: (file, args, _options, callback) => {
      if (file === 'git') return callback(null, 'fix: landed (#2292)\n');
      if (file === 'gh' && args[1] === 'list') return callback(null, '[]');
      callback(new Error(`unexpected command: ${file} ${args.join(' ')}`));
    },
    suppressFile: path.join(home, 'missing-suppress.json'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log() {},
    error() {},
  });
  assert.match(result.body, /1\. 継続作業/);
  assert.match(result.body, /## 除外した候補（着地済み・決定済み）\n- PR#2292 のマージ承認 — PR #2292 は origin\/main に着地済み$/);
});
