import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run as derive } from './memory-index-domains.mjs';
import { build } from './memory-index-split.mjs';

const script = fileURLToPath(new URL('./memory-index-domains.mjs', import.meta.url));

function fixture({ marker = true, orphan = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-domains-'));
  fs.mkdirSync(path.join(directory, 'index'));
  fs.writeFileSync(path.join(directory, 'MEMORY.md'), `${marker ? '<!-- MEMORY-INDEX v2 split -->\n' : ''}## 常に効くルール\n- [二](feedback_two.md)\n- [一](feedback_one.md)\n\n## ドメイン索引\n`);
  fs.writeFileSync(path.join(directory, 'feedback_one.md'), '---\ndescription: one\n---\n');
  fs.writeFileSync(path.join(directory, 'feedback_two.md'), '---\ndescription: two\n---\n');
  if (orphan) fs.writeFileSync(path.join(directory, 'feedback_orphan.md'), '---\ndescription: orphan\n---\n');
  fs.writeFileSync(path.join(directory, 'index', 'verify.md'), '- [一](../feedback_one.md)\n');
  fs.writeFileSync(path.join(directory, 'index', 'workstyle.md'), '- [二](../feedback_two.md)\n');
  return directory;
}

function invoke(directory, extra = []) {
  return spawnSync(process.execPath, [script, '--dir', directory, ...extra], { encoding: 'utf8' });
}

test('2索引と pin 2件を順序どおり導出する', () => {
  const directory = fixture();
  const domainsFile = path.join(directory, 'domains.json');
  const pinsFile = path.join(directory, 'pins.txt');
  const result = derive(['--dir', directory, '--out-domains', domainsFile, '--out-pins', pinsFile]);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(domainsFile, 'utf8')), { 'feedback_one.md': 'verify', 'feedback_two.md': 'workstyle' });
  assert.equal(fs.readFileSync(pinsFile, 'utf8'), 'feedback_two.md\nfeedback_one.md\n');
});

test('未分類は exit 1 で全ファイル名を出す', () => {
  const child = invoke(fixture({ orphan: true }));
  assert.equal(child.status, 1);
  assert.match(child.stderr, /未分類の memory ファイル \(1件\):[\s\S]*feedback_orphan\.md/);
});

test('--fallback で未分類を明示ドメインへ割り当てる', () => {
  const child = invoke(fixture({ orphan: true }), ['--fallback', 'reference']);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /未分類 1件を reference へ割当/);
  assert.equal(JSON.parse(child.stdout.slice(child.stdout.indexOf('{')))['feedback_orphan.md'], 'reference');
});

test('v2 マーカーが無ければ対象外 exit 2', () => {
  const child = invoke(fixture({ marker: false }));
  assert.equal(child.status, 2);
  assert.match(child.stderr, /対象外/);
});

test('複数ドメイン掲載は勝手に解消せず exit 1 にする', () => {
  const directory = fixture();
  fs.appendFileSync(path.join(directory, 'index', 'workstyle.md'), '- [重複](../feedback_one.md)\n');
  const child = invoke(directory);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /複数ドメインにある memory ファイル \(1件\):[\s\S]*feedback_one\.md/);
});

test('導出結果は split build の全網羅検証を通る', () => {
  const directory = fixture();
  const domainsFile = path.join(directory, 'domains.json');
  const pinsFile = path.join(directory, 'pins.txt');
  derive(['--dir', directory, '--out-domains', domainsFile, '--out-pins', pinsFile]);
  assert.doesNotThrow(() => build({ directory, domainsFile, pinsFile }));
});

test('shared サブ索引を未知扱いせず、配下の memory は分類対象にしない', () => {
  const directory = fixture();
  fs.mkdirSync(path.join(directory, 'shared'));
  fs.writeFileSync(path.join(directory, 'shared', 'foo.md'), 'shared memory\n');
  fs.writeFileSync(path.join(directory, 'index', 'shared.md'), '- [foo](../shared/foo.md)\n');

  const child = invoke(directory);

  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /未知のドメイン/);
});

test('DOMAINSにない外部サブ索引（リンク先が実在するが直下ではない）を未知扱いせず無視する', () => {
  const directory = fixture();
  fs.mkdirSync(path.join(directory, 'another_shared'));
  fs.writeFileSync(path.join(directory, 'another_shared', 'foo.md'), 'external memory\n');
  fs.writeFileSync(path.join(directory, 'index', 'another_shared.md'), '- [foo](../another_shared/foo.md)\n');

  const child = invoke(directory);

  assert.equal(child.status, 0, child.stderr);
  assert.doesNotMatch(child.stderr, /未知のドメイン/);
});
