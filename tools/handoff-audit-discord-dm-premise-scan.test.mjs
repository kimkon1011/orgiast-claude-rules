import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { CONTROLS, detectLine, scanText, selftest } from './handoff-audit-discord-dm-premise-scan.mjs';

test('CONTROLS agree with detectLine', () => {
  for (const { id, line, want } of CONTROLS) assert.equal(detectLine(line), want, id);
});

test('selftest passes every control', () => {
  const result = selftest();
  assert.equal(result.passed, result.total);
  assert.deepEqual(result.failures, []);
});

test('scanText returns only matching lines and preserves metadata', () => {
  const result = scanText('無関係な行\n古川さんにも本人宛に PDF を DM で送ります。\n終了', { source: 'sample', ts: '2026-10-25T00:00:00Z' });
  assert.deepEqual(result, [{ source: 'sample', ts: '2026-10-25T00:00:00Z', line: '古川さんにも本人宛に PDF を DM で送ります。' }]);
});

test('scanText handles empty and null input', () => {
  assert.deepEqual(scanText(''), []);
  assert.deepEqual(scanText(null), []);
});

test('audit TODO and app feature lines are excluded', () => {
  assert.equal(detectLine(CONTROLS.find(({ id }) => id === 'N6').line), false);
  assert.equal(detectLine(CONTROLS.find(({ id }) => id === 'N1').line), false);
});

test('scanText truncates matching lines to 400 characters', () => {
  const line = `古川さんへ本人宛 PDF を DM で送ります。${'長'.repeat(500)}`;
  const [hit] = scanText(line);
  assert.equal(hit.line.length, 400);
});

// 2026-10-23 の原文（handoff-audit:c91e35b4bc3b7ee2「内部スタッフ宛DMの送信」）は
// 拡張前の判定では 1 つも拾えなかった（修飾語入りの送信宣言・自アカウント宛の証拠）。
test('原文（内部スタッフ宛DMの送信）を検出する', () => {
  assert.equal(detectLine('送信: 撤収の流れと一緒に、白川さん・大平さん・澤山さんのグループ DM に説明付きで送ります。'), true);
  assert.equal(detectLine('実際の送信は、同じ部品を使う持ち主宛ての DM 送信で行いました。'), true);
});

test('--selftest exits successfully', () => {
  const script = fileURLToPath(new URL('./handoff-audit-discord-dm-premise-scan.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--selftest'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
