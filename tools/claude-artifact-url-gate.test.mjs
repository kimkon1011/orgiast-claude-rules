import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, formatReason } from './claude-artifact-url-gate.mjs';

const urls = ['https://claude.ai/artifact/123', 'https://claude.ai/code/artifact/456'];
const fence = text => `\x60\x60\x60text\n${text}\n\x60\x60\x60`;

test('両形式の artifact URL を検出し重複と句読点を除く', () => {
  for (const url of urls) assert.deepEqual(judge(`文書: [こちら](${url})。`), { triggered: true, urls: [url] });
  assert.deepEqual(judge(`${urls[0]}、${urls[1]}。\n${urls[0]}.`), { triggered: true, urls });
});

test('本文の例外マーカーとコードフェンスは通過する', () => {
  assert.deepEqual(judge(`${urls[0]} [ARTIFACT-URL-OK]`), { triggered: false, urls: [] });
  assert.equal(judge(fence(urls.join('\n'))).triggered, false);
  assert.deepEqual(judge(`${urls[0]}\n${fence('[ARTIFACT-URL-OK]')}`), { triggered: true, urls: [urls[0]] });
});

test('Google Docs・他ドメイン・通常のClaude URL・空本文は通過する', () => {
  for (const text of ['', 'https://docs.google.com/document/d/123/edit',
    'https://docs.google.com/a/orgiast.jp/document/d/123/edit', 'https://claude.ai/chat/123',
    'https://claude.ai.example.com/artifact/123', 'https://example.com/https://claude.ai/artifact/123']) {
    assert.deepEqual(judge(text), { triggered: false, urls: [] });
  }
});

test('理由に規則・例外マーカー・URL一覧を含む', () => {
  const reason = formatReason(urls);
  for (const text of ['[CLAUDE-ARTIFACT-URL]', 'kim 2026-10-08', 'docs.google.com/a/orgiast.jp/', '[ARTIFACT-URL-OK]', ...urls]) assert.ok(reason.includes(text));
});

function invoke(t, text, { runner = false, input = {}, olderText = '' } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'artifact-url-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  writeFileSync(transcript, [
    { type: 'assistant', message: { content: olderText } },
    { type: 'user', message: { content: urls[0] } },
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(runner ? './stop-gate-runner.mjs' : './claude-artifact-url-gate.mjs', import.meta.url))], {
    input: JSON.stringify({ transcript_path: transcript, ...input }), encoding: 'utf8', timeout: 20000,
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' },
  });
  assert.ifError(result.error);
  return result;
}

test('CLI は artifact URL で exit 2 と理由を返す', t => {
  const result = invoke(t, urls.join('\n'));
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), formatReason(urls));
});

test('CLI は最新本文だけ判定し、例外・ループ防止・不正入力は通過する', t => {
  for (const [text, input] of [['作業しました。', {}], [`${urls[0]} [ARTIFACT-URL-OK]`, {}], [urls[0], { stop_hook_active: true }], ['', {}], [urls[0], { transcript_path: '/missing/transcript.jsonl' }]]) {
    const result = invoke(t, text, { input, olderText: text ? urls[1] : '' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, '');
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./claude-artifact-url-gate.mjs', import.meta.url))], { input: '{', encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
});

test('runner は当該ゲートで block し、例外・コードフェンス・Google Docs は通過する', t => {
  for (const [text, blocked] of [
    [`文書: ${urls[0]}（kim@orgiast.jp で開く）`, true],
    [`文書: ${urls[0]}（kim@orgiast.jp で開く） [ARTIFACT-URL-OK]`, false],
    [fence(urls[0]), false],
    ['文書: https://docs.google.com/a/orgiast.jp/document/d/123/edit', false],
  ]) {
    const result = invoke(t, text, { runner: true });
    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout ? JSON.parse(result.stdout) : {};
    assert.equal((output.reason || '').includes('[CLAUDE-ARTIFACT-URL]'), blocked);
    if (blocked) {
      assert.equal(output.decision, 'block');
      assert.match(output.reason, /### claude-artifact-url-gate/);
    }
  }
});
