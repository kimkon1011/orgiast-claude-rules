import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runNightlyHealth, formatDate, extractFailCount, isFailureLine } from './nightly-health.mjs';

function createTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-health-test-'));
  fs.mkdirSync(path.join(home, '.claude', 'logs'), { recursive: true });
  return home;
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup error
  }
}

test('異常ゼロなら notify が1度も呼ばれず ok:異常なし になる', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1' }];
  
  const now = new Date();
  const logPath = path.join(home, '.claude', 'logs', 'job1.log');
  fs.writeFileSync(logPath, `${formatDate(now)} Safe line\n`, 'utf8');

  let notifyCalled = false;
  const result = await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async () => { notifyCalled = true; }
  });

  assert.equal(result.message, 'ok:異常なし');
  assert.equal(notifyCalled, false);
  assert.equal(result.exitCode, 0);

  removeDir(home);
});

test('scan: keywords のログに error 行があれば検知され、通知本文にそのラベルが含まれる', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  
  const now = new Date();
  const logPath = path.join(home, '.claude', 'logs', 'job1.log');
  fs.writeFileSync(logPath, `${formatDate(now)} [ERROR] Something failed\n`, 'utf8');

  let notifiedText = '';
  const result = await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async (text) => { notifiedText = text; }
  });

  assert.match(notifiedText, /ジョブ1/);
  assert.match(notifiedText, /ERROR/);
  assert.equal(result.exitCode, 0);

  removeDir(home);
});

test('24時間より古い失敗行は拾わない（新しい行だけ拾う）', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  
  const now = new Date('2026-09-05T12:00:00.000Z');
  const past25h = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25 hours ago
  const past2h = new Date(now.getTime() - 2 * 60 * 60 * 1000);   // 2 hours ago

  const logPath = path.join(home, '.claude', 'logs', 'job1.log');
  fs.writeFileSync(logPath, 
    `${formatDate(past25h)} Error in the past\n` +
    `${formatDate(past2h)} Exception: new failure\n`, 
    'utf8'
  );

  let notifiedText = '';
  await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async (text) => { notifiedText = text; }
  });

  assert.doesNotMatch(notifiedText, /Error in the past/);
  assert.match(notifiedText, /Exception: new failure/);

  removeDir(home);
});

test('期待リストのログが存在しなければ異常として報告される', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'missing.log', maxAgeHours: 26, label: '欠損ジョブ' }];
  
  const now = new Date();
  let notifiedText = '';
  await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async (text) => { notifiedText = text; }
  });

  assert.match(notifiedText, /欠損ジョブ/);
  assert.match(notifiedText, /ログファイルが存在しません/);

  removeDir(home);
});

test('maxAgeHours を超えて更新されていないログが stale として報告される', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'stale.log', maxAgeHours: 2, label: '遅延ジョブ' }];
  
  const now = new Date();
  const past3h = new Date(now.getTime() - 3 * 60 * 60 * 1000); // 3 hours ago

  const logPath = path.join(home, '.claude', 'logs', 'stale.log');
  fs.writeFileSync(logPath, `${formatDate(past3h)} Updated\n`, 'utf8');
  // Set mtime to 3 hours ago
  fs.utimesSync(logPath, past3h, past3h);

  let notifiedText = '';
  await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async (text) => { notifiedText = text; }
  });

  assert.match(notifiedText, /遅延ジョブ/);
  assert.match(notifiedText, /ログ更新が滞っています/);

  removeDir(home);
});

test('テストランナーが fail>0 を返したら異常として報告される', async () => {
  const home = createTempHome();
  const expectations = []; // No log checks
  
  const now = new Date();
  let notifiedText = '';
  await runNightlyHealth({
    home,
    now,
    expectations,
    runTests: async () => ({ status: 1, stdout: '✖ tools/some.test.mjs\n# fail 1', stderr: '', allTestFiles: ['tools/some.test.mjs'] }),
    notify: async (text) => { notifiedText = text; }
  });

  assert.match(notifiedText, /ローカルテスト/);
  assert.match(notifiedText, /テスト失敗/);
  assert.match(notifiedText, /tools\/some\.test\.mjs/);

  removeDir(home);
});

test('走査済みログはオフセットにより再通知しない', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  
  const now1 = new Date('2026-09-05T12:00:00.000Z');
  const logPath = path.join(home, '.claude', 'logs', 'job1.log');
  fs.writeFileSync(logPath, `${formatDate(now1)} [ERROR] Something failed\n`, 'utf8');

  let notifyCount = 0;
  
  // 1st run - should notify
  const res1 = await runNightlyHealth({
    home,
    now: now1,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async () => { notifyCount++; }
  });
  assert.equal(notifyCount, 1);
  assert.equal(res1.sent, true);

  // 2nd run - no newly appended bytes, so there is no anomaly to notify
  const now2 = new Date(now1.getTime() + 10 * 60 * 1000);
  const res2 = await runNightlyHealth({
    home,
    now: now2,
    expectations,
    runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
    notify: async () => { notifyCount++; }
  });
  assert.equal(notifyCount, 1); // Not incremented
  assert.equal(res2.message, 'ok:異常なし');

  removeDir(home);
});

