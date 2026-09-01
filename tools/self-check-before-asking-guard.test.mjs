import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  findOutsourcedInvestigation,
  formatViolationMessage,
  hasEvidenceMarker,
  hasBareMarker,
  splitParagraphs,
  scanToolUses,
  scanToolNames,
} from './self-check-before-asking-guard.mjs';

const noEvidence = { names: new Set(), inputs: '' };

test('別々の段落なら誤検知しない(メール非露出の報告 + 別窓の依頼)', () => {
  const text = 'メール非露出0件を確認しました。\n\n別の窓を確認してください。';
  const evidence = { names: new Set(['ListAgents']), inputs: '' };
  assert.equal(findOutsourcedInvestigation(text, evidence), null);
});

test('同じ段落に Gmail 語と依頼表現があり Gmail 未使用なら違反', () => {
  const result = findOutsourcedInvestigation('登録メールが届いているか確認してください。', noEvidence);
  assert.ok(result);
  assert.ok(result.sources.some((s) => s.key === 'Gmail'));
});

test('Gmail ツールを使っていれば通る', () => {
  const evidence = { names: new Set(['mcp__claude_ai_Gmail__search_threads']), inputs: '' };
  assert.equal(findOutsourcedInvestigation('登録メールが届いているか確認してください。', evidence), null);
});

test('別セッションの調査依頼は証拠が無ければ違反', () => {
  const result = findOutsourcedInvestigation('心当たりが無ければ別のセッションを確認してください。', noEvidence);
  assert.ok(result);
  assert.ok(result.sources.some((s) => s.key === 'Claude セッション / 別窓'));
});

test('Bash を使っただけでは別窓の調査依頼を通さない(汎用ツールを万能キーにしない)', () => {
  const evidence = { names: new Set(['Bash']), inputs: JSON.stringify({ command: 'npm run build' }) };
  const result = findOutsourcedInvestigation('別のセッションが触っていないか確認してください。', evidence);
  assert.ok(result, 'Bash を使っただけで素通りしてはいけない');
  assert.ok(result.sources.some((s) => s.key === 'Claude セッション / 別窓'));
});

test('実際に transcript を grep していれば別窓の話は通る', () => {
  const evidence = {
    names: new Set(['Bash']),
    inputs: JSON.stringify({ command: 'grep -l cafe ~/.claude/projects/d--x/abc.jsonl' }),
  };
  assert.equal(findOutsourcedInvestigation('別のセッションが触っていないか確認してください。', evidence), null);
});

test('ListAgents を使っていれば別セッションの話は通る', () => {
  const evidence = { names: new Set(['ListAgents']), inputs: '' };
  assert.equal(findOutsourcedInvestigation('心当たりが無ければ別のセッションを確認してください。', evidence), null);
});

test('デプロイ状態の丸投げは curl を打っていなければ止める', () => {
  const evidence = { names: new Set(['Bash']), inputs: JSON.stringify({ command: 'git status' }) };
  const result = findOutsourcedInvestigation('本番に反映されているか確認して教えてください。', evidence);
  assert.ok(result);
  assert.ok(result.sources.some((s) => s.key === 'デプロイ / 外部サービスの状態'));
});

test('Vercel API を自分で叩いていればデプロイの話は通る', () => {
  const evidence = {
    names: new Set(['Bash']),
    inputs: JSON.stringify({ command: 'curl -s https://api.vercel.com/v9/projects/prj_x' }),
  };
  assert.equal(findOutsourcedInvestigation('本番に反映されているか確認して教えてください。', evidence), null);
});

test('素の [SELFCHECK-OK] では通らない', () => {
  const result = findOutsourcedInvestigation('登録メールが届いているか確認してください。[SELFCHECK-OK]', noEvidence);
  assert.ok(result);
  assert.equal(result.bareMarker, true);
  assert.match(formatViolationMessage(result), /だけでは通りません/);
});

test('理由付きの [SELFCHECK-OK: ...] なら通る', () => {
  const text = '登録メールが届いているか確認してください。[SELFCHECK-OK: 全セッションのトランスクリプトを grep して特定済み]';
  assert.equal(findOutsourcedInvestigation(text, noEvidence), null);
});

test('人にしかできない操作の依頼は止めない', () => {
  const text = 'ブラウザで同意してください。そのあと GitHub のリポジトリを確認してください。';
  assert.equal(findOutsourcedInvestigation(text, noEvidence), null);
});

test('コードブロック内の依頼表現は無視する', () => {
  assert.equal(findOutsourcedInvestigation('```\nメールが届いているか確認してください\n```\n\n以上です。', noEvidence), null);
});

test('引用行の依頼表現は無視する', () => {
  assert.equal(findOutsourcedInvestigation('> メールが届いているか確認してください\n\n対応済みです。', noEvidence), null);
});

test('hasEvidenceMarker / hasBareMarker の整合', () => {
  assert.equal(hasEvidenceMarker('[SELFCHECK-OK]'), false);
  assert.equal(hasBareMarker('[SELFCHECK-OK]'), true);
  assert.equal(hasEvidenceMarker('[SELFCHECK-OK: jsonl を grep して特定済み]'), true);
  assert.equal(hasBareMarker('[SELFCHECK-OK: jsonl を grep して特定済み]'), false);
});

test('splitParagraphs はコードフェンスと引用を落とす', () => {
  assert.deepEqual(splitParagraphs('本文A\n\n```\nコード\n```\n\n> 引用\n本文B'), ['本文A', '本文B']);
});

test('後方互換: Set を直接渡しても動く', () => {
  assert.equal(findOutsourcedInvestigation('登録メールが届いているか確認してください。', new Set(['mcp__claude_ai_Gmail__search_threads'])), null);
});

test('scanToolUses は tool_use の name と input を拾う', () => {
  const file = path.join(os.tmpdir(), 'selfcheck-transcript-' + process.pid + '.jsonl');
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'tasklist /FI "IMAGENAME eq node.exe"' } }] },
  });
  fs.writeFileSync(file, line + '\n', 'utf8');
  try {
    const { names, inputs } = scanToolUses(file);
    assert.ok(names.has('Bash'));
    assert.match(inputs, /tasklist/);
    assert.ok(scanToolNames(file).has('Bash'));
  } finally {
    fs.unlinkSync(file);
  }
});
