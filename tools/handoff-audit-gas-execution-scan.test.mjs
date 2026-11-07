import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROLS, detect, firstMatch, scan, selftest, stripBanners } from './handoff-audit-gas-execution-scan.mjs';

test('陽性6・陰性6の対照が全通過する', () => {
  const result = selftest();
  assert.equal(result.total, 12);
  assert.equal(result.passed, result.total, JSON.stringify(result.failures));
  assert.equal(CONTROLS.filter((c) => c.want).length, 6);
  assert.equal(CONTROLS.filter((c) => !c.want).length, 6);
});

test('GAS実行語と手渡し語が120文字以内なら陽性', () => {
  assert.equal(detect('clasp run で setup を実行してください'), true);
  assert.equal(detect('担当者' + 'あ'.repeat(120) + 'CommandQueue'), true);
  assert.match(firstMatch('clasp run で setup を実行してください'), /clasp run.*してください/);
});

test('共起しても120文字を超えて離れていれば陰性', () => {
  assert.equal(detect('担当者' + 'あ'.repeat(121) + 'CommandQueue'), false);
});

test('GAS は実行または反映が12文字以内にある場合だけ実行語になる', () => {
  assert.equal(detect('GAS を実行してください'), true);
  assert.equal(detect('GAS' + 'あ'.repeat(13) + '実行してください'), false);
  assert.equal(detect('GAS のトリガー一覧を確認してください'), false);
});

test('自己引用と解決済みの記述を除外する', () => {
  assert.equal(detect('[handoff-audit:2a521d8efb465e3a] CommandQueue を代行してください'), false);
  assert.equal(detect('GAS の関数実行が要る。CommandQueue は担当者へ依頼'), false);
  assert.equal(detect('kim-PC に頼まずに CommandQueue を実行しました'), false);
  assert.equal(detect('GAS は人手は不要で、こちらから実行して完了'), false);
  assert.equal(detect('▶ 実行してください'), true, '違反そのものは解決済み除外しない');
});

test('委譲判定バナーは落とすが、本文の違反は残す', () => {
  const only = '**[委譲判定]** GAS 実行は担当者へ依頼';
  assert.equal(detect(only), false);
  assert.equal(stripBanners(only).trim(), '');
  assert.equal(detect(`${only}\nCommandQueue の実行を kim-PC に依頼`), true);
});

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-execution-scan-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  return home;
}

test('2種類のledgerを読み、excerptとtextからhitを返す', () => {
  const home = makeHome();
  const dir = path.join(home, '.claude');
  const ts = '2026-10-12T00:00:00Z';
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'), JSON.stringify({ ts, sessionId: 'aaaaaaaa1', excerpt: 'clasp run で反映を担当者に依頼' }) + '\n');
  fs.writeFileSync(path.join(dir, 'stop-gate-runner-ledger.jsonl'), JSON.stringify({ ts, id: 'bbbbbbbb2', text: 'CommandQueue の実行を kim-PC に代行してもらう' }) + '\n');
  const result = scan({ home, since: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(result.ledger.total, 2);
  assert.equal(result.ledger.scanned, 2);
  assert.deepEqual(result.ledger.perFile['handoff-audit-ledger.jsonl'], { total: 1, scanned: 1 });
  assert.deepEqual(result.ledger.perFile['stop-gate-runner-ledger.jsonl'], { total: 1, scanned: 1 });
  assert.equal(result.hits, 2);
  assert.deepEqual(result.rows.map((r) => r.src), ['ledger', 'runner-ledger']);
});

test('transcriptはassistantのtextブロックだけを走査する', () => {
  const home = makeHome();
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  const ts = '2026-10-12T00:00:00Z';
  fs.writeFileSync(path.join(proj, 's.jsonl'), [
    { type: 'user', timestamp: ts, message: { role: 'user', content: 'CommandQueue を kim-PC に代行してください' } },
    { type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: '▶ 実行 をクリックしてください' }, { type: 'tool_use', text: '無視' }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const result = scan({ home, since: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(result.transcript.files, 1);
  assert.equal(result.transcript.filesScanned, 1);
  assert.equal(result.transcript.turnsScanned, 1);
  assert.equal(result.hits, 1);
  assert.equal(result.rows[0].src, 'transcript');
});

test('--since相当の窓判定はledgerとtranscriptのturn時刻に効く', () => {
  const home = makeHome();
  const dir = path.join(home, '.claude');
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'), [
    { ts: '2026-09-30T23:59:59Z', sessionId: 'old', excerpt: 'CommandQueue を kim-PC に代行依頼' },
    { ts: '2026-10-01T00:00:00Z', sessionId: 'new', excerpt: 'CommandQueue を kim-PC に代行依頼' },
  ].map(JSON.stringify).join('\n') + '\n');
  const proj = path.join(dir, 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'), [
    { type: 'assistant', timestamp: '2026-09-30T23:59:59Z', message: { role: 'assistant', content: '▶ 実行してください' } },
    { type: 'assistant', timestamp: '2026-10-01T00:00:00Z', message: { role: 'assistant', content: '▶ 実行してください' } },
  ].map(JSON.stringify).join('\n') + '\n');
  const result = scan({ home, since: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(result.ledger.total, 2);
  assert.equal(result.ledger.scanned, 1);
  assert.equal(result.transcript.turnsScanned, 2, 'mtimeでファイルを読むが、各turnはpush時に時刻判定する');
  assert.equal(result.hits, 2);
  assert.ok(result.rows.every((row) => row.ts === '2026-10-01T00:00:00Z'));
});

test('rowのtextは320文字で切る', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, '.claude', 'handoff-audit-ledger.jsonl'), JSON.stringify({
    ts: '2026-10-12T00:00:00Z', sessionId: 'long', excerpt: `CommandQueue を担当者に依頼 ${'あ'.repeat(500)}`,
  }) + '\n');
  const result = scan({ home, since: Date.parse('2026-10-01T00:00:00Z') });
  assert.equal(result.rows[0].text.length, 320);
});
