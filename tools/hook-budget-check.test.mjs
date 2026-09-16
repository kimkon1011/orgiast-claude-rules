import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendLedger, extractSessionStartHooks, groupBatches, hookNameFromCommand, projectSlug, renderWarning, summarize } from './hook-budget-check.mjs';

const settings = (...groups) => ({ hooks: { SessionStart: groups.map((hooks) => ({ hooks })) } });
const configured = (name, timeout = 10) => ({ command: `node "C:\\repo\\tools\\${name}"`, timeout });
const measured = (name, durationMs, toolUseID = 'new', timestamp = '2026-09-14T00:00:00Z', exitCode = 0) => ({ command: `node "/repo/tools/${name}"`, durationMs, toolUseID, timestamp, exitCode });

test('project slug と command の実行ファイル名', () => {
  assert.equal(projectSlug('c:\\Users\\uers\\Downloads\\CLAUDE.md配布'), 'c--Users-uers-Downloads-CLAUDE-md--');
  assert.equal(hookNameFromCommand('pwsh -File "C:\\x\\bar.ps1"'), 'bar.ps1');
});

test('入れ子の SessionStart hook を抽出する', () => {
  const line = JSON.stringify({ timestamp: '2026-09-14T01:00:00Z', nested: { value: { type: 'hook_success', hookEvent: 'SessionStart', command: 'node "foo.mjs"', durationMs: 2206, exitCode: 1, toolUseID: 'id' } } });
  assert.deepEqual(extractSessionStartHooks(line), [{ command: 'node "foo.mjs"', durationMs: 2206, exitCode: 1, toolUseID: 'id', timestamp: '2026-09-14T01:00:00Z' }]);
});

