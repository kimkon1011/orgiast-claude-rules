import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BACKENDS, TASKS, buildPlan, estimateBytes, judgeAdoption, main, parseArgs,
  resolveReportPath, appendRun, loadReport, runOnce, summarizeRuns,
} from './copilot-effect-measure.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-effect-measure-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('CLI既定値とバリデーション', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.task, 'classify'); assert.equal(defaults.backend, 'both'); assert.equal(defaults.targetByteReduction, 0.3); assert.equal(defaults.dryRun, false);
  assert.deepEqual(parseArgs(['--backend', 'cloud', '--live']), { ...defaults, backend: 'cloud', live: true });
  assert.throws(() => parseArgs(['--task', 'unknown']), /--task/);
  assert.throws(() => parseArgs(['--backend', 'gpu']), /--backend/);
  assert.throws(() => parseArgs(['--target-byte-reduction', '2']), /--target-byte-reduction/);
  assert.throws(() => parseArgs(['--target-byte-reduction', 'abc']), /--target-byte-reduction/);
});

test('ネットワークバイト推定は文字数に比例し固定オーバーヘッドを持つ', () => {
  const empty = estimateBytes();
  assert.equal(empty.totalBytes, 2048);
  const a = estimateBytes({ promptChars: 100, completionChars: 100 });
  // 100文字 ≒ 60 token × 4B = 240B ずつ + 2048B
  assert.equal(a.totalBytes, 2048 + 240 + 240);
  const b = estimateBytes({ promptChars: 200, completionChars: 200 });
  assert.equal(b.totalBytes, 2048 + 480 + 480);
  // 入力バイトは出力より大きい・同程度に保つ（プロンプトが長い典型ケース）
  const heavyPrompt = estimateBytes({ promptChars: 5000, completionChars: 500 });
  assert.equal(heavyPrompt.inputTokens, 3000); assert.equal(heavyPrompt.outputTokens, 300);
  assert.ok(heavyPrompt.totalBytes > 10000);
});

test('dry-run 計画はネットワークを使わず全タスク×両バックエンドを列挙する', () => {
  const plan = buildPlan({ prompt: 'test' });
  assert.equal(plan.proposal, 'P-0299');
  assert.equal(plan.plan.length, Object.keys(TASKS).length);
  for (const item of plan.plan) {
    assert.deepEqual(item.backends, Object.keys(BACKENDS));
    assert.ok(['営業', '制作'].includes(item.department));
  }
  assert.match(plan.note, /dry-run はネットワーク/);
});

test('レポート保存は ORGIAST_HOME 分離で読み書きできる', (t) => {
  const home = fixture(t);
  process.env.ORGIAST_HOME = home;
  t.after(() => delete process.env.ORGIAST_HOME);
  const reportPath = resolveReportPath(home);
  assert.equal(reportPath, path.join(home, '.claude', 'logs', 'copilot-effect-measure.json'));
  appendRun(reportPath, { task: 'classify', backend: 'local', elapsedMs: 10, promptChars: 5, completionChars: 5 });
  const report = loadReport(reportPath);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].backend, 'local');
});

test('runOnce は未知 task/backend を fail closed し、注入 registry では実測値が記録される', (t) => {
  const home = fixture(t);
  assert.throws(() => runOnce({ task: 'nope', backend: 'cloud', prompt: '', home }), /未知の task/);
  assert.throws(() => runOnce({ task: 'classify', backend: 'nope', prompt: '', home }), /未知の backend/);
  // フェイク CLI を注入して実測パイプライン（spawn → 時間・文字数記録）を通す
  const fake = {
    cloud: { label: 'fake', command: process.execPath, args: ['-e', 'process.stdout.write("{\\"ok\\":true}")'] },
  };
  let now = 1000;
  const run = runOnce({ task: 'classify', backend: 'cloud', prompt: 'あいうえお', home, cwd: process.cwd(), now: () => now, registry: fake });
  assert.equal(run.status, 0);
  assert.equal(run.promptChars, 5);
  assert.ok(run.completionChars > 0);
  assert.equal(run.elapsedMs, 0); // クロック固定時は 0ms
});

