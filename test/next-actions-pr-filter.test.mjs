import test from 'node:test';
import assert from 'node:assert/strict';
import { runNextActions } from '../tools/next-actions.mjs';

const action = (title, why, firstStep, source = 'TODO') => ({
  title, why, first_step: firstStep, source,
});

async function runWith({ actions, states = new Map(), failure }) {
  const stderr = [];
  const result = await runNextActions({
    args: ['--dry-run'],
    home: 'C:\\test-home',
    now: new Date('2026-11-24T00:00:00+09:00'),
    llm: async () => ({ provider: 'groq', text: JSON.stringify({ actions }) }),
    execImpl: (_file, args, _options, callback) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        callback(null, '[]');
        return;
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const number = Number(args[2]);
        if (failure?.number === number) {
          callback(new Error(failure.message));
          return;
        }
        callback(null, JSON.stringify({ state: states.get(number) }));
        return;
      }
      callback(null, '[]');
    },
    listLedger: async () => ({ ok: true, rows: [] }),
    log: () => {},
    error: value => stderr.push(value),
  });
  return { result, stderr };
}

test('MERGEDのPRを参照するLLMアクションは除外される', async () => {
  const stale = action('PR#2668 をマージする', '誤検知を除去するため', 'gh pr view 2668', 'PR#2668');
  const current = action('運用ログを確認', '未処理事項を確認するため', 'ログを開く');
  const { result } = await runWith({ actions: [stale, current], states: new Map([[2668, 'MERGED']]) });
  assert.doesNotMatch(result.body, /PR#2668/);
  assert.match(result.body, /運用ログを確認/);
});

test('CLOSEDのPRをwhyで参照するアクションは除外される', async () => {
  const stale = action('修正内容を確認', 'PR#2669 が未処理のため', '差分を開く');
  const { result } = await runWith({ actions: [stale], states: new Map([[2669, 'CLOSED']]) });
  assert.doesNotMatch(result.body, /PR#2669/);
  assert.match(result.body, /新しい依頼と未処理事項を確認/);
});

test('OPENのPRをfirst_stepで参照する候補とPR番号なしの候補は残る', async () => {
  const open = action('修正内容を確認', '未処理のため', 'gh pr view 3000');
  const plain = action('運用ログを確認', '未処理事項を確認するため', 'ログを開く');
  const { result } = await runWith({ actions: [open, plain], states: new Map([[3000, 'OPEN']]) });
  assert.match(result.body, /修正内容を確認/);
  assert.match(result.body, /gh pr view 3000/);
  assert.match(result.body, /運用ログを確認/);
});

test('GitHub問い合わせ失敗時は全候補を残して理由をstderrへ1行出す', async () => {
  const failed = action('PR#2999 を確認', '未処理PRを確認するため', 'gh pr view 2999', 'PR#2999');
  const plain = action('運用ログを確認', '未処理事項を確認するため', 'ログを開く');
  const { result, stderr } = await runWith({
    actions: [failed, plain],
    failure: { number: 2999, message: 'HTTP 404: Not Found' },
  });
  assert.match(result.body, /PR#2999 を確認/);
  assert.match(result.body, /運用ログを確認/);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /変更依頼 #2999 の状態を確認できませんでした（HTTP 404: Not Found）/);
});

test('全滅したら既定アクション1件を出す', async () => {
  const first = action('PR#2668 を確認', '未処理PRを確認するため', 'gh pr view 2668', 'PR#2668');
  const second = action('修正内容を確認', 'PR#2669 が未処理のため', '差分を開く');
  const { result } = await runWith({
    actions: [first, second],
    states: new Map([[2668, 'MERGED'], [2669, 'CLOSED']]),
  });
  assert.equal(result.actions.length, 1);
  assert.match(result.body, /新しい依頼と未処理事項を確認/);
});
