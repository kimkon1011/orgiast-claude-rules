import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatMarkdown, generateProposal, parseLlmResponse } from './ai-newswire.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(toolsDir, 'ai-newswire.mjs');
const fixture = {
  suggestions: ['AI 活用'], searchTerms: ['AI 活用 事例'],
  personas: [{ name: '田中', attributes: '担当者', interests: '効率化', challenges: '情報不足' }],
  outlines: [{ title: 'AI活用ガイド', headings: ['基礎', '事例'] }], qualityChecklist: ['根拠を示す'],
};

test('キーワード未指定時はエラーになる', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /キーワードが指定されていません/);
});

test('コードフェンス付きのLLM応答を解析できる', () => {
  assert.deepEqual(parseLlmResponse(`説明\n\`\`\`json\n${JSON.stringify(fixture)}\n\`\`\``), fixture);
});

test('Geminiのパース失敗時はGroqへフォールバックする', async () => {
  const calls = [];
  const result = await generateProposal('AI', async provider => {
    calls.push(provider);
    return provider === 'gemini' ? 'JSONではない応答' : JSON.stringify(fixture);
  });
  assert.deepEqual(calls, ['gemini', 'groq']);
  assert.equal(result.keyword, 'AI');
  assert.deepEqual(result.suggestions, ['AI 活用']);
});

test('Markdownに5要素を出力する', () => {
  const markdown = formatMarkdown({ keyword: 'AI', ...fixture });
  for (const heading of ['関連サジェストキーワード', '再検索ワード', '読者ペルソナ', '記事構成案', '記事品質チェックリスト']) {
    assert.match(markdown, new RegExp(heading));
  }
});
