import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeIndex } from './onboarding-sync.mjs';

test('配布する実文書の索引が8000bytes以下で結論と新規約を含む', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const index = makeIndex(body);
  assert(Buffer.byteLength(index) <= 8000, `${Buffer.byteLength(index)} bytes`);
  for (const line of body.split(/\r?\n/).filter(l => /^\*{0,2}\s*(?:🔴|🛑|⚙️|🔁)/u.test(l))) assert([...line].length <= 200, line);
  assert.match(index, /副作用・影響は報告で終わらせず、その場で直す/);
  assert.match(index, /1\.20 auto mode classifier/);
  assert.match(index, /effortLevel.*medium/);
  assert.match(index, /planIncluded.*監督.*全用途禁止/);
  assert.match(index, /setup --converge.*allow/);
  assert.doesNotMatch(index, /丸1日|1-00:57|コマンド置換として実行/);
  const appendix = body.split('## 付録: 事故履歴と根拠')[1];
  assert(appendix);
  assert.doesNotMatch(appendix, /^### /m);
  assert.match(appendix, /1-00:57/);
});


test('索引は日付付き由来だけを圧縮し、規約と通常の括弧は保持する', () => {
  const source = '### 副作用は直す（kim 2026-10-17 厳命・全PC全アカウント・絶対）\nこのターンで修正する。\n### 設定（既存PCも対象）\n照会する。';
  const index = makeIndex(source);
  assert.match(index, /### 副作用は直す\nこのターンで修正する。/);
  assert.match(index, /### 設定（既存PCも対象）/);
  assert.doesNotMatch(index, /2026-10-17/);
});