test('実ログのゼロ件カウンタと error=- は失敗扱いしない', () => {
  const successfulLines = [
    '[funnel-probe] https: ok=true status=200 ms=60 error=-',
    '✅ 自動セッション 2026-09-02 38/38 完走（成功38 / timeout0 / 失敗0）',
    'Discord webhook health: alive=4 dead=0 error=0',
    'checks: fail=0 NG: 0'
  ];
  for (const line of successfulLines) assert.equal(isFailureLine(line), false, line);
});

test('/ サマリ / 行は失敗を含んでも除外する', () => {
  assert.equal(isFailureLine('2026-09-05 / サマリ / step1 NG: failed'), false);
});

test('前回オフセット以降に追記された行だけを検知する', async () => {
  const home = createTempHome();
  const logPath = path.join(home, '.claude', 'logs', 'append.log');
  fs.writeFileSync(logPath, 'ERROR old failure\n', 'utf8');
  fs.writeFileSync(path.join(home, '.claude', '.nightly-health-offsets.json'), JSON.stringify({
    'append.log': { size: fs.statSync(logPath).size, at: new Date().toISOString() }
  }));
  fs.appendFileSync(logPath, 'ERROR new failure\n', 'utf8');
  let text = '';
  await runNightlyHealth({ home, expectations: [{ log: 'append.log', maxAgeHours: 26, label: '追記', scan: 'keywords' }], runTests: async () => ({ status: 0 }), notify: async (value) => { text = value; } });
  assert.doesNotMatch(text, /old failure/);
  assert.match(text, /new failure/);
  removeDir(home);
});

test('ファイル縮小時は末尾から読み直す', async () => {
  const home = createTempHome();
  const logPath = path.join(home, '.claude', 'logs', 'rotated.log');
  fs.writeFileSync(logPath, 'ERROR after rotation\n', 'utf8');
  fs.writeFileSync(path.join(home, '.claude', '.nightly-health-offsets.json'), JSON.stringify({
    'rotated.log': { size: 9999, at: new Date().toISOString() }
  }));
  let text = '';
  await runNightlyHealth({ home, expectations: [{ log: 'rotated.log', maxAgeHours: 26, label: 'ローテート', scan: 'keywords' }], runTests: async () => ({ status: 0 }), notify: async (value) => { text = value; } });
  assert.match(text, /after rotation/);
  removeDir(home);
});

test('初回は末尾200行だけを走査する', async () => {
  const home = createTempHome();
  const lines = ['ERROR outside tail', ...Array.from({ length: 200 }, (_, index) => `safe ${index}`), 'ERROR inside tail'];
  fs.writeFileSync(path.join(home, '.claude', 'logs', 'long.log'), `${lines.join('\n')}\n`, 'utf8');
  let text = '';
  await runNightlyHealth({ home, expectations: [{ log: 'long.log', maxAgeHours: 26, label: '長文', scan: 'keywords' }], runTests: async () => ({ status: 0 }), notify: async (value) => { text = value; } });
  assert.doesNotMatch(text, /outside tail/);
  assert.match(text, /inside tail/);
  removeDir(home);
});

test('--dry-run ではオフセットを更新しない', async () => {
  const home = createTempHome();
  fs.writeFileSync(path.join(home, '.claude', 'logs', 'job.log'), 'ERROR visible\n', 'utf8');
  const offsetsPath = path.join(home, '.claude', '.nightly-health-offsets.json');
  await runNightlyHealth({ home, expectations: [], dryRun: true, runTests: async () => ({ status: 0 }) });
  assert.equal(fs.existsSync(offsetsPath), false);
  removeDir(home);
});

test('scan 省略時は stale-only になり散文の失敗語を検知しない', async () => {
  const home = createTempHome();
  const logPath = path.join(home, '.claude', 'logs', 'prose.log');
  fs.writeFileSync(logPath,
    '**書き込みに失敗しても既存処理を止めない（warn のみ）**\n' +
    '## 調査結果 Issue #7「領収書アップロード失敗」は**コード修正不要**でした\n');
  const result = await runNightlyHealth({
    home,
    expectations: [{ log: 'prose.log', maxAgeHours: 26, label: '散文' }],
    runTests: async () => ({ status: 0 }),
    notify: async () => { assert.fail('通知されるべきではない'); }
  });
  assert.equal(result.message, 'ok:異常なし');
  removeDir(home);
});

