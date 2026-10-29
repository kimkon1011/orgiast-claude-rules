import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaudeFallbackReport as evaluate } from './claude-fallback-report-gate.mjs';

for (const text of [
  '当面は Claude を利用します。',
  'Claude Sonnet で動きます。',
  '障害時は Claude にフォールバックします。',
  'この機能は Claude で代替します。',
  'Gemini のチャージは必須ではないので Claude のままです。',
]) test(`blocks: ${text}`, () => assert.equal(evaluate(text).decision, 'block'));

for (const text of [
  '> 当面は Claude を利用します。',
  '```text\nClaude にフォールバック\n```',
  '[CLAUDE-FALLBACK-OK] Gemini・Groq・DeepSeek が実測ですべて利用不能',
  'Claude Code の設定を更新しました。',
  'Gemini の残高が不足しているため、チャージしてください。',
  '過去発言「Claude のままです」は撤回します。',
  'Claude にフォールバックする分岐を削除しました',
  '他AIが全滅した時に Claude で代替しないよう修正しました',
  '当面は Claude ではなく Gemini で動かします',
  'Claude のままだと高くつくので Gemini に切り替えました',
]) test(`passes: ${text}`, () => assert.equal(evaluate(text).decision, 'pass'));

test('他AIの残高不足を理由にした Claude 継続は block', () => {
  assert.equal(evaluate('Kimi の残高が足りないため、当面は Claude で動きます').decision, 'block');
});

test('versioned Claude model is blocked', () => assert.equal(evaluate('Claude Sonnet 5 で動きます').decision, 'block'));
test('unclosed fence remains inspectable', () => assert.equal(evaluate('```text\n当面は Claude で動きます').decision, 'block'));
test('OK tag quoted inside the block reason is not a bypass', () => assert.equal(evaluate(`対応できません: ${evaluate('当面は Claude で動きます').reason}`).decision, 'block'));

test('OK tag requires a reason of at least 10 characters', () => assert.equal(evaluate('[CLAUDE-FALLBACK-OK] 短い\nClaude に戻す').decision, 'block'));

test('2026-10-18 実例: 敬体の「必須ではありません」も block', () => {
  assert.equal(evaluate('Kimi の残高を追加するかを判断する（必須ではありません）').decision, 'block');
  assert.equal(evaluate('Perplexity Sonar Pro を採用したので、Kimi の入金は必須ではありません。').decision, 'block');
  assert.equal(evaluate('Vercel 側に OpenRouter のキーが無いため、当面は Claude Haiku（約 $0.13/件）で動きます。').decision, 'block');
  assert.equal(evaluate('Kimi（seisaku-team@orgiast.jp）の残高を追加してください。').decision, 'pass');
});
