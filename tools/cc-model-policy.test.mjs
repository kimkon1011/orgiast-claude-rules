import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveModel, logModelUsage } from './lib/cc-model-policy.mjs';
import { auditRunCcScripts } from './cc-launcher-audit.mjs';
import { dailySummary, defaultUsageFile } from './cc-model-usage-daily.mjs';
import { classifyCommand, dailyCheck, dailyFromFile } from './grobo-direct-check.mjs';

// T1: opus固定の旧テンプレ相当(fixture)が audit で検出され、新テンプレは opus 理由なしで拒否
test('T1 opus固定の旧テンプレを audit が検出し、理由なし opus を拒否', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-t1-'));
  const runDir = path.join(home, 'gb-reports', 'old-task');
  fs.mkdirSync(runDir, { recursive: true });
  // opus 固定の旧テンプレ相当
  fs.writeFileSync(path.join(runDir, 'run-cc.ps1'), "@('-p','--model','opus')");
  const result = auditRunCcScripts(path.join(home, 'gb-reports'));
  assert.equal(result.total, 1);
  assert.equal(result.opusHardcoded, 1);
  assert.equal(result.files.length, 1);
  assert.match(result.files[0].file, /run-cc\.ps1$/);

  // 新テンプレ: 理由なし opus は rejected
  const emptyReason = resolveModel({ model: 'opus', reason: '' });
  assert.equal(emptyReason.rejected, true);
  const shortReason = resolveModel({ model: 'opus', reason: 'short' });
  assert.equal(shortReason.rejected, true);
  const goodReason = resolveModel({ model: 'opus', reason: 'because this task needs higher quality output for review' });
  assert.equal(goodReason.rejected, false);
  assert.equal(goodReason.model, 'opus');
  assert.equal(goodReason.reason, 'because this task needs higher quality output for review');
});