test('期待リストにないログは本文を読まず未登録のログを1行だけ付ける', async () => {
  const home = createTempHome();
  fs.writeFileSync(path.join(home, '.claude', 'logs', 'unknown.log'), 'ERROR should not be read\n');
  // 未登録ログは注記であって異常ではないので、本物の異常(登録済みログの失敗)を1件添えて通知経路に乗せる。
  fs.writeFileSync(path.join(home, '.claude', 'logs', 'job1.log'), 'ERROR 本物の失敗\n');
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  let text = '';
  await runNightlyHealth({ home, expectations, runTests: async () => ({ status: 0 }), notify: async (value) => { text = value; } });
  assert.doesNotMatch(text, /should not be read/);
  assert.equal((text.match(/未登録のログ/g) || []).length, 1);
  assert.match(text, /unknown\.log/);
  removeDir(home);
});

test('未登録ログが0件なら未登録のログ行を付けない', async () => {
  const home = createTempHome();
  const result = await runNightlyHealth({ home, expectations: [], dryRun: true, runTests: async () => ({ status: 0 }) });
  assert.doesNotMatch(result.message, /未登録のログ/);
  removeDir(home);
});

test('pattern は最新の日付付きログ1件だけを人間向けラベルで走査する', async () => {
  const home = createTempHome();
  const logsDir = path.join(home, '.claude', 'logs');
  const files = ['nightly-batch-2026-09-03.log', 'nightly-batch-2026-09-04.log', 'nightly-batch-2026-09-05.log'];
  files.forEach((file, index) => {
    const filePath = path.join(logsDir, file);
    fs.writeFileSync(filePath, `NG: day-${index + 3}\n`);
    const mtime = new Date(`2026-09-0${index + 3}T12:00:00Z`);
    fs.utimesSync(filePath, mtime, mtime);
  });
  let text = '';
  await runNightlyHealth({
    home,
    now: new Date('2026-09-05T13:00:00Z'),
    expectations: [{ pattern: '^nightly-batch-\\d{4}-\\d{2}-\\d{2}\\.log$', maxAgeHours: 26, label: '夜間バッチ(日次)', scan: 'keywords' }],
    runTests: async () => ({ status: 0 }),
    notify: async (value) => { text = value; }
  });
  assert.match(text, /夜間バッチ\(日次\).*day-5/);
  assert.doesNotMatch(text, /day-[34]/);
  assert.doesNotMatch(text, /未登録のログ/);
  removeDir(home);
});

test('pattern に一致するログがなければ存在しないと報告する', async () => {
  const home = createTempHome();
  let text = '';
  await runNightlyHealth({
    home,
    expectations: [{ pattern: '^daily-\\d{4}-\\d{2}-\\d{2}\\.log$', maxAgeHours: 26, label: '日次ログ', scan: 'keywords' }],
    runTests: async () => ({ status: 0 }),
    notify: async (value) => { text = value; }
  });
  assert.match(text, /日次ログ: ログファイルが存在しません/);
  removeDir(home);
});

test('baseline の既知失敗を本文から除き抑制件数を示し、未知失敗だけ通知する', async () => {
  const home = createTempHome();
  const baselinePath = path.join(home, 'baseline.json');
  fs.writeFileSync(baselinePath, JSON.stringify({ failing: ['known failure'], recordedAt: new Date().toISOString() }));
  let text = '';
  await runNightlyHealth({
    home,
    expectations: [],
    baselinePath,
    runTests: async () => ({ status: 1, stdout: 'not ok 1 - known failure\nnot ok 2 - new failure\nℹ fail 2' }),
    notify: async (value) => { text = value; }
  });
  assert.doesNotMatch(text, /テスト失敗: known failure/);
  assert.match(text, /テスト失敗: new failure/);
  assert.match(text, /既知の赤 1件は baseline により抑制/);
  removeDir(home);
});

test('--update-baseline のときだけ現状の失敗名で baseline を上書きする', async () => {
  const home = createTempHome();
  const baselinePath = path.join(home, 'baseline.json');
  await runNightlyHealth({
    home,
    expectations: [],
    baselinePath,
    updateBaseline: true,
    runTests: async () => ({ status: 1, stdout: 'not ok 1 - current failure\n# fail 1' }),
    notify: async () => {}
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(baselinePath, 'utf8')).failing, ['current failure']);
  removeDir(home);
});

