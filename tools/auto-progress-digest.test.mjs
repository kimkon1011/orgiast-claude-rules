import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDigest } from './auto-progress-digest.mjs';
const base = { status: 'waiting_user', promise: '返信を確認して報告する', ts: '2026-10-28T00:00:00Z', cwd: '/projects/same' };
test('decision owner separates identical actions and counts', () => {
  const text = formatDigest([
    { ...base, sessionId: 'owner', nextKim: '設定を保存してください' },
    { ...base, sessionId: 'kim', nextKim: '設定を保存してください', reason: 'kim-PC 決定ID 123' },
  ]);
  assert.match(text, /あなたの判断待ち 1件・kim の判断待ち 1件/);
  assert.match(text, /・あなたの判断待ち: ［same］返信を確認して報告する/);
  assert.match(text, /  → 判断してほしいこと: 設定を保存してください/);
  assert.match(text, /・kim の判断待ち（あなたの操作は不要）: ［same］設定を保存してください/);
});
test('waiting rows show the decision text in full (up to 400) on its own line', () => {
  const text = formatDigest([{ ...base, nextKim: '操'.repeat(401), promise: '約'.repeat(81) }]);
  assert.ok(text.includes('操'.repeat(400)));
  assert.ok(!text.includes('操'.repeat(401)));
  // 約束は60字に縮め、判断内容は改行して独立の行に出す
  assert.ok(text.includes('約'.repeat(60)));
  assert.ok(!text.includes('約'.repeat(61)));
  assert.ok(text.includes('\n  → 判断してほしいこと: 操'));
});
test('empty nextKim falls back to promise even without action keywords', () => {
  const text = formatDigest([{ ...base, nextKim: '' }]);
  assert.match(text, /あなたの判断待ち 1件/);
  assert.match(text, /・あなたの判断待ち: ［same］返信を確認して報告する/);
});
test('choice warning is visible and ledger row stays unchanged', () => {
  const row = { ...base, nextKim: 'A) 続行 B) 停止。1択で指示してください' };
  const before = JSON.stringify(row);
  const text = formatDigest([row]);
  assert.match(text, /⚠ 選択肢形式（Claude が推奨案で決めるべき内容）/);
  assert.match(text, /  → 判断してほしいこと: A\) 続行 B\) 停止/);
  assert.equal(JSON.stringify(row), before);
});
