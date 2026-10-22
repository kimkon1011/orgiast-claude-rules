import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDailyScout, unevaluatedScoutModels, unmeasuredGiveUpIds } from './model-scout-daily.mjs';
import { runNightlyHealth } from './nightly-health.mjs';

const now = new Date('2026-10-15T18:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-daily-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(path.join(dir, 'eval'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'cost-reporter.env'), 'REPORTER_LABEL=kim-PC\n');
  const pending = Array.from({ length: 4 }, (_, i) => ({ id: `meta/new-${i}`, tier: 'frontier', created: 100 - i }));
  const config = pending.map(x => ({ provider: 'openrouter', model: x.id }));
  fs.writeFileSync(path.join(dir, 'eval', 'providers.local.json'), JSON.stringify(config));
  return { home, dir, pending, config };
}
const row = model => ({ provider: 'openrouter', model, n: 10, graded: 10, errors: 0, truncated: 0 });

test('未評価キューはprovider・skip・評価完了を区別し、上限と重複排除を守る', t => {
  const f = fixture(t);
  f.config[1].skip = true;
  const rows = [row(f.pending[0].id), { ...row(f.pending[2].id), provider: 'other' }, { ...row(f.pending[3].id), errors: 10, graded: 0 }];
  assert.deepEqual(unevaluatedScoutModels([...f.pending, f.pending[2]], f.config, rows, { max: 1 }).map(x => x.id), [f.pending[2].id]);
  assert.equal(unevaluatedScoutModels(f.pending, f.config, rows, { max: 5 }).length, 2);
});

test('切捨て多発でも計測が取れていれば評価済みとし、毎晩の再評価で日次を恒久失敗させない', t => {
  const f = fixture(t);
  f.config[2].skip = true;
  const rows = [row(f.pending[0].id), { ...row(f.pending[1].id), graded: 4, truncated: 6 }, { ...row(f.pending[3].id), graded: 0, errors: 10 }];
  // pending[0]=合格行 / pending[1]=truncated 6割だが計測あり→評価済み / pending[2]=skip / pending[3]=全滅→未評価
  assert.deepEqual(unevaluatedScoutModels(f.pending, f.config, rows, { max: 5 }).map(x => x.id), [f.pending[3].id]);
});

test('全滅は近期間2回で再試行打ち切り、1回・陳旧な全滅・非openrouterは続行', () => {
  const now = new Date('2026-10-16T18:00:00Z');
  const dead = (model, t) => ({ provider: 'openrouter', model, n: 15, graded: 0, errors: 15, truncated: 0, t });
  const rows = [
    dead('twice-recent', '2026-10-15T18:00:00Z'), dead('twice-recent', '2026-10-16T18:00:00Z'),
    dead('once-recent', '2026-10-16T18:00:00Z'),
    dead('stale', '2026-09-01T00:00:00Z'), dead('stale', '2026-09-02T00:00:00Z'),
    { provider: 'gemini', model: 'other-provider', n: 15, graded: 0, errors: 15, t: '2026-10-16T18:00:00Z' },
  ];
  assert.deepEqual([...unmeasuredGiveUpIds(rows, { now })], ['twice-recent']);
});

test('全滅候補は2回で打ち切り、3度目のevalと恒久的な日次失敗を起こさない', async t => {
  const f = fixture(t);
  const pending = [f.pending[0]];
  fs.writeFileSync(path.join(f.dir, 'eval', 'providers.local.json'), JSON.stringify(pending.map(x => ({ provider: 'openrouter', model: x.id }))));
  const badRow = model => ({ provider: 'openrouter', model, n: 10, graded: 0, errors: 10, truncated: 0 });
  let tick = 0, evalRuns = 0;
  const opts = date => ({ home: f.home, now: new Date(date), log: () => {}, propose: async () => {}, spawnImpl: (_exe, args) => {
    if (args[0].endsWith('model-scout.mjs')) {
      fs.writeFileSync(path.join(f.dir, 'model-scout-state.json'), JSON.stringify({ updatedAt: `2026-10-${String(10 + tick++).padStart(2, '0')}T00:00:00Z`, pendingCandidates: pending }));
    } else {
      evalRuns += 1;
      fs.appendFileSync(path.join(f.dir, 'eval-results.jsonl'), JSON.stringify(badRow(args[4])) + '\n');
    }
    return { status: 0 };
  } });
  const logFile = () => fs.readFileSync(path.join(f.dir, 'logs', 'model-scout.log'), 'utf8');
  assert.equal((await runDailyScout(opts('2026-10-15T18:00:00Z'))).ok, false); // 1回目の全滅は翌日へ繰越
  assert.match(logFile(), /未評価候補を次回へ繰越/);
  assert.match(logFile(), /未評価候補が残ったため未完了/);
  assert.equal((await runDailyScout(opts('2026-10-16T18:00:00Z'))).ok, true); // 2回目の全滅で打ち切り、当日で完了
  assert.match(logFile(), /評価打ち切り（計測不能2回）/);
  assert.equal((await runDailyScout(opts('2026-10-17T18:00:00Z'))).evaluated, 0); // 3日目は再試行しない
  assert.equal(evalRuns, 2);
  assert.equal(logFile().match(/日次処理失敗/g)?.length, 1); // 打ち切り後は恒久的に失敗し続けない
});

