import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, proseOf } from './org-instructions-char-gate.mjs';

test('組織指示＋追記の言及あり、[ORG-CHARS] なし → block', () => {
  const text = '組織指示の末尾に追記案を貼ってください。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ORG-CHARS');
});

test('組織指示＋貼るの言及あり、[ORG-CHARS] なし → block', () => {
  const text = '組織の指示に新しいルールを貼ります。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ORG-CHARS');
});

test('組織指示＋貼り付けの言及あり、[ORG-CHARS] なし → block', () => {
  const text = '組織指示に貼り付けました。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ORG-CHARS');
});

test('組織指示＋書き足すの言及あり、[ORG-CHARS] なし → block', () => {
  const text = '組織の指示に書き足しました。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ORG-CHARS');
});

test('[ORG-CHARS] あり・2,800字以内 → pass', () => {
  const text = '組織指示の末尾に追記案を貼ります。[ORG-CHARS: 2005/3000]';
  const result = judge(text);
  assert.equal(result.decision, 'pass');
});

test('[ORG-CHARS] あり・2,800字超・全文差し替えあり → pass', () => {
  const text = '組織指示の末尾に追記案を貼ります。[ORG-CHARS: 2950/3000]\n\n全文差し替えで短縮版を渡します。';
  const result = judge(text);
  assert.equal(result.decision, 'pass');
});

test('[ORG-CHARS] あり・2,800字超・全文差し替えなし → block', () => {
  const text = '組織指示の末尾に追記案を貼ります。[ORG-CHARS: 2950/3000]';
  const result = judge(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ORG-CHARS-FULL');
});

test('組織指示に無関係な文 → pass', () => {
  const text = '今日の作業はデプロイとテストです。バグ修正も行いました。';
  const result = judge(text);
  assert.equal(result.decision, 'pass');
});

test('組織指示の話だが追記ではない → pass', () => {
  const text = '組織の指示について調べました。上限は3,000字です。';
  const result = judge(text);
  assert.equal(result.decision, 'pass');
});

test('空文字 → pass', () => {
  assert.equal(judge('').decision, 'pass');
});

test('コードブロック内の組織指示＋追記は proseOf で除去される', () => {
  const text = 'コードブロックの中です。\n```\n組織指示に追記してください。\n```';
  // コードブロック除去後は組織指示のキーワードが無いので pass
  const result = judge(text);
  assert.equal(result.decision, 'pass');
});

test('Ctrl+A だけでは全文差し替えの明示を代用できない', () => {
  const text = '組織指示の末尾に追記案を貼ります。[ORG-CHARS: 2950/3000]\n\nCtrl+A で貼り替えます。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
});

test('貼り替えだけでは全文差し替えの明示を代用できない', () => {
  const text = '組織指示の末尾に追記案を貼ります。[ORG-CHARS: 2900/3000]\n\n貼り替え用の短縮版です。';
  const result = judge(text);
  assert.equal(result.decision, 'block');
});

test('proseOf はコードブロック・インラインコード・URL を除去する', () => {
  const text = [
    '組織指示に```\n追記\n```を',
    '`貼って` と',
    'https://example.com/org/instructions を参照',
  ].join(' ');
  const prose = proseOf(text);
  assert.ok(!prose.includes('追記'));
  assert.ok(!prose.includes('貼って'));
  assert.ok(!prose.includes('https://'));
});
// Stop payload と実際の子プロセス経由でも判定されることを確認する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rolloutMode } from './gate-runtime.mjs';

function runGate(input) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./org-instructions-char-gate.mjs', import.meta.url))], {
    input: JSON.stringify(input), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() ? JSON.parse(result.stdout) : { decision: 'pass' };
}

test('Stop の last_assistant_message を判定する', () => {
  assert.equal(runGate({ last_assistant_message: '組織指示に追記してください。' }).decision, 'block');
  assert.equal(runGate({ last_assistant_message: '組織指示に追記。[ORG-CHARS: 2005/3000]' }).decision, 'pass');
});

test('Stop の transcript_path から最後の応答を読む', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'org-chars-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '組織の指示に貼ってください。' }] } }) + '\n');
  assert.equal(runGate({ transcript_path: transcript }).decision, 'block');
});

test('2800字は通り、2801字は全文差し替えを要求する', () => {
  assert.equal(judge('組織指示に追記。[ORG-CHARS: 2800/3000]').decision, 'pass');
  assert.equal(judge('組織指示に追記。[ORG-CHARS: 2801/3000]').decision, 'block');
});

test('配布登録と全席での block 設定が揃っている', () => {
  const read = name => JSON.parse(fs.readFileSync(new URL(name, import.meta.url), 'utf8'));
  const dispatch = read('./hook-dispatch-manifest.json');
  assert.equal(dispatch.events.Stop.filter(hook => hook.command.includes('/org-instructions-char-gate.mjs')).length, 1);
  const setup = read('./setup-manifest.json');
  const item = setup.items.find(item => item.id === 'settings:org-instructions-char-gate');
  assert.equal(item.spec.hookEvent, 'Stop');
  assert.equal(item.spec.hookRunner, 'gate-hook-runner.mjs');
  const manifest = read('./gate-rollout-manifest.json');
  assert.equal(rolloutMode('org-instructions-char-gate', { manifest, hostname: 'non-pilot-test-host' }), 'deny');
});