test('toolUseID でまとまり最新バッチが末尾になる', () => {
  const groups = groupBatches([measured('old.mjs', 1, 'old', '2026-01-01T00:00:00Z'), measured('a.mjs', 2), measured('b.mjs', 3)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.at(-1).hooks.map((hook) => hookNameFromCommand(hook.command)), ['a.mjs', 'b.mjs']);
});

test('同一 toolUseID バッチの criticalPath は実測最大値', () => {
  const batch = { hooks: [measured('a.mjs', 1000), measured('b.mjs', 3000), measured('c.mjs', 2000)] };
  const result = summarize(batch, settings([configured('a.mjs'), configured('b.mjs')], [configured('c.mjs')]));
  assert.equal(result.serialSumMs, 6000);
  assert.equal(result.criticalPathMs, 3000);
});

test('未計測は情報だけを保持し、自分自身は除外する', () => {
  const result = summarize({ hooks: [measured('a.mjs', 1000)] }, settings([configured('a.mjs'), configured('missing.mjs', 7), configured('hook-budget-check.mjs', 10)]));
  assert.equal('assumedMs' in result, false);
  assert.equal('estimatedTotalMs' in result, false);
  assert.deepEqual(result.unmeasured, [{ name: 'missing.mjs', timeoutSec: 7, async: false }]);
});

test('durationMs / command のない SessionStart 幽霊エントリを無視する', () => {
  const records = [2206, 3006, 2998, 3032, 3817, 4952, 5391, 6538].map((durationMs, i) => ({
    timestamp: '2026-09-13T20:31:01.134Z',
    nested: { hookEvent: 'SessionStart', ...measured(`real-${i}.mjs`, durationMs, '086b67e1-63b3-492b-b41d-b1f13b7a37c6') },
  }));
  records.push({ timestamp: '2026-09-13T20:31:05.445Z', nested: {
    toolUseID: 'SessionStart', hookSpecificOutput: { hookEvent: 'SessionStart' },
  } });
  const hooks = extractSessionStartHooks(records.map(JSON.stringify).join('\n'));
  assert.equal(hooks.length, 8);
  const batches = groupBatches(hooks);
  assert.equal(batches.length, 1);
  assert.equal(batches.at(-1).toolUseID, '086b67e1-63b3-492b-b41d-b1f13b7a37c6');
  const result = summarize(batches.at(-1));
  assert.equal(result.serialSumMs, 31940);
  assert.equal(result.criticalPathMs, 6538);
  assert.equal(result.over, false);
});

test('有限数の durationMs と空でない command だけを計測として抽出する', () => {
  const valid = { hookEvent: 'SessionStart', ...measured('real.mjs', 0) };
  const invalid = [
    ...[undefined, null, '123', NaN, Infinity, -Infinity].map(durationMs => ({ ...valid, durationMs })),
    ...[undefined, null, 123, '', ' \t\n'].map(command => ({ ...valid, command })),
  ];
  assert.equal(extractSessionStartHooks(invalid).length, 0);
  assert.equal(extractSessionStartHooks([...invalid, valid]).length, 1);
});

test('有効計測 0 件は no-data で警告しない', () => {
  const result = summarize({ hooks: [] }, settings([configured('missing.mjs', 289)]));
  assert.equal(result.status, 'no-data');
  assert.equal(result.over, false);
  assert.equal(result.strongWarning, false);
});

test('未計測 29 本の timeout は 6.5 秒の実測判定に影響しない', () => {
  const missing = Array.from({ length: 29 }, (_, i) => configured(`missing-${i}.mjs`, 10));
  const result = summarize({ hooks: [measured('real.mjs', 6538)] }, settings([configured('real.mjs'), ...missing]));
  assert.equal(result.criticalPathMs, 6538);
  assert.equal(result.unmeasured.length, 29);
  assert.equal(result.over, false);
});

test('timeout で切られた実測は記録するが、それだけでは over にしない（狼少年化の防止）', () => {
  for (const durationMs of [5000, 5001]) {
    const result = summarize({ hooks: [measured('a.mjs', durationMs)] }, settings([configured('a.mjs', 5)]), 30);
    assert.equal(result.truncated.length, 1);
    assert.equal(result.over, false);
    assert.equal(result.strongWarning, false);
  }
  assert.equal(summarize({ hooks: [measured('a.mjs', 4999)] }, settings([configured('a.mjs', 5)])).truncated.length, 0);
  // 予算超過で警告が出るときは timeout 超過も本文に併記される
  const overResult = summarize({ hooks: [measured('a.mjs', 31000)] }, settings([configured('a.mjs', 5)]), 30);
  assert.equal(overResult.over, true);
  assert.equal(overResult.truncated.length, 1);
  assert.match(JSON.parse(renderWarning(overResult)).hookSpecificOutput.additionalContext, /timeout超過: a\.mjs 31\.0s \(timeout 5s\)/);
});

test('29s/31s の警告境界、60s、非0 exitCode', () => {
  assert.equal(summarize({ hooks: [measured('a.mjs', 29000)] }, {}, 30).over, false);
  assert.equal(summarize({ hooks: [measured('a.mjs', 30000)] }, {}, 30).over, false);
  const over = summarize({ hooks: [measured('a.mjs', 31000, 'new', undefined, 2)] }, {}, 30);
  assert.equal(over.over, true);
  assert.equal(over.slowest[0].exitCode, 2);
  assert.equal(summarize({ hooks: [measured('a.mjs', 60000)] }, {}).strongWarning, true);
  assert.equal(summarize({ hooks: [measured('a.mjs', 59999)] }, {}).strongWarning, false);
  assert.match(JSON.parse(renderWarning(over)).hookSpecificOutput.additionalContext, /31\.0s/);
});

test('台帳 history は末尾200件', () => {
  const ledger = { history: Array.from({ length: 200 }, (_, at) => ({ at })) };
  const next = appendLedger(ledger, { at: 'new' });
  assert.equal(next.history.length, 200);
  assert.equal(next.history[0].at, 1);
  assert.equal(next.history.at(-1).at, 'new');
});

test('空 stdin / transcript 不在でも exit 0', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-empty-'));
  const result = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), '--no-ledger'], { input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  fs.rmSync(home, { recursive: true, force: true });
});

