import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decidePace,
  pickLeader,
  activePcs,
  mergeQueue,
  readQueue,
  launchPaceTasks,
  resolveAccountForHost,
  normalizePaceHost,
  WINDOW_MS,
  DEFAULT_STALE_MS,
  defaultQueuePath,
} from './claude-pace.mjs';

test('readQueue は runtime が無ければ repo config の28件から初期化する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pace-test-'));
  try {
    const queue = readQueue(home);
    assert.equal(queue.tasks.length, 28);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pace-queue.json'), 'utf8')).tasks.length, 28);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('mergeQueue は runtime の進捗と runtime 専用項目を残し、repo の新項目を未着手で加える', () => {
  const runtime = {
    tasks: [
      { id: 'Q-1', title: 'old', state: '完了', lastRunAt: '2026-11-27T00:00:00Z' },
      { id: 'Q-NEW-1', state: '未着手' },
    ],
    newOfferings: [{ id: 'N-1', state: '完了' }],
  };
  const repo = {
    tasks: [{ id: 'Q-1', title: 'new', state: '未着手' }, { id: 'Q-2', state: '着手' }],
    newOfferings: [{ id: 'N-1', state: '未着手' }, { id: 'N-2', state: '着手' }],
  };
  const beforeRuntime = structuredClone(runtime);
  const beforeRepo = structuredClone(repo);
  const merged = mergeQueue(runtime, repo);

  assert.equal(merged.tasks.find((item) => item.id === 'Q-1').state, '完了');
  assert.equal(merged.tasks.find((item) => item.id === 'Q-1').lastRunAt, '2026-11-27T00:00:00Z');
  assert.equal(merged.tasks.find((item) => item.id === 'Q-2').state, '未着手');
  assert.ok(merged.tasks.some((item) => item.id === 'Q-NEW-1'));
  assert.equal(merged.newOfferings.find((item) => item.id === 'N-1').state, '完了');
  assert.equal(merged.newOfferings.find((item) => item.id === 'N-2').state, '未着手');
  assert.deepEqual(runtime, beforeRuntime);
  assert.deepEqual(repo, beforeRepo);
});

const HOUR = 3600_000;
const resetsAt = '2026-12-04T00:00:00.000Z';
const resetsMs = Date.parse(resetsAt);

function usage({ seven = 50, five = 10, sevenReset = resetsAt, fiveReset = '2026-11-27T15:00:00.000Z' } = {}) {
  return {
    available: true,
    fiveHour: { utilization: five, resetsAt: fiveReset },
    sevenDay: { utilization: seven, resetsAt: sevenReset },
  };
}

function baseInput(overrides = {}) {
  // elapsedRatio = 0.5 → target = 45
  const nowMs = resetsMs - WINDOW_MS / 2;
  return {
    nowMs,
    account: 'cr@orgiast.jp',
    host: '018',
    usage: usage({ seven: 50, five: 10 }),
    sessionCount: 3,
    runningPaceJobs: 0,
    accountConcurrency: 2,
    sessionLaunchCap: 27,
    sweepActive: false,
    isLeader: true,
    ...overrides,
  };
}

test('1. 遅れ（actual < target-5）→ launch true', () => {
  // target=45, actual=30 → delta=-15 → behind
  const r = decidePace(baseInput({ usage: usage({ seven: 30 }) }));
  assert.equal(r.status, 'behind');
  assert.equal(r.launch, true);
  assert.equal(r.hold, false);
});

test('2. ちょうど（±5pt）→ launch false, hold false', () => {
  // target=45, actual=47 → onpace
  const r = decidePace(baseInput({ usage: usage({ seven: 47 }) }));
  assert.equal(r.status, 'onpace');
  assert.equal(r.launch, false);
  assert.equal(r.hold, false);
});

test('3. 進みすぎ（target+5 超）→ launch false, hold true', () => {
  // target=45, actual=55 → ahead
  const r = decidePace(baseInput({ usage: usage({ seven: 55 }) }));
  assert.equal(r.status, 'ahead');
  assert.equal(r.launch, false);
  assert.equal(r.hold, true);
});

test('4. 最終6時間で actual 80% → status final-push, launch true', () => {
  const nowMs = resetsMs - 5 * HOUR;
  const r = decidePace(baseInput({ nowMs, usage: usage({ seven: 80, five: 20 }) }));
  assert.equal(r.status, 'final-push');
  assert.equal(r.launch, true);
  assert.equal(r.hold, false);
});

