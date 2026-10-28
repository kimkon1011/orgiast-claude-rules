import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  countPolicyDenials, policyDenialKey, loadPolicyDenials, savePolicyDenials,
  hasRecentPolicyDenial, recordPolicyDenial, prunePolicyDenials,
  POLICY_DENIALS_STORE, POLICY_STALL_MIN_DENIALS
} from './codex-do.mjs';

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('countPolicyDenials は拒否文字列の出現回数を数える', () => {
  assert.equal(countPolicyDenials(''), 0);
  assert.equal(countPolicyDenials('tool execution denied by policy'), 1);
  assert.equal(countPolicyDenials('a tool execution denied by policy b tool execution denied by policy'), 2);
  assert.equal(countPolicyDenials(undefined), 0);
  assert.equal(countPolicyDenials(null), 0);
});

test('policyDenialKey は同一コマンドで同一キー、異なるコマンドで異なるキーを返す', () => {
  const a = policyDenialKey('git commit -m test');
  const b = policyDenialKey('git commit -m test');
  const c = policyDenialKey('git commit -m other');
  assert.ok(a);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(policyDenialKey(''), null);
  assert.equal(policyDenialKey(undefined), null);
});

test('recordPolicyDenial と hasRecentPolicyDenial は台帳を永続化して省略判定できる', (t) => {
  const home = tmpHome(t);
  const cmd = 'node tools/do-something.mjs';
  // 記録前は省略されない
  assert.equal(hasRecentPolicyDenial(cmd, { home }).denied, false);
  // 1回記録 → 閾値(POLICY_STALL_MIN_DENIALS=3)未満なので省略されない
  recordPolicyDenial(cmd, 1, 'gemini-cli', { home });
  assert.equal(hasRecentPolicyDenial(cmd, { home }).denied, false);
  assert.equal(hasRecentPolicyDenial(cmd, { home }).record.count, 1);
  // 同じコマンドで再度記録 → 加算される
  recordPolicyDenial(cmd, 2, 'gemini-cli', { home });
  const hit = hasRecentPolicyDenial(cmd, { home });
  assert.equal(hit.denied, true);
  assert.equal(hit.record.count, 3);
  assert.equal(hit.record.lastBackend, 'gemini-cli');
  // 台帳ファイルが実際に書かれる
  const file = path.join(home, '.claude', POLICY_DENIALS_STORE);
  assert.ok(fs.existsSync(file));
  const store = JSON.parse(fs.readFileSync(file, 'utf8'));
  const key = policyDenialKey(cmd);
  assert.equal(store[key].count, 3);
});

test('hasRecentPolicyDenial は期限切れ(1時間超)の記録を省略しない', (t) => {
  const home = tmpHome(t);
  const cmd = 'recent-cmd';
  const key = policyDenialKey(cmd);
  // 直接台帳を書き、2時間前の記録を作る
  savePolicyDenials({
    [key]: { command: cmd, count: 5, firstSeen: new Date(Date.now() - 7200_000).toISOString(), lastSeen: new Date(Date.now() - 7200_000).toISOString(), lastBackend: 'gemini-cli' }
  }, { home });
  const result = hasRecentPolicyDenial(cmd, { home });
  assert.equal(result.denied, false);
  assert.ok(result.record); // 期限切れでも記録自体は返す
});

test('prunePolicyDenials は古くて回数が少ない記録を削除する', (t) => {
  const home = tmpHome(t);
  const cmdOld = 'old-lost-cmd';
  const cmdRecent = 'recent-cmd';
  const keyOld = policyDenialKey(cmdOld);
  const keyRecent = policyDenialKey(cmdRecent);
  // 古い(2時間前) だが count=1(削除対象)
  savePolicyDenials({
    [keyOld]: { command: cmdOld, count: 1, firstSeen: '2026-01-01T00:00:00Z', lastSeen: new Date(Date.now() - 7200_000).toISOString(), lastBackend: 'gemini-cli' },
    [keyRecent]: { command: cmdRecent, count: 2, firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), lastBackend: 'gemini-cli' }
  }, { home });
  const result = prunePolicyDenials({ home });
  assert.equal(result.pruned, true);
  const store = loadPolicyDenials({ home });
  assert.ok(!store[keyOld]);  // 古くて少ない → 削除
  assert.ok(store[keyRecent]); // 最近 → 残る
});

test('recordPolicyDenial は cwd/コマンドが違っても台帳が壊れない', (t) => {
  const home = tmpHome(t);
  recordPolicyDenial('cmd-a', 3, 'gemini-cli', { home });
  recordPolicyDenial('cmd-b', 2, 'gemini-cli', { home });
  const store = loadPolicyDenials({ home });
  assert.equal(Object.keys(store).length, 2);
  recordPolicyDenial('cmd-a', 1, 'qwen', { home });
  assert.equal(loadPolicyDenials({ home })[policyDenialKey('cmd-a')].count, 4);
});