test('明示 transcript に有効計測がなければ JSON は no-data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-no-data-'));
  const transcript = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ hookEvent: 'SessionStart', toolUseID: 'SessionStart' })}\n`);
  const result = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), '--transcript', transcript, '--json', '--no-ledger'], { input: '', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).status, 'no-data');
  assert.equal(JSON.parse(result.stdout).over, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('自動選択は計測なしの最新 transcript を飛ばす', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-select-'));
  const cwd = '/repo/project';
  const project = path.join(home, '.claude', 'projects', projectSlug(cwd));
  fs.mkdirSync(project, { recursive: true });
  const older = path.join(project, 'older.jsonl');
  const newer = path.join(project, 'newer.jsonl');
  const current = path.join(project, 'current.jsonl');
  fs.writeFileSync(older, `${JSON.stringify({ timestamp: '2026-01-01T00:00:00Z', hookEvent: 'SessionStart', command: 'node "a.mjs"', durationMs: 1234, toolUseID: 'batch' })}\n`);
  fs.writeFileSync(newer, `${JSON.stringify({ timestamp: '2026-01-02T00:00:00Z', hookEvent: 'SessionStart', toolUseID: 'SessionStart' })}\n`);
  fs.writeFileSync(current, `${JSON.stringify({ hookEvent: 'SessionStart', ...measured('current.mjs', 99999) })}\n`);
  const now = Date.now() / 1000;
  fs.utimesSync(older, now - 10, now - 10);
  fs.utimesSync(newer, now, now);
  fs.utimesSync(current, now + 10, now + 10);
  const result = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), '--project', cwd, '--json', '--no-ledger'], { input: JSON.stringify({ session_id: 'current' }), env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.source, older);
  assert.equal(output.serialSumMs, 1234);
  const explicit = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), '--transcript', newer, '--json', '--no-ledger'], {
    input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  assert.equal(explicit.status, 0);
  assert.equal(JSON.parse(explicit.stdout).source, newer);
  assert.equal(JSON.parse(explicit.stdout).status, 'no-data');
  fs.rmSync(home, { recursive: true, force: true });
});

test('未計測 29 本でも CLI は無出力、台帳は実測 criticalPathMs だけで判定する', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-unmeasured-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings(
    Array.from({ length: 29 }, (_, i) => configured(`missing-${i}.mjs`)),
  )));
  const transcript = path.join(home, 'measured.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ hookEvent: 'SessionStart', ...measured('real.mjs', 6538) }));
  const result = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), '--transcript', transcript], {
    input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const entry = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'hook-budget.json'), 'utf8')).history.at(-1);
  assert.equal(entry.status, 'ok');
  assert.equal(entry.criticalPathMs, 6538);
  assert.equal(entry.unmeasured.length, 29);
  assert.equal(entry.over, false);
  assert.equal(entry.strongWarning, false);
  assert.equal('assumedMs' in entry, false);
  assert.equal('estimatedTotalMs' in entry, false);
});

test('計測なしは通常・verbose とも無出力、JSON と台帳は no-data / over:false', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-budget-silent-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings([configured('missing.mjs', 289)])));
  const ghost = path.join(home, 'ghost.jsonl');
  fs.writeFileSync(ghost, JSON.stringify({ hookEvent: 'SessionStart' }));
  for (const selection of [[], ['--transcript', ghost], ['--transcript', path.join(home, 'absent.jsonl')]]) {
    for (const format of [[], ['--verbose'], ['--json']]) {
      const result = spawnSync(process.execPath, [path.resolve('tools/hook-budget-check.mjs'), ...selection, ...format], {
        input: '', env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8',
      });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      if (format.includes('--json')) {
        const summary = JSON.parse(result.stdout);
        assert.equal(summary.status, 'no-data');
        assert.equal(summary.over, false);
      } else assert.equal(result.stdout, '');
      const entry = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'hook-budget.json'), 'utf8')).history.at(-1);
      assert.equal(entry.status, 'no-data');
      assert.equal(entry.over, false);
      assert.equal(entry.criticalPathMs, 0);
      assert.equal('assumedMs' in entry, false);
      assert.equal('estimatedTotalMs' in entry, false);
    }
  }
});

test('未計測の注意書きは async 除外数と実測が下限であることを表示する', () => {
  const summary = summarize({ hooks: [measured('real.mjs', 31000)] }, settings([
    configured('missing.mjs'), { ...configured('background.mjs'), async: true },
  ]));
  assert.deepEqual(summary.unmeasured, [
    { name: 'missing.mjs', timeoutSec: 10, async: false },
    { name: 'background.mjs', timeoutSec: 10, async: true },
  ]);
  assert.match(JSON.parse(renderWarning(summary)).hookSpecificOutput.additionalContext,
    /未計測 2本（async 除く 1本）は合計に含まれない＝実測値は下限/);
});