test('5. 最終6時間で actual 96% → status final-push（まだ 97 未満）', () => {
  const nowMs = resetsMs - 5 * HOUR;
  const r = decidePace(baseInput({ nowMs, usage: usage({ seven: 96, five: 20 }) }));
  assert.equal(r.status, 'final-push');
  assert.ok(r.actual < 97);
});

test('6. actual 97% → status stopped, launch false, hold true', () => {
  const r = decidePace(baseInput({ usage: usage({ seven: 97 }) }));
  assert.equal(r.status, 'stopped');
  assert.equal(r.launch, false);
  assert.equal(r.hold, true);
  assert.ok(r.reasons.includes('hard-stop-97'));
});

test('7. fiveHour 85% → launch false, reason 5h-safety', () => {
  const r = decidePace(baseInput({
    usage: usage({ seven: 30, five: 85 }),
  }));
  assert.equal(r.status, 'behind');
  assert.equal(r.launch, false);
  assert.ok(r.reasons.includes('5h-safety'));
});

test('8. usage.available false → status unmeasurable, launch false, hold false', () => {
  const r = decidePace(baseInput({ usage: { available: false, reason: 'HTTP 429' } }));
  assert.equal(r.status, 'unmeasurable');
  assert.equal(r.launch, false);
  assert.equal(r.hold, false);
  assert.ok(r.reasons[0].startsWith('measure-failed:'));
});

test('9. 窓リセット直後（elapsedRatio ほぼ 0, actual 0）→ onpace、projectedLanding は null', () => {
  const nowMs = resetsMs - WINDOW_MS + 60_000; // 1分経過
  const r = decidePace(baseInput({ nowMs, usage: usage({ seven: 0 }) }));
  assert.ok(r.elapsedRatio < 0.01);
  assert.equal(r.status, 'onpace');
  assert.equal(r.projectedLanding, null);
  assert.equal(r.launch, false);
  assert.equal(r.hold, false);
});

test('10. 同アカウント2台の調停: pickLeader が時間でローテーションし、非リーダーは launch false', () => {
  const pcs = ['011', '018'];
  const t0 = Date.UTC(2026, 10, 27, 0, 0, 0);
  assert.equal(pickLeader(pcs, t0), '011');
  assert.equal(pickLeader(pcs, t0 + HOUR), '018');
  assert.equal(pickLeader(pcs, t0 + 2 * HOUR), '011');

  const nowMs = resetsMs - WINDOW_MS / 2;
  const r = decidePace(baseInput({
    nowMs,
    host: '018',
    isLeader: false,
    usage: usage({ seven: 30 }),
  }));
  assert.equal(r.status, 'behind');
  assert.equal(r.launch, false);
  assert.ok(r.reasons.includes('not-leader'));
});

test('11. sessionCount 27 以上 → launch false, reason session-cap', () => {
  const r = decidePace(baseInput({
    usage: usage({ seven: 30 }),
    sessionCount: 27,
  }));
  assert.equal(r.launch, false);
  assert.ok(r.reasons.includes('session-cap'));
});

test('12. 最終90分 かつ sweepActive → launch false, reason defer-to-quota-sweep', () => {
  const nowMs = resetsMs - 60 * 60_000; // 60min to reset
  const r = decidePace(baseInput({
    nowMs,
    sweepActive: true,
    usage: usage({ seven: 80, five: 20 }),
  }));
  assert.equal(r.status, 'final-push');
  assert.equal(r.launch, false);
  assert.ok(r.reasons.includes('defer-to-quota-sweep'));
});

test('13. nishi 相当（elapsedRatio 0.45 / actual 88）→ ahead かつ hold true かつ needsThrottle true', () => {
  const nowMs = resetsMs - WINDOW_MS * (1 - 0.45);
  const r = decidePace(baseInput({
    nowMs,
    account: 'nishi@orgiast.jp',
    host: '004',
    usage: usage({ seven: 88, five: 40 }),
  }));
  assert.ok(Math.abs(r.elapsedRatio - 0.45) < 1e-9);
  assert.equal(r.status, 'ahead');
  assert.equal(r.hold, true);
  assert.equal(r.launch, false);
  assert.equal(r.needsThrottle, true);
  assert.ok(r.projectedLanding > 100);
});