test('kim-PC以外・未知PCは副作用なし、既存ラベル設定で主PCだけ許可', async t => {
  const f = fixture(t);
  for (const label of ['nishi-PC', 'unknown']) {
    fs.writeFileSync(path.join(f.dir, 'cost-reporter.env'), `REPORTER_LABEL=${label}\n`);
    assert.equal((await runDailyScout({ home: f.home, spawnImpl: () => assert.fail('spawn') })).skipped, 'not-kim-pc');
  }
  assert.equal(fs.existsSync(path.join(f.dir, 'logs')), false);
});

test('日次はscout --once→上限付きモデル別eval→保存済み提案、同日二重実行なし・翌日繰越', async t => {
  const f = fixture(t), calls = [];
  let tick = 0, proposed = 0;
  const opts = { home: f.home, now, max: 2, log: () => {}, propose: async () => { proposed++; }, spawnImpl: (_exe, args, options) => {
    calls.push(args);
    assert.equal(options.env.USERPROFILE, f.home);
    if (args[0].endsWith('model-scout.mjs')) {
      assert.deepEqual(args.slice(1), ['--once']);
      fs.writeFileSync(path.join(f.dir, 'model-scout-state.json'), JSON.stringify({ updatedAt: `${now.toISOString()}-${tick++}`, pendingCandidates: f.pending }));
    } else {
      assert.deepEqual(args.slice(1, 4), ['--provider', 'openrouter', '--model']);
      fs.appendFileSync(path.join(f.dir, 'eval-results.jsonl'), JSON.stringify(row(args[4])) + '\n');
    }
    return { status: 0 };
  } };
  assert.equal((await runDailyScout(opts)).evaluated, 2);
  assert.equal(proposed, 1);
  assert.equal((await runDailyScout(opts)).skipped, 'already-completed');
  assert.equal(calls.length, 3);
  assert.equal((await runDailyScout({ ...opts, now: new Date('2026-10-16T18:00:00Z') })).evaluated, 2);
  assert.deepEqual(calls.filter(x => x.includes('--model')).map(x => x[4]), f.pending.map(x => x.id));
  assert.match(fs.readFileSync(path.join(f.dir, 'logs', 'model-scout.log'), 'utf8'), /model-scout 完了/);
});

test('exit0でもscout保存なし・eval結果なしは成功扱いせず再試行、秘密をログに出さない', async t => {
  const f = fixture(t), opts = { home: f.home, now, log: () => {}, propose: async () => {} };
  assert.equal((await runDailyScout({ ...opts, spawnImpl: () => ({ status: 0, stdout: 'SECRET' }) })).ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'model-scout-daily.json')), false);
  assert.equal((await runDailyScout({ ...opts, spawnImpl: (_exe, args) => {
    if (args[0].endsWith('model-scout.mjs')) fs.writeFileSync(path.join(f.dir, 'model-scout-state.json'), JSON.stringify({ updatedAt: now.toISOString(), pendingCandidates: f.pending }));
    return { status: 0, stderr: 'SECRET' };
  } })).ok, false);
  assert.equal(fs.existsSync(path.join(f.dir, 'model-scout-daily.json')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'model-scout-daily.lock')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(f.dir, 'logs', 'model-scout.log'), 'utf8'), /SECRET/);
});

test('生存中のロックは二重起動を防ぎ、他実行のロックを消さない', async t => {
  const f = fixture(t), file = path.join(f.dir, 'model-scout-daily.lock'); fs.writeFileSync(file, String(process.pid));
  assert.equal((await runDailyScout({ home: f.home, spawnImpl: () => assert.fail('spawn') })).skipped, 'running');
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
});

test('夜間バッチの実経路と30時間監視を登録し、他PCでは未実行の誤報なし', async t => {
  const f = fixture(t);
  const batch = fs.readFileSync(new URL('nightly-batch.ps1', import.meta.url), 'utf8');
  assert.match(batch, /model-scout-daily\.mjs'\) --once/);
  const exp = JSON.parse(fs.readFileSync(new URL('nightly-health-expectations.json', import.meta.url))).find(x => x.log === 'model-scout.log');
  assert.equal(exp.maxAgeHours, 30); assert.equal(exp.fleetLabel, 'kim-PC');
  const opts = { home: f.home, expectations: [exp], dryRun: true, runTests: async () => ({ status: 0, stdout: '', stderr: '' }),
    gasDrift: async () => {}, convergenceWatch: async () => {}, streakWatch: async () => ({}) };
  let result = await runNightlyHealth(opts);
  assert.ok(result.anomalies.some(x => x.label === exp.label && x.type === 'missing'));
  fs.writeFileSync(path.join(f.dir, 'cost-reporter.env'), 'REPORTER_LABEL=nishi-PC\n');
  result = await runNightlyHealth(opts);
  assert.ok(!result.anomalies.some(x => x.label === exp.label));
});