test('集計は backend 別に avg/min/max を出す', () => {
  const runs = [
    { task: 'classify', backend: 'cloud', elapsedMs: 500, promptChars: 100, completionChars: 50 },
    { task: 'classify', backend: 'cloud', elapsedMs: 700, promptChars: 100, completionChars: 50 },
    { task: 'classify', backend: 'local', elapsedMs: 200, promptChars: 100, completionChars: 50 },
  ];
  const summary = summarizeRuns(runs);
  assert.equal(summary.cloud.runs, 2);
  assert.equal(summary.cloud.elapsedMs.avg, 600); assert.equal(summary.cloud.elapsedMs.min, 500); assert.equal(summary.cloud.elapsedMs.max, 700);
  assert.equal(summary.local.elapsedMs.avg, 200);
  assert.equal(summary.cloud.bytesEst.avg, estimateBytes({ promptChars: 100, completionChars: 50 }).totalBytes);
  const empty = summarizeRuns([]);
  assert.deepEqual(empty, {});
});

test('導入判断はネットワークバイト削減目標で expand を決める', () => {
  const mk = (cloudBytes, localBytes) => ({
    cloud: { bytesEst: { count: 1, avg: cloudBytes } },
    local: { bytesEst: { count: 1, avg: localBytes } },
  });
  assert.equal(judgeAdoption(mk(1000, 500), { targetByteReduction: 0.3 }).expand, true);   // 50% 減
  assert.equal(judgeAdoption(mk(1000, 800), { targetByteReduction: 0.3 }).expand, false);  // 20% 減
  assert.equal(judgeAdoption(mk(1000, 400), { targetByteReduction: 0.7 }).expand, false);  // 60% 減 < 70%
  assert.equal(judgeAdoption(mk(1000, 400), { targetByteReduction: 0.5 }).expand, true);
  // 実測不足は expand=false で理由を返す
  assert.equal(judgeAdoption({ cloud: { bytesEst: { count: 0 } } }).expand, false);
  assert.equal(judgeAdoption({ cloud: { bytesEst: { count: 1, avg: 100 } }, local: { bytesEst: { count: 0 } } }).expand, false);
  assert.match(judgeAdoption(mk(1000, 500)).conclusion, /主要部署への試験導入拡大を推奨/);
});

async function captureStdout(run) {
  const out = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };
  try {
    await run();
  } finally {
    process.stdout.write = origWrite;
  }
  return out.join('');
}

test('main: --list と既定 dry-run は JSON を出す（実呼び出し）', async () => {
  const listJson = await captureStdout(() => main(['--list']));
  const parsed = JSON.parse(listJson);
  assert.ok(parsed.tasks.classify); assert.ok(parsed.backends.cloud);
  const planJson = await captureStdout(() => main(['--task', 'judge', '--dry-run']));
  const plan = JSON.parse(planJson);
  assert.equal(plan.plan[0].task, 'judge');
  assert.equal(plan.plan.length, 1);
});

test('main: --live はフェイク CLI で実測しレポートと導入判断を出力する', async (t) => {
  const home = fixture(t);
  process.env.ORGIAST_HOME = home;
  t.after(() => delete process.env.ORGIAST_HOME);
  const registry = { cloud: { label: 'fake', command: process.execPath, args: ['-e', 'process.stdout.write("fakeresult")'] } };
  const report = path.join(home, 'report.json');
  const resultJson = await captureStdout(() => main(['--live', '--backend', 'cloud', '--task', 'classify', '--prompt', '測定用プロンプト', '--report', report], { registry }));
  const result = JSON.parse(resultJson);
  assert.equal(result.report, report);
  assert.equal(result.summary.cloud.runs, 1);
  assert.ok(result.summary.cloud.elapsedMs.avg >= 0);
  // cloud のみ実測 → local 不足で expand=false の理由付き判断になる
  assert.equal(result.adoption.expand, false);
  assert.match(result.adoption.reason, /ローカル側の実測がありません/);
  const saved = loadReport(report);
  assert.equal(saved.runs.length, 1);
  assert.equal(saved.runs[0].backend, 'cloud');
});

test('main: --live は実行基盤の無い機体で fail closed する', (t) => {
  const home = fixture(t);
  process.env.ORGIAST_HOME = home;
  t.after(() => delete process.env.ORGIAST_HOME);
  // registry 注入で存在しないコマンドを backend として指定し、fail closed を検証する
  const registry = { cloud: { label: 'fake', command: '__definitely_missing_cmd__', args: [] } };
  return main(['--live', '--backend', 'cloud'], { registry }).then(
    () => assert.fail('fail closed すべきところ成功した'),
    (err) => assert.match(String(err.message), /実行基盤/),
  );
});