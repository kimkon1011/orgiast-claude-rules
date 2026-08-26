import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeIndex } from './onboarding-sync.mjs';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'onboarding-sync.mjs');
const source = Buffer.from('# 見出し\r\n最初の文。二番目。\r\n本文\r\n🔴 絶対ルール全文\r\n## 次\r\n説明だけ\r\n🛑 上限規定', 'utf8');
function setup(initial) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-sync-'));
  const target = path.join(home, '.claude', 'CLAUDE.md');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (initial !== null) fs.writeFileSync(target, initial);
  return { home, target };
}
function run(f, extraArgs = [], envOverrides = {}) {
  const url = `data:text/markdown;base64,${source.toString('base64')}`;
  return spawnSync(process.execPath, [script, '--force', ...extraArgs, `--target=${f.target}`], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ONBOARDING_URL: url, ORGIAST_KEYSERVE_SECRET: '', ORGIAST_REPO: path.join(f.home, 'absent'), ...envOverrides } });
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
  assert.ok(fs.readFileSync(path.join(f.home, '.claude', 'orgiast-onboarding.md')).equals(source));
});
test('removes the legacy rules path', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f).status, 0); assert.equal(fs.existsSync(oldPath), false);
});
test('removes the legacy rules path even when synchronized content is unchanged', () => {
  const f = setup(null); assert.equal(run(f).status, 0);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f).status, 0); assert.equal(fs.existsSync(oldPath), false);
});
test('dry-run does not remove the legacy rules path', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f, ['--dry-run']).status, 0); assert.equal(fs.existsSync(oldPath), true);
});
test('moves the legacy file instead of losing it when the fetch fails', () => {
  const f = setup(null);
  const oldPath = path.join(f.home, '.claude', 'rules', 'orgiast-onboarding.md');
  const newPath = path.join(f.home, '.claude', 'orgiast-onboarding.md');
  fs.mkdirSync(path.dirname(oldPath), { recursive: true }); fs.writeFileSync(oldPath, source);
  assert.equal(run(f, [], { ORGIAST_ONBOARDING_URL: 'https://127.0.0.1:9/absent' }).status, 0);
  assert.equal(fs.existsSync(oldPath), false);
  assert.ok(fs.readFileSync(newPath).equals(source));
});
test('index lead points to the non-auto-loaded path', () => {
  const lead = makeIndex(source.toString('utf8')).split('\n')[0];
  assert.match(lead, /~\/.claude\/orgiast-onboarding\.md/);
  assert.doesNotMatch(lead, /~\/.claude\/rules\//);
  assert.match(lead, /自動ロードされない/);
  assert.match(lead, /Read ツール/);
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