test('activePcs は stale な PC をローテーションから外す', () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  const live = activePcs(
    ['011', '018'],
    { '011': now - 1000, '018': now - DEFAULT_STALE_MS - 1000 },
    now,
    DEFAULT_STALE_MS,
  );
  assert.deepEqual(live, ['011']);
  assert.equal(pickLeader(live, now), '011');
});

test('--force-behind 相当でも hard-stop / 5h-safety / session-cap は効く', () => {
  assert.equal(decidePace(baseInput({ forceBehind: true, usage: usage({ seven: 97 }) })).status, 'stopped');
  const five = decidePace(baseInput({ forceBehind: true, usage: usage({ seven: 40, five: 90 }) }));
  assert.equal(five.launch, false);
  assert.ok(five.reasons.includes('5h-safety'));
  const cap = decidePace(baseInput({ forceBehind: true, usage: usage({ seven: 40 }), sessionCount: 30 }));
  assert.equal(cap.launch, false);
  assert.ok(cap.reasons.includes('session-cap'));
});

/** 経過率から nowMs を組み立て、early-window 許容幅の表ケースを検証する */
function atElapsed(elapsedRatio, seven, overrides = {}) {
  const nowMs = resetsMs - WINDOW_MS * (1 - elapsedRatio);
  return decidePace(baseInput({
    nowMs,
    usage: usage({ seven }),
    ...overrides,
  }));
}

test('early-window: elapsed 0.067 / actual 13 → onpace（hold しない）', () => {
  const r = atElapsed(0.067, 13);
  assert.ok(Math.abs(r.elapsedRatio - 0.067) < 1e-9);
  assert.ok(Math.abs(r.effectiveTolerance - 9.33) < 0.01);
  assert.ok(Math.abs(r.target - 6.03) < 0.01);
  assert.ok(Math.abs(r.deltaPt - 6.97) < 0.01);
  assert.equal(r.status, 'onpace');
  assert.equal(r.hold, false);
});

test('early-window: elapsed 0.27 / actual 30 → onpace（hold しない）', () => {
  const r = atElapsed(0.27, 30);
  assert.ok(Math.abs(r.effectiveTolerance - 7.3) < 0.01);
  assert.ok(Math.abs(r.target - 24.3) < 0.01);
  assert.ok(Math.abs(r.deltaPt - 5.7) < 0.01);
  assert.equal(r.status, 'onpace');
  assert.equal(r.hold, false);
});

test('early-window: elapsed 0.26 / actual 41 → ahead（hold する）', () => {
  const r = atElapsed(0.26, 41);
  assert.ok(Math.abs(r.effectiveTolerance - 7.4) < 0.01);
  assert.ok(Math.abs(r.target - 23.4) < 0.01);
  assert.ok(Math.abs(r.deltaPt - 17.6) < 0.01);
  assert.equal(r.status, 'ahead');
  assert.equal(r.hold, true);
});

test('early-window: elapsed 0.45 / actual 88 → ahead（hold する）', () => {
  const r = atElapsed(0.45, 88);
  assert.ok(Math.abs(r.effectiveTolerance - 5.5) < 0.01);
  assert.ok(Math.abs(r.target - 40.5) < 0.01);
  assert.ok(Math.abs(r.deltaPt - 47.5) < 0.01);
  assert.equal(r.status, 'ahead');
  assert.equal(r.hold, true);
});

test('early-window: elapsed 0.90 / actual 70 → behind（起動する）', () => {
  const r = atElapsed(0.90, 70);
  assert.ok(Math.abs(r.effectiveTolerance - 5.0) < 1e-9);
  assert.ok(Math.abs(r.target - 81.0) < 0.01);
  assert.ok(Math.abs(r.deltaPt - (-11.0)) < 0.01);
  assert.equal(r.status, 'behind');
  assert.equal(r.launch, true);
  assert.equal(r.hold, false);
});

test('earlyWindowToleranceBoost: false なら cr 相当（elapsed 0.067 / 13%）は ahead', () => {
  const r = atElapsed(0.067, 13, { earlyWindowToleranceBoost: false });
  assert.equal(r.effectiveTolerance, 5);
  assert.equal(r.status, 'ahead');
  assert.equal(r.hold, true);
});

