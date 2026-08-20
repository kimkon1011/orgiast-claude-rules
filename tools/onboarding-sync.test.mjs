import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboarding-sync.mjs');
const source = Buffer.from('# 見出し\r\n最初の文。二番目。\r\n本文\r\n🔴 絶対ルール全文\r\n## 次\r\n説明だけ\r\n🛑 上限規定', 'utf8');
function setup(initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-sync-'));
  const target = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (initial !== null) fs.writeFileSync(target, initial);
  return { home, target };
}
function run(f) {
  const url = `data:text/markdown;base64,${source.toString('base64')}`;
  return spawnSync(process.execPath, [script, '--force', `--target=${f.target}`], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(f.home, 'absent') } });
}

test('preserves bytes outside existing markers', () => {
  const before = Buffer.from('個人\r\n<!-- BEGIN: オージャスト共通ルール (自動同期 2026-01-01) -->\r\n旧本文\r\n<!-- END: オージャスト共通ルール -->\r\n末尾\r\n');
  const f = setup(before); assert.equal(run(f).status, 0);
  const updated = fs.readFileSync(f.target);
  assert.ok(updated.subarray(0, Buffer.byteLength('個人\r\n')).equals(Buffer.from('個人\r\n')));
  assert.ok(updated.subarray(updated.length - Buffer.byteLength('\r\n末尾\r\n')).equals(Buffer.from('\r\n末尾\r\n')));
});
test('stores fetched onboarding byte-for-byte', () => {
  const f = setup(null); run(f);
  assert.ok(fs.readFileSync(path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md')).equals(source));
});
test('index retains critical emoji lines', () => {
  const f = setup(null); run(f); const output = fs.readFileSync(f.target, 'utf8');
  assert.match(output, /🔴 絶対ルール全文/); assert.match(output, /🛑 上限規定/); assert.doesNotMatch(output, /二番目/);
});
test('two runs are idempotent', () => {
  const f = setup('外側\n'); run(f); const once = fs.readFileSync(f.target); run(f); const twice = fs.readFileSync(f.target);
  assert.ok(once.equals(twice));
});
test('CLAUDE.md without markers is preserved and receives one block', () => {
  const f = setup(Buffer.from('個人ルール\r\nそのまま', 'utf8')); run(f); const output = fs.readFileSync(f.target, 'utf8');
  assert.ok(output.startsWith('個人ルール\r\nそのまま')); assert.equal((output.match(/BEGIN: オージャスト共通ルール/g) || []).length, 1);
});
