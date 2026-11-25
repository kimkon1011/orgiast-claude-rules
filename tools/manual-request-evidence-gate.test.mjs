// manual-request-evidence-gate.mjs の実挙動テスト（judge() 単体ではなく stdin→stdout の契約を見る）。
// なぜ: Stop hook は「transcript のどこを読むか」で壊れる。実際、委譲実装は末尾から遡って
// 集めていたため "1つ前のターン" を読んでいた。judge() のテストだけでは絶対に見つからない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manual-request-evidence-gate.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'evidence-test-'));

const BAD = `ブラウザで https://www.airbnb.jp/hosting/listings を開いてください。
1. 「Isaoさんのアパートメント」をクリックします。
2. 上のタブから「予約設定」を選びます。
3. 「事前予告」を「1日前まで」に変えて保存してください。
成功すると「1日前まで」と表示されます。表示されない場合は画面のスクショを貼ってください。`;

const GOOD_UNVERIFIED = BAD + '\n' + '未確認: Airbnb ホスト画面のラベルと現在値は見ていません。違う場合はスクショをください';
const GOOD_VERIFIED   = BAD + '\n' + '確認済み: analysis/verify-airbnb.png を自分で開いて目視（verify-live.mjs exit 1）';
const ESCAPED         = BAD + '\n' + '[SCREEN-UNSEEN-OK]';

function run(entries, { stopHookActive = false } = {}) {
  const tp = path.join(tmp, `t${Math.round(entries.length * 1e6) % 1e6}-${entries[0].type}.jsonl`);
  writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

const userLine = (text) => ({ type: 'user', message: { content: text } });
const asstLine = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('根拠行なしの依頼 → block', () => {
  const { out, status } = run([userLine('これ'), asstLine(BAD)]);
  assert.ok(out.includes('"decision":"block"'), `stdout: ${out}`);
  assert.equal(status, 0);
});

test('GOOD_UNVERIFIED → 何も出ない', () => {
  const { out, status } = run([userLine('これ'), asstLine(GOOD_UNVERIFIED)]);
  assert.equal(out, '');
  assert.equal(status, 0);
});

test('GOOD_VERIFIED → 何も出ない', () => {
  const { out, status } = run([userLine('これ'), asstLine(GOOD_VERIFIED)]);
  assert.equal(out, '');
  assert.equal(status, 0);
});

test('ESCAPED → 何も出ない', () => {
  const { out, status } = run([userLine('これ'), asstLine(ESCAPED)]);
  assert.equal(out, '');
  assert.equal(status, 0);
});

test('前のターンの不備では止めない', () => {
  const { out, status } = run([userLine('a'), asstLine(BAD), userLine('b'), asstLine('直しました。')]);
  assert.equal(out, '');
  assert.equal(status, 0);
});

test('stop_hook_active: true なら BAD でも何も出ない', () => {
  const { out, status } = run([userLine('x'), asstLine(BAD)], { stopHookActive: true });
  assert.equal(out, '');
  assert.equal(status, 0);
});

test('transcript_path が存在しないパス → fail-open', () => {
  const { out, status } = run([userLine('x'), asstLine(BAD)], { stopHookActive: false });
  // 上のは存在するので、存在しないパスを直接試す
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: false, transcript_path: path.join(tmp, 'nonexistent.jsonl') }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal((r.stdout || '').trim(), '');
  assert.equal(r.status, 0);
});

test('transcript の行が壊れた JSON でも fail-open（block を出さない）', () => {
  const tp = path.join(tmp, 'broken.jsonl');
  writeFileSync(tp, '{"type":"user","message":{"content":"x"}}\n{broken json}\n', 'utf8');
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: false, transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal((r.stdout || '').trim(), '');
  assert.equal(r.status, 0);
});
