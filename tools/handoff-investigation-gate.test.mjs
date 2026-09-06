import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const gate = fileURLToPath(new URL('./handoff-investigation-gate.mjs', import.meta.url));
const request = '管理画面で API トークンを発行してください。';
const complete = `${request}\n[手渡し判定]\n試したこと:\n  ① 未認証で API を実行 → 旧 API は 403\n  ② Gmail を検索 → 契約者情報を発見\nuser でないと無理な理由: アカウントへの初回ログインが必要`;

function run(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'investigation-gate-'));
  return spawnSync(process.execPath, [gate], {
    input: JSON.stringify({ session_id: 'test', assistant_text: text }),
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: root },
  });
}

test('手作業依頼なしは pass', () => assert.equal(run('調査は完了しました。').status, 0));
test('手作業依頼あり・証拠なしは不足項目を列挙して fail', () => {
  const result = run(request);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /不足: \[手渡し判定\] ブロック, 試したこと（または調査済み）の見出し, user でないと無理な理由（または本人しかできない理由）, 試行2件以上, 各試行の結果（→ または ⇒）/);
});
test('試行1件のみは fail', () => {
  const result = run(`${request}\n[手渡し判定]\n試したこと:\n① API を実行 → 403\nuser でないと無理な理由: 初回ログインが必要`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /試行2件以上/);
});
test('試行2件でも結果の矢印なしは fail', () => {
  const result = run(`${request}\n[手渡し判定]\n調査済み:\n- API を実行した\n- Gmail を検索した\n本人しかできない理由: 初回ログインが必要`);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /各試行の結果/);
});
test('完全な証拠は pass', () => assert.equal(run(complete).status, 0));
test('[INVESTIGATION-OK] は pass し ledger に免除を記録', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'investigation-bypass-'));
  const result = spawnSync(process.execPath, [gate], {
    input: JSON.stringify({ session_id: 'bypass', assistant_text: `${request}\n[INVESTIGATION-OK]` }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: root },
  });
  assert.equal(result.status, 0);
  const record = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'handoff-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'bypassed');
  assert.equal(record.reason, 'INVESTIGATION-OK');
});
test('Growi API トークン発行依頼の実文面を回帰検出', () => {
  const result = run('Growi の API トークンを発行してください');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /事前調査の証拠がありません/);
});
