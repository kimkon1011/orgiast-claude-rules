import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectQuestionText, judge } from './askuser-selfcheck-gate.mjs';

const noEvidence = { names: new Set(), inputs: '' };

test('collectQuestionText は質問文と選択肢を畳む', () => {
  const text = collectQuestionText({
    questions: [{ question: 'どれにしますか？', options: [{ label: 'A案', description: '安い' }] }],
  });
  assert.match(text, /どれにしますか/);
  assert.match(text, /A案/);
  assert.match(text, /安い/);
});

test('調査の外注はブロックする(別セッションを調べさせる質問)', () => {
  const result = judge({
    questions: [{ question: '別のセッションが並行作業していないか確認して教えてください。どうしますか？', options: [] }],
  }, noEvidence);
  assert.ok(result);
  assert.ok(result.sources.some((s) => s.key === 'Claude セッション / 別窓'));
});

test('自分で調べたあとなら通す', () => {
  const evidence = { names: new Set(['ListAgents']), inputs: '' };
  const result = judge({
    questions: [{ question: '別のセッションが並行作業していないか確認して教えてください。どうしますか？', options: [] }],
  }, evidence);
  assert.equal(result, null);
});

test('方針の選択は止めない(人にしか決められない)', () => {
  const result = judge({
    questions: [{
      question: '本番デプロイをどう恒久化しますか？',
      options: [
        { label: '許可を足して Claude が実行', description: 'permissions.allow に追加する' },
        { label: 'Vercel と GitHub を連携する', description: 'ブラウザで同意が要る' },
      ],
    }],
  }, noEvidence);
  assert.equal(result, null);
});

test('質問が空なら何もしない', () => {
  assert.equal(judge({ questions: [] }, noEvidence), null);
  assert.equal(judge({}, noEvidence), null);
});