// T2: 理由つき opus が通りログに理由
test('T2 理由つき opus が通りログに理由を記録', () => {
  const resolved = resolveModel({ model: 'opus', reason: 'because this is a complex review task' });
  assert.equal(resolved.rejected, false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-t2-'));
  const logFile = path.join(home, 'model-usage.jsonl');
  logModelUsage({ file: logFile, model: 'opus', reason: 'complex review', pc: '999', caseDir: '/test/case' });
  const content = fs.readFileSync(logFile, 'utf8').trim();
  const parsed = JSON.parse(content);
  assert.equal(parsed.model, 'opus');
  assert.equal(parsed.reason, 'complex review');
  assert.equal(parsed.pc, '999');
  assert.equal(parsed.case, '/test/case');
  assert.ok(parsed.ts);
});

// T3: 理由なし opus 拒否
test('T3 理由なし opus 拒否', () => {
  const noReason = resolveModel({ model: 'opus' });
  assert.equal(noReason.rejected, true);
  const emptyReason = resolveModel({ model: 'opus', reason: '' });
  assert.equal(emptyReason.rejected, true);
  const whitespaceReason = resolveModel({ model: 'opus', reason: '   ' });
  assert.equal(whitespaceReason.rejected, true);
});

// T5: 日次集計と pace レポート opus 比率
test('T5 日次集計に opus 比率が含まれる', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-t5-'));
  const logFile = path.join(home, 'model-usage.jsonl');
  const lines = [
    { ts: '2026-11-28T01:00:00Z', pc: '999', model: 'sonnet', reason: 'default', case: 'a' },
    { ts: '2026-11-28T02:00:00Z', pc: '999', model: 'opus', reason: 'long enough reason for opus', case: 'b' },
    { ts: '2026-11-28T03:00:00Z', pc: '999', model: 'opus', reason: '', case: 'c' },
  ];
  fs.writeFileSync(logFile, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');

  // 当日分
  const summary = dailySummary(logFile, '2026-11-28');
  assert.equal(summary.total, 3);
  assert.equal(summary.byModel['sonnet'], 1);
  assert.equal(summary.byModel['opus'], 2);
  assert.ok(summary.opusRatio !== null);
  assert.equal((summary.opusRatio * 100).toFixed(1), '66.7');
  assert.equal(summary.opusWithoutReason, 1);

  // 全期間
  const all = dailySummary(logFile);
  assert.equal(all.total, 3);
  assert.equal(all.opusRatio, 2 / 3);

  // ファイル無し
  const empty = dailySummary(path.join(home, 'nonexistent.jsonl'));
  assert.equal(empty.total, 0);
  assert.equal(empty.opusRatio, null);
});

// T6: 複合機履歴・ログの直接読みが違反検出
test('T6 複合機履歴・ログの直接読みが違反検出', () => {
  assert.equal(classifyCommand('cat printer-history.log'), false);
  assert.equal(classifyCommand('Get-Content printer.log'), false);
  assert.equal(classifyCommand('type results.log'), false);
  assert.equal(classifyCommand('cat /var/log/printer/status.log'), false);
});

// T7: 000の記録（神原さん件）の直接読みが違反検出
test('T7 000の記録の直接読みが違反検出', () => {
  assert.equal(classifyCommand('cat ~/records/kambara.json'), false);
  assert.equal(classifyCommand('Get-Content records/someone.txt'), false);
  assert.equal(classifyCommand('type some-random-file.csv'), false);
});

// T8: 許可コマンド2種は違反にならない
test('T8 許可コマンド2種は違反にならない', () => {
  // (a) claude -p 起動
  assert.equal(classifyCommand('claude -p "do something"'), true);
  assert.equal(classifyCommand('run-cc.ps1'), true);
  assert.equal(classifyCommand('& ./run-cc-task.ps1'), true);
  // (b) 許可ファイル読み
  assert.equal(classifyCommand('cat REPORT.md'), true);
  assert.equal(classifyCommand('Get-Content DONE.txt'), true);
  assert.equal(classifyCommand('type PROGRESS.md'), true);
  assert.equal(classifyCommand('cat ./results/REPORT.md'), true);
  // 大文字小文字
  assert.equal(classifyCommand('CAT REPORT.MD'), true);
  assert.equal(classifyCommand('GET-CONTENT DONE.TXT'), true);
});

// T9: 日次集計と PASS/FAIL 判定
test('T9 日次集計と PASS/FAIL 判定', () => {
  // PASS ケース
  const passRecord = {
    date: '2026-11-28',
    entries: [
      { ts: '2026-11-28T01:00:00Z', pc: '999', command: 'claude -p "check inbox"' },
      { ts: '2026-11-28T02:00:00Z', pc: '999', command: 'cat REPORT.md' },
    ],
  };
  const passResult = dailyCheck(passRecord);
  assert.equal(passResult.verdict, 'PASS');
  assert.equal(passResult.total, 2);
  assert.equal(passResult.violations.length, 0);

  // FAIL ケース（複合コマンド）
  const failRecord = {
    date: '2026-11-28',
    entries: [
      { ts: '2026-11-28T01:00:00Z', pc: '999', command: 'claude -p "check" && cat REPORT.md' },
    ],
  };
  const failResult = dailyCheck(failRecord);
  assert.equal(failResult.verdict, 'FAIL');
  assert.equal(failResult.violations.length, 1);

  // FAIL ケース（ログの直接読み）
  const failRecord2 = {
    date: '2026-11-28',
    entries: [
      { ts: '2026-11-28T01:00:00Z', pc: '999', command: 'cat printer-history.log' },
    ],
  };
  const failResult2 = dailyCheck(failRecord2);
  assert.equal(failResult2.verdict, 'FAIL');

  // 空 record
  const emptyRecord = { date: '2026-11-28', entries: [] };
  const emptyResult = dailyCheck(emptyRecord);
  assert.equal(emptyResult.verdict, 'PASS');
  assert.equal(emptyResult.total, 0);

  // ファイルからの読み込み
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-test-t9-'));
  const filePath = path.join(home, 'grobo-direct.json');
  fs.writeFileSync(filePath, JSON.stringify(passRecord), 'utf8');
  const fileResult = dailyFromFile(filePath);
  assert.equal(fileResult.verdict, 'PASS');
});