test('effectiveTolerance が返り値に入る', () => {
  const r = decidePace(baseInput());
  assert.equal(typeof r.effectiveTolerance, 'number');
  assert.ok(Number.isFinite(r.effectiveTolerance));
  // elapsedRatio=0.5 → max(5, 5)=5
  assert.equal(r.effectiveTolerance, 5);
});

test('launchPaceTasks dry-run は queue ファイルを書き換えず返り値にタスク id が入る', async () => {
  // launchPaceTasks は loadPickTasks → import('./claude-pace-queue.mjs') で pickTasks をロードする。
  // テストの cwd がプロジェクトルートなら import は成功する。そこで、実際の config queue を使いつつ
  // home を一時ディレクトリにして、dryRun=true で呼び、書き込みがないことを確認する。
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pace-test-'));
  try {
    // 事前に readQueue(home) を呼んで、一時 home に runtime queue を作らせる
    const q = readQueue(home);
    const beforeContent = fs.readFileSync(path.join(home, '.claude', 'claude-pace-queue.json'), 'utf8');

    const result = await launchPaceTasks({
      home,
      host: '018',
      account: 'cr@orgiast.jp',
      count: 1,
      nowMs: Date.parse('2026-11-27T12:00:00.000Z'),
      dryRun: true,
      // runChild は dryRun では使われない
    });

    // dry-run は queue を書き換えない
    const afterContent = fs.readFileSync(path.join(home, '.claude', 'claude-pace-queue.json'), 'utf8');
    assert.equal(afterContent, beforeContent, 'dry-run で queue が変わってはいけない');

    // 返り値にタスク id が入っている
    assert.ok(Array.isArray(result.launched));
    assert.ok(result.launched.length > 0, 'dry-run でもタスクが選ばれるべき');
    assert.ok(result.launched.some((t) => typeof t.id === 'string' && t.dryRun === true));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('launchPaceTasks dry-run を2回続けても同じタスクが選ばれる', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pace-test-'));
  try {
    readQueue(home); // runtime queue を初期化
    const result1 = await launchPaceTasks({
      home, host: '018', account: 'cr@orgiast.jp', count: 3,
      nowMs: Date.parse('2026-11-27T12:00:00.000Z'),
      dryRun: true,
    });
    const result2 = await launchPaceTasks({
      home, host: '018', account: 'cr@orgiast.jp', count: 3,
      nowMs: Date.parse('2026-11-27T12:00:00.000Z'),
      dryRun: true,
    });

    // 同じタスク（同じ id）が選ばれている
    const ids1 = result1.launched.map((t) => t.id).sort();
    const ids2 = result2.launched.map((t) => t.id).sort();
    assert.deepEqual(ids1, ids2, 'dry-run を2回続けても同じタスクが選ばれる');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('launchPaceTasks 実行失敗時はタスクが 失敗 になり 実行中 を残さない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pace-test-'));
  try {
    readQueue(home); // runtime queue を初期化
    const result = await launchPaceTasks({
      home,
      host: '018',
      account: 'cr@orgiast.jp',
      count: 1,
      nowMs: Date.parse('2026-11-27T12:00:00.000Z'),
      dryRun: false,
      resolveExe: async () => ({ executable: 'fake-claude' }),
      runChild: async () => ({ code: 1, timedOut: false }),
    });

    // タスクが1件選ばれ、失敗として報告されている
    assert.ok(result.launched.length > 0, 'タスクが1件選ばれるべき');
    assert.equal(result.launched[0].ok, false, 'runChild が0以外を返したら ok=false');
    const id = result.launched[0].id;
    assert.ok(typeof id === 'string' && id.length > 0);

    // queue ファイルを読み戻し: 該当タスクは 失敗、実行中のまま残っていない
    const after = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'claude-pace-queue.json'), 'utf8'));
    const task = (after.tasks || []).find((t) => t.id === id);
    assert.ok(task, '実行したタスクが queue に存在するべき');
    assert.equal(task.state, '失敗', '失敗したタスクは 失敗 になるべき');
    assert.notEqual(task.state, '実行中');
    const stillRunning = (after.tasks || []).filter((t) => t.state === '実行中' && t.id === id);
    assert.equal(stillRunning.length, 0, '実行中 のまま取り残されてはいけない');
    assert.equal(task.lastExitCode, 1);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// normalizePaceHost の単体動作テスト
test('normalizePaceHost の単体動作', () => {
  assert.equal(normalizePaceHost('011NEXT'), '011');
  assert.equal(normalizePaceHost('018'), '018');
  assert.equal(normalizePaceHost('DESKTOP-2D0R4LI'), 'DESKTOP-2D0R4LI');
  assert.equal(normalizePaceHost('000-PC'), '000');
  assert.equal(normalizePaceHost(''), '');
  assert.equal(normalizePaceHost(null), '');
  assert.equal(normalizePaceHost(undefined), '');
  assert.equal(normalizePaceHost('014_sub'), '014');
  assert.equal(normalizePaceHost(' 011NEXT '), '011');
});

// resolveAccountForHost のテスト
test('resolveAccountForHost は完全一致を先に見る', () => {
  const config = {
    accounts: {
      'cr@orgiast.jp': { pcs: ['011', '018'] },
      'genbateam.toho@gmail.com': { pcs: ['999'] }
    }
  };
  // 完全一致
  assert.deepEqual(resolveAccountForHost(config, '011'), { account: 'cr@orgiast.jp', pcs: ['011', '018'] });
  // 正規化後一致
  assert.deepEqual(resolveAccountForHost(config, '011NEXT'), { account: 'cr@orgiast.jp', pcs: ['011', '018'] });
  // どちらも無ければ unknown
  assert.deepEqual(resolveAccountForHost(config, 'DESKTOP-XXXX'), { account: 'unknown', pcs: [] });
  // config に 011NEXT と書かれていたらそれが優先される
  const configWithFull = {
    accounts: {
      'cr@orgiast.jp': { pcs: ['011NEXT', '018'] },
      'genbateam.toho@gmail.com': { pcs: ['999'] }
    }
  };
  assert.deepEqual(resolveAccountForHost(configWithFull, '011NEXT'), { account: 'cr@orgiast.jp', pcs: ['011NEXT', '018'] });
});

// 指示書のケース: スペース入りアカウント名 + 正規化で一致
test('resolveAccountForHost は 011NEXT → cr @orgiast.jp に解決する（正規化一致）', () => {
  const accountConfig = {
    accounts: {
      'cr @orgiast.jp': { pcs: ['011', '018'] },
      'genbateam.toho @gmail.com': { pcs: ['999'] },
    },
  };
  assert.equal(resolveAccountForHost(accountConfig, '011NEXT').account, 'cr @orgiast.jp');
});

test('resolveAccountForHost は 999genba → genbateam.toho @gmail.com に解決する（正規化一致）', () => {
  const accountConfig = {
    accounts: {
      'cr @orgiast.jp': { pcs: ['011', '018'] },
      'genbateam.toho @gmail.com': { pcs: ['999'] },
    },
  };
  assert.equal(resolveAccountForHost(accountConfig, '999genba').account, 'genbateam.toho @gmail.com');
});

test('resolveAccountForHost は 018 → cr @orgiast.jp に解決する（完全一致）', () => {
  const accountConfig = {
    accounts: {
      'cr @orgiast.jp': { pcs: ['011', '018'] },
      'genbateam.toho @gmail.com': { pcs: ['999'] },
    },
  };
  assert.equal(resolveAccountForHost(accountConfig, '018').account, 'cr @orgiast.jp');
});

test('resolveAccountForHost は DESKTOP-XXXX → unknown ＋ 空 pcs', () => {
  const accountConfig = {
    accounts: {
      'cr @orgiast.jp': { pcs: ['011', '018'] },
      'genbateam.toho @gmail.com': { pcs: ['999'] },
    },
  };
  const r = resolveAccountForHost(accountConfig, 'DESKTOP-XXXX');
  assert.equal(r.account, 'unknown');
  assert.deepEqual(r.pcs, []);
});

test('resolveAccountForHost は完全一致（011NEXT）を正規化一致（011）より優先する', () => {
  const config = {
    accounts: {
      'a @x': { pcs: ['011NEXT'] },
      'b @x': { pcs: ['011'] },
    },
  };
  assert.equal(resolveAccountForHost(config, '011NEXT').account, 'a @x');
});

test('normalizePaceHost は 011NEXT → 011、DESKTOP-2D0R4LI → そのまま', () => {
  assert.equal(normalizePaceHost('011NEXT'), '011');
  assert.equal(normalizePaceHost('DESKTOP-2D0R4LI'), 'DESKTOP-2D0R4LI');
});