test('異常13件では本文を12件に制限し残数を示す', async () => {
  const home = createTempHome();
  const failures = Array.from({ length: 13 }, (_, index) => `not ok ${index + 1} - failure ${index + 1}`).join('\n');
  let text = '';
  await runNightlyHealth({
    home,
    expectations: [],
    baselinePath: path.join(home, 'missing-baseline.json'),
    runTests: async () => ({ status: 1, stdout: `${failures}\nℹ fail 13` }),
    notify: async (value) => { text = value; }
  });
  assert.equal((text.match(/^- ローカルテスト:/gm) || []).length, 12);
  assert.match(text, /…ほか 1件/);
  removeDir(home);
});

test('ℹ fail 10 形式から失敗件数を抽出する', () => {
  assert.equal(extractFailCount('ℹ tests 1230\nℹ pass 1219\nℹ fail 10'), 10);
});

test('通知が例外を投げたら exit code 相当が 1 になる', async () => {
  const home = createTempHome();
  const expectations = [{ log: 'missing.log', maxAgeHours: 26, label: '欠損ジョブ' }];
  
  const now = new Date();
  const originalError = console.error;
  console.error = () => {}; // Suppress expected console.error output

  try {
    const result = await runNightlyHealth({
      home,
      now,
      expectations,
      runTests: async () => ({ status: 0, stdout: 'ok', stderr: '', allTestFiles: [] }),
      notify: async () => { throw new Error('Network failure'); }
    });

    assert.equal(result.exitCode, 1);
    assert.ok(result.error);
  } finally {
    console.error = originalError;
  }

  removeDir(home);
});

test('--prime は通知せずオフセットと state を記録する', async () => {
  const home = createTempHome();
  const logs = path.join(home, '.claude', 'logs');
  fs.writeFileSync(path.join(logs, 'job1.log'), 'error: 何かに失敗しました\n');
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  let notified = 0;
  try {
    const result = await runNightlyHealth({
      home, expectations, prime: true,
      notify: async () => { notified += 1; },
      runTests: async () => ({ status: 0 }),
    });
    assert.equal(notified, 0, 'prime では通知しない');
    assert.equal(result.primed, true);
    assert.ok(result.anomalies.length >= 1, '検知自体は行う');
    const offsets = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.nightly-health-offsets.json'), 'utf8'));
    assert.ok(offsets['job1.log'], 'オフセットが記録される');
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.nightly-health-state.json'), 'utf8'));
    assert.ok(state.hash && state.sentAt, 'state が記録される');
  } finally { removeDir(home); }
});

test('--prime の直後は追記が無いので異常ゼロになり通知しない', async () => {
  const home = createTempHome();
  const logs = path.join(home, '.claude', 'logs');
  fs.writeFileSync(path.join(logs, 'job1.log'), 'error: 何かに失敗しました\n');
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  let notified = 0;
  try {
    await runNightlyHealth({ home, expectations, prime: true, notify: async () => { notified += 1; }, runTests: async () => ({ status: 0 }) });
    fs.writeFileSync(path.join(logs, 'job1.log'), 'error: 何かに失敗しました\n');
    const second = await runNightlyHealth({ home, expectations, notify: async () => { notified += 1; }, runTests: async () => ({ status: 0 }) });
    assert.equal(notified, 0, 'prime 済みの行は再検知しないので通知しない');
    assert.equal(second.anomalies.length, 0, '追記が無ければ異常ゼロ');
    // 追記されたら今度こそ通知する（prime が検知そのものを殺していないことの確認）
    fs.appendFileSync(path.join(logs, 'job1.log'), 'error: 新しい失敗\n');
    const third = await runNightlyHealth({ home, expectations, notify: async () => { notified += 1; }, runTests: async () => ({ status: 0 }) });
    assert.equal(third.anomalies.length, 1, '新しい追記は検知する');
    assert.equal(notified, 1, '新しい異常は通知される');
  } finally { removeDir(home); }
});

test('未登録ログや baseline 抑制だけでは通知しない（平穏な夜は無音）', async () => {
  const home = createTempHome();
  const logs = path.join(home, '.claude', 'logs');
  fs.writeFileSync(path.join(logs, 'job1.log'), '正常に完了しました\n');
  fs.writeFileSync(path.join(logs, '未登録.log'), '何か\n');
  const expectations = [{ log: 'job1.log', maxAgeHours: 26, label: 'ジョブ1', scan: 'keywords' }];
  let notified = 0;
  try {
    const result = await runNightlyHealth({
      home, expectations,
      notify: async () => { notified += 1; },
      runTests: async () => ({ status: 0 }),
    });
    assert.equal(result.anomalies.length, 0);
    assert.equal(notified, 0, '未登録ログがあっても異常ゼロなら通知しない');
    assert.match(result.message, /ok:異常なし/);
  } finally { removeDir(home); }
});
