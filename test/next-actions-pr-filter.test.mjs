import test from 'node:test';
import assert from 'node:assert/strict';
import { runNextActions } from '../tools/next-actions.mjs';

test('MERGED の PR 番号を含む候補は出力から除外される', async () => {
  const output = [];
  const action = {
    title: 'PR#2668 をマージする',
    why: '誤検知を除去するため',
    first_step: 'gh pr view 2668 --repo kimkon1011/orgiast-claude-rules',
    source: 'PR#2668',
  };
  const result = await runNextActions({
    args: ['--dry-run'],
    home: 'C:\\test-home',
    now: new Date('2026-11-24T00:00:00+09:00'),
    llm: async () => ({ provider: 'groq', text: JSON.stringify({ actions: [action] }) }),
    execImpl: (_file, args, _options, callback) => callback(null,
      args[0] === 'pr' && args[1] === 'view' && args[2] === '2668'
        ? JSON.stringify({ state: 'MERGED' })
        : '[]'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log: value => output.push(value),
    error: () => {},
  });
  // 除外されて新しいデフォルト候補になるはず
  assert.match(result.body, /新しい依頼と未処理事項を確認/);
  assert.doesNotMatch(result.body, /PR#2668/);
});

test('OPEN の PR 番号を含む候補は出力に残る', async () => {
  const output = [];
  const action = {
    title: 'PR#3000 を確認',
    why: '未処理PRを確認するため',
    first_step: 'gh pr view 3000',
    source: 'PR#3000',
  };
  const result = await runNextActions({
    args: ['--dry-run'],
    home: 'C:\\test-home',
    now: new Date('2026-11-24T00:00:00+09:00'),
    llm: async () => ({ provider: 'groq', text: JSON.stringify({ actions: [action] }) }),
    execImpl: (_file, args, _options, callback) => callback(null,
      args[0] === 'pr' && args[1] === 'view' && args[2] === '3000'
        ? JSON.stringify({ state: 'OPEN' })
        : '[]'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log: value => output.push(value),
    error: () => {},
  });
  assert.match(result.body, /1\. PR#3000 を確認 \[PR#3000\]/);
  assert.doesNotMatch(result.body, /裏取り未済/);
  assert.doesNotMatch(result.body, /変更依頼/);
});

test('状態取得が失敗した PR 番号を含む候補は出力に残り note 行が付く', async () => {
  const output = [];
  const action = {
    title: 'PR#2999 を確認',
    why: 'PRの状態を確認するため',
    first_step: 'gh pr view 2999',
    source: 'PR#2999',
  };
  const result = await runNextActions({
    args: ['--dry-run'],
    home: 'C:\\test-home',
    now: new Date('2026-11-24T00:00:00+09:00'),
    llm: async () => ({ provider: 'groq', text: JSON.stringify({ actions: [action] }) }),
    execImpl: (_file, args, _options, callback) => callback(null,
      args[0] === 'pr' && args[1] === 'view' && args[2] === '2999'
        ? callback(new Error('HTTP 404: Not Found'))
        : '[]'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log: value => output.push(value),
    error: () => {},
  });
  assert.match(result.body, /1\. PR#2999 を確認 \[PR#2999\]/);
  assert.match(result.body, /変更依頼 #2999 の状態を確認できませんでした/);
});