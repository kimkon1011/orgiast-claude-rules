import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-selfcheck-'));
const originalHome = process.env.ORGIAST_HOME;
process.env.ORGIAST_HOME = path.join(root, 'home');
const { missingScheduledTasks, missingSkills, shouldRunTaskSelfcheck } = await import('./hook-selfcheck.mjs');

after(() => {
  if (originalHome === undefined) delete process.env.ORGIAST_HOME;
  else process.env.ORGIAST_HOME = originalHome;
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(name) {
  const base = path.join(root, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { repo, home };
}

function addRepoSkill(repo, name) {
  fs.mkdirSync(path.join(repo, 'skills', name), { recursive: true });
}

function deploySkill(home, name) {
  const dir = path.join(home, '.claude', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), 'deployed\n');
}

test('未配備の skill 名だけを返す', () => {
  const { repo, home } = fixture('missing');
  addRepoSkill(repo, 'a');
  addRepoSkill(repo, 'b');
  deploySkill(home, 'a');
  assert.deepEqual(missingSkills({ home, repo }), ['b']);
});

test('全 skill が配備済みなら空配列を返す', () => {
  const { repo, home } = fixture('complete');
  addRepoSkill(repo, 'a');
  addRepoSkill(repo, 'b');
  deploySkill(home, 'a');
  deploySkill(home, 'b');
  assert.deepEqual(missingSkills({ home, repo }), []);
});

test('repo に skills ディレクトリがなくても空配列を返す', () => {
  const { repo, home } = fixture('no-skills');
  assert.doesNotThrow(() => missingSkills({ home, repo }));
  assert.deepEqual(missingSkills({ home, repo }), []);
});

test('登録済みタスクから欠落している必須タスクだけを返す', () => {
  const required = [
    ['OrgiastAutoSession', 'tools/register-auto-session.ps1'],
    ['OrgiastNightlyBatch', 'tools/nightly-batch.ps1'],
  ];
  assert.deepEqual(missingScheduledTasks(['OrgiastAutoSession'], required), [required[1]]);
});

test('必須タスクがすべて登録済みなら空配列を返す', () => {
  assert.deepEqual(missingScheduledTasks(['OrgiastAutoSession']), []);
});

test('タスク名は大文字小文字と schtasks の先頭バックスラッシュを区別しない', () => {
  assert.deepEqual(missingScheduledTasks(['\\ORGIASTAUTOSESSION']), []);
});

test('タスク自己チェックは最終実行から20時間以内ならスキップする', () => {
  const now = Date.UTC(2026, 7, 26, 12);
  assert.equal(shouldRunTaskSelfcheck(now - (20 * 60 * 60 * 1000) + 1, now), false);
  assert.equal(shouldRunTaskSelfcheck(now - (20 * 60 * 60 * 1000), now), true);
  assert.equal(shouldRunTaskSelfcheck(undefined, now), true);
});
