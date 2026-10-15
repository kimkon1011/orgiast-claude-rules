import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detect, firstMatch, selftest, scan, CONTROLS, maskDoneCommits } from './handoff-audit-commit-deferral-scan.mjs';

// 走査結果の「0 件」は、検出器が動いていなければ意味を持たない。
// 対照（陽性5・陰性5）が全通過することを先に固定する。
test('検出器の対照が全通過する（陽性5・陰性5）', () => {
  const r = selftest();
  assert.equal(r.passed, r.total, JSON.stringify(r.failures));
  assert.equal(r.total, 10);
  assert.ok(CONTROLS.some((c) => c.want === true), '陽性対照が無いと 0 件が無意味になる');
  assert.ok(CONTROLS.some((c) => c.want === false), '陰性対照が無いと常時 true の検出器を見逃す');
});

test('commit 語と「やっていない」標識が近接したときだけ陽性', () => {
  assert.equal(detect('残 TODO ⏳ 次回: `git commit`（指示により未実施）'), true);
  assert.equal(detect('この後の自動進行: なし（目的完了・コミットは指示範囲外のため保留）'), true);
  assert.equal(detect('4ファイルは未コミットのまま。'), true);
  assert.equal(detect('commit / push はしていません。'), true);
  assert.equal(detect('`git add` / `commit` は仕様通り未実施（そちらで実施）。'), true);
});

test('commit 自体が済んでいる言及は陽性にしない（実施済みのマスク）', () => {
  assert.equal(detect('5ファイルを実装し、`git commit` しました（aba3cba）。'), false, 'コミットしました は未実施ではない');
  assert.equal(detect('commit を実施し（aba3cba）、deploy は未実施です。'), false, 'deploy の未実施が commit に寄っても誤検出しない');
  assert.equal(detect('**ARTIFACTS**（commit `b80ad15`、ローカルのみ・remote 未設定）'), false, 'commit + ハッシュは実施済み');
  assert.equal(detect('**修正（commit `ed1115e`, 5ファイル）**'), false, '同上（別書式）');
});

test('否定形の「実施していません」はマスクせず未実施として拾う', () => {
  assert.equal(detect('コミットを実施していません。'), true, '実施＋否定は未実施');
  // マスク関数が否定形を伏せ字化しないことを直接確認
  assert.match(maskDoneCommits('コミットを実施していません'), /コミット/);
  assert.doesNotMatch(maskDoneCommits('コミットを実施しました'), /コミット/);
});

test('近接していなければ陽性にしない（離れた語の共起は対象外）', () => {
  const far = 'commit の話はここまで。' + 'あ'.repeat(120) + 'この deploy は行いません。';
  assert.equal(detect(far), false, '40 文字を超えて離れた語は共起としない');
});

test('監査TODO文そのもの（自セッションのプロンプト）は再発として数えない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-deferral-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const todo = '実装タスクの完了報告（コミットだけ指示範囲外で保留）[handoff-audit:585214efa82b1c11] 再発を検証する';
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'aaaaaaaa', excerpt: todo }) + '\n' +
    JSON.stringify({ ts: new Date().toISOString(), sessionId: 'bbbbbbbb', excerpt: '4ファイルは未コミットのまま。' }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.ledger.scanned, 2);
  assert.equal(r.hits, 1, 'TODO文を除外し、本物の1件だけを数える');
  assert.equal(r.rows[0].id, 'bbbbbbbb');
});

test('窓の外は数えない（窓の境界を実測値で固定する）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-deferral-scan-'));
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'handoff-audit-ledger.jsonl'),
    JSON.stringify({ ts: '2026-01-01T00:00:00Z', sessionId: 'old00000', excerpt: 'git commit は未実施。' }) + '\n');
  const r = scan({ home, since: Date.parse('2026-09-01T00:00:00Z') });
  assert.equal(r.ledger.total, 1);
  assert.equal(r.ledger.scanned, 0);
  assert.equal(r.hits, 0);
});

test('assistant 以外の turn は数えない（報告する側だけを見る）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-deferral-scan-'));
  const proj = path.join(home, '.claude', 'projects', 'p');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 's.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'git commit はしないでください。' } }) + '\n' +
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '4ファイルは未コミットのままです。' }] }, timestamp: new Date().toISOString() }) + '\n');
  const r = scan({ home, since: Date.now() - 86400_000 });
  assert.equal(r.hits, 1, 'user turn は数えず、assistant の1件だけを数える');
  assert.match(r.rows[0].match, /未コミット/);
});
