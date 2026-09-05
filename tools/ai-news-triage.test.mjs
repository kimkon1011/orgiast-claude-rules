import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendTodo, applyTriageResult, parseArgs, parseVerdict, rewritePendingSection, runTriage } from './ai-news-triage.mjs';

function fixture(t, records, digest = '前\n### 未処理の提案 1件\n- [P-0001] 旧 — 確認（確度: high / 要検証）\n<!-- AI-NEWS-END -->\n後') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-news-triage-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, 'ai-news-proposals.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(base, 'ai-news-digest.md'), digest);
  fs.writeFileSync(path.join(base, 'next-session.md'), '前\n## 残TODO（次の1件を先頭に）\n説明\n1. 既存TODO\n## 完了\n後\n');
  return { home, base };
}

const proposal = { id: 'P-0001', createdAt: '2026-09-01T00:00:00.000Z', status: 'pending', title: '料金を確認', action: '公式料金を比較する', evidence: 'LINE投稿', category: 'cost', confidence: 'high' };

test('CLI既定値とconfidence指定を解釈する', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.limit, 3); assert.deepEqual([...defaults.confidence], ['high']); assert.equal(defaults.provider, 'groq');
  assert.deepEqual([...parseArgs(['--confidence', 'medium,high', '--limit', '2', '--provider', 'deepseek']).confidence], ['medium', 'high']);
});

test('判定JSONを復旧し文字数を制限する', () => {
  const result = parseVerdict(`前置き\n\`\`\`json\n{"verdict":"confirmed","finding":"${'あ'.repeat(130)}","adopt":true,"reason":"${'い'.repeat(90)}"}\n\`\`\``);
  assert.equal(result.verdict, 'confirmed'); assert.equal(result.finding.length, 120); assert.equal(result.reason.length, 80);
});

test('status規則とunclear 3回上限を適用する', () => {
  assert.equal(applyTriageResult(proposal, { verdict: 'confirmed', finding: '', adopt: true }, { now: new Date(0), provider: 'groq' }).status, 'done');
  assert.equal(applyTriageResult(proposal, { verdict: 'confirmed', finding: '', adopt: false }, { now: new Date(0), provider: 'groq' }).status, 'rejected');
  assert.equal(applyTriageResult({ ...proposal, triageAttempts: 2 }, { verdict: 'unclear', finding: '', adopt: false }, { now: new Date(0), provider: 'groq' }).status, 'rejected');
});

test('TODOへ既存番号形式で追記し、見出し不明なら変更しない', () => {
  const input = '## 残TODO（次の1件を先頭に）\n説明\n1. 既存\n## 完了\n';
  const result = appendTodo(input, proposal);
  assert.match(result.text, /説明\n1\. \*\*AIニュース提案 \[P-0001\]: 料金を確認\*\* — 公式料金を比較する\n1\. 既存/);
  assert.equal(appendTodo('## 別の見出し\n1. 既存', proposal).changed, false);
});

test('digestの対象セクションだけを書き換える', () => {
  const input = '前\r\n### 未処理の提案 2件\r\n- [P-0001] 古い1\r\n- [P-0002] 古い2\r\n<!-- AI-NEWS-END -->\r\n後';
  const result = rewritePendingSection(input, [proposal]);
  assert.equal(result.text, '前\r\n### 未処理の提案 1件\r\n- [P-0001] 料金を確認 — 公式料金を比較する（確度: high / 要検証）\r\n<!-- AI-NEWS-END -->\r\n後');
});

test('依存注入した検索とLLMで採用し3ファイルを更新する', async (t) => {
  const { home, base } = fixture(t, [proposal]);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '公式料金表で確認' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.test' } }] } }] }) };
  };
  const result = await runTriage({ home, args: [], fetchImpl, geminiApiKey: 'test-key', groqApiKey: '', appendUsage() {}, llm: async (request) => { calls.push(request); return { text: '{"verdict":"confirmed","finding":"公式料金で確認できた","adopt":true,"reason":"削減可能","extra":"無視"}', provider: 'groq' }; }, now: () => new Date('2026-09-05T00:00:00.000Z'), log() {} });
  assert.equal(result.status, 'ok:検証1件 done1 rejected0 pending0'); assert.equal(calls.length, 2);
  const saved = JSON.parse(fs.readFileSync(path.join(base, 'ai-news-proposals.jsonl'), 'utf8'));
  assert.equal(saved.status, 'done'); assert.equal(saved.triageProvider, 'groq'); assert.equal(saved.evidence, 'LINE投稿');
  assert.match(fs.readFileSync(path.join(base, 'next-session.md'), 'utf8'), /AIニュース提案 \[P-0001\]/);
  assert.match(fs.readFileSync(path.join(base, 'ai-news-digest.md'), 'utf8'), /未処理の提案 0件/);
});

test('dry-runは検索と判定を行うがファイルを一切変更しない', async (t) => {
  const { home, base } = fixture(t, [proposal]);
  const files = ['ai-news-proposals.jsonl', 'ai-news-digest.md', 'next-session.md'];
  const before = Object.fromEntries(files.map((name) => [name, fs.readFileSync(path.join(base, name))]));
  const logs = [];
  await runTriage({ home, args: ['--dry-run'], fetchImpl: async () => { throw new Error('直接fetchされるべきでない'); }, search: async () => ({ answer: '不明', urls: [] }), llm: async () => ({ text: '{"verdict":"unclear","finding":"確認不能","adopt":false,"reason":"情報不足"}', provider: 'groq' }), log: (line) => logs.push(line) });
  for (const name of files) assert.deepEqual(fs.readFileSync(path.join(base, name)), before[name]);
  assert.match(logs[0], /^\[dry-run\] P-0001 unclear/);
});

test('--idはconfidenceを無視して1件だけ検証する', async (t) => {
  const low = { ...proposal, confidence: 'low' };
  const { home } = fixture(t, [low]);
  let searches = 0;
  const result = await runTriage({ home, args: ['--id', 'P-0001', '--dry-run'], search: async () => { searches += 1; return { answer: 'なし', urls: [] }; }, llm: async () => ({ text: '{"verdict":"refuted","finding":"否定","adopt":false,"reason":"根拠なし"}', provider: 'groq' }), log() {} });
  assert.equal(searches, 1); assert.equal(result.processed, 1);
});
