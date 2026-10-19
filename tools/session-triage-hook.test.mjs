import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./session-triage-hook.mjs', import.meta.url));
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(homeDir) {
  return spawnSync(process.execPath, [script], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: homeDir } });
}

test('作り置きが無ければ何も出力せず終了する', t => {
  const result = run(home(t));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('要対応行を additionalContext として出力しガードを書く', t => {
  const dir = home(t);
  const claude = path.join(dir, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'session-triage.md'), [
    '生成時刻 2026-10-19T00:00:00Z',
    '| 分類 | 表示名 | 更新 | cwd | 次アクション | 再開 | 検索語 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    '| 🔴 要対応 | 内藤さんの会議の続き | 10/18 | C:\\work | 続きを実装 | `code c:\\work` | 内藤さんの会議 |',
  ].join('\n'), 'utf8');
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /内藤さんの会議の続き/);
  assert.match(output.hookSpecificOutput.additionalContext, /検索語「内藤さんの会議」/);
  assert.ok(fs.existsSync(path.join(claude, '.session-triage-shown')));
  // 2回目は20時間ガードで出力しない。
  assert.equal(run(dir).stdout, '');
});
