import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseLogTime,
  findClaudeLogFiles,
  parseVscodeLog,
  parseHygieneLog,
  classifyExitReason,
  diagnoseExitEvents,
  DATADOG_NOTE,
  main,
} from './vscode-exit-diagnose.mjs';

test('parseLogTime: ローカル時刻と ISO 時刻(Z付き)の相互パース', () => {
  const localMs = parseLogTime('2026-10-04 12:34:56.789');
  assert.ok(Number.isFinite(localMs));

  const isoMs = parseLogTime('2026-10-04T12:34:56.789Z');
  assert.ok(Number.isFinite(isoMs));

  assert.ok(Number.isNaN(parseLogTime('invalid time')));
});

test('classifyExitReason: 4種類の判定を期待どおり返す', () => {
  // 1. process-hygiene の kill
  assert.equal(
    classifyExitReason({ hygieneMatch: true, hasChannelClose: true, totalSimultaneous: 2 }),
    'process-hygiene の kill'
  );

  // 2. 拡張側クローズ（一斉 N件）
  assert.equal(
    classifyExitReason({ hygieneMatch: false, hasChannelClose: true, totalSimultaneous: 3 }),
    '拡張側クローズ（一斉 3件）'
  );

  // 3. 拡張側クローズ（単独）
  assert.equal(
    classifyExitReason({ hygieneMatch: false, hasChannelClose: true, totalSimultaneous: 1 }),
    '拡張側クローズ'
  );

  // 4. 原因不明
  assert.equal(
    classifyExitReason({ hygieneMatch: false, hasChannelClose: false, totalSimultaneous: 1 }),
    '原因不明（同じ window の exthost.log を見る）'
  );
});

test('findClaudeLogFiles: ディレクトリ階層から Claude VSCode.log を正しく検出', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-diag-find-'));
  try {
    const targetDir = path.join(tmpDir, '20261004', 'window1', 'exthost', 'anthropic.claude-code');
    fs.mkdirSync(targetDir, { recursive: true });
    const logFile = path.join(targetDir, 'Claude VSCode.log');
    fs.writeFileSync(logFile, 'log content');

    const unrelatedDir = path.join(tmpDir, 'other');
    fs.mkdirSync(unrelatedDir, { recursive: true });
    fs.writeFileSync(path.join(unrelatedDir, 'unrelated.log'), 'other content');

    const files = findClaudeLogFiles(tmpDir);
    assert.equal(files.length, 1);
    assert.equal(path.resolve(files[0]), path.resolve(logFile));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseVscodeLog & parseHygieneLog: ログ内容の正確な抽出', () => {
  const vscodeContent = [
    '2026-10-04 12:00:00.000 [info] Starting Claude',
    '2026-10-04 12:05:00.000 [info] Closing Claude on channel: main',
    '2026-10-04 12:05:00.100 [info] Process exited with code 1',
    '2026-10-04 12:06:00.000 [info] Line 1',
    '2026-10-04 12:07:00.000 [info] Line 2',
    '2026-10-04 12:08:00.000 [info] Line 3',
    '2026-10-04 12:10:00.000 [info] Process exited with code 137',
    '2026-10-30 21:24:14.795 [error] Error: Claude Code process exited with code 3221225786. stderr: x',
  ].join('\n');

  const events = parseVscodeLog(vscodeContent, 'test.log');
  assert.equal(events.length, 3);
  assert.equal(events[0].code, '1');
  assert.equal(events[0].hasChannelClose, true);
  assert.equal(events[1].code, '137');
  assert.equal(events[1].hasChannelClose, false);
  assert.equal(events[2].code, '3221225786');
  assert.equal(events[2].hasChannelClose, false);

  const hygieneContent = [
    '2026-10-04T12:04:30.000Z category=vscode-claude-idle pid=100',
    '2026-10-04T12:20:00.000Z category=other pid=101',
  ].join('\n');

  const hygieneEvents = parseHygieneLog(hygieneContent);
  assert.equal(hygieneEvents.length, 1);
});

test('一括診断 (diagnoseExitEvents) & main 関数の統合テスト', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsc-diag-main-'));
  try {
    const logsRoot = path.join(tmpDir, 'Code', 'logs');
    const win1 = path.join(logsRoot, '20261004', 'window1', 'exthost', 'anthropic.claude-code');
    const win2 = path.join(logsRoot, '20261004', 'window2', 'exthost', 'anthropic.claude-code');
    fs.mkdirSync(win1, { recursive: true });
    fs.mkdirSync(win2, { recursive: true });

    // window1: hygiene kill パターン
    const log1Content = [
      '2026-10-04 12:00:00.000 [info] Closing Claude on channel: main',
      '2026-10-04 12:00:01.000 [info] Process exited with code 1',
    ].join('\n');
    fs.writeFileSync(path.join(win1, 'Claude VSCode.log'), log1Content);

    // window2: 一斉クローズパターン（window1の12:00:01と同時に別窓でexit）
    const log2Content = [
      '2026-10-04 12:00:00.500 [info] Closing Claude on channel: second',
      '2026-10-04 12:00:01.200 [info] Process exited with code 1',
      '2026-10-04 12:10:00.000 [info] Line 1',
      '2026-10-04 12:20:00.000 [info] Line 2',
      '2026-10-04 12:30:00.000 [info] Line 3',
      '2026-10-04 13:00:00.000 [info] Process exited with code 2', // 原因不明
    ].join('\n');
    fs.writeFileSync(path.join(win2, 'Claude VSCode.log'), log2Content);

    // hygiene ログ (12:00:01 の ±120s 以内にヒットするイベントを置く)
    const hygieneLog = path.join(tmpDir, 'hygiene.log');
    const tHygiene = new Date(parseLogTime('2026-10-04 12:00:01.000')).toISOString();
    fs.writeFileSync(hygieneLog, `${tHygiene} category=vscode-claude-idle pid=50\n`);

    const tSince = new Date(parseLogTime('2026-10-04 11:00:00.000')).toISOString();

    // ログキャプチャで main を検証
    let stdoutText = '';
    const originalLog = console.log;
    console.log = (msg) => { stdoutText += msg + '\n'; };

    try {
      await main(['--since', tSince, '--logs-root', logsRoot, '--hygiene-log', hygieneLog, '--json'], { now: parseLogTime('2026-10-04 14:00:00.000') });
      const jsonResult = JSON.parse(stdoutText);
      assert.equal(jsonResult.note, DATADOG_NOTE);
      assert.equal(jsonResult.events.length, 3);

      // 12:00:01 のイベントは hygieneMatch が true になる
      const hygieneDiagnosed = jsonResult.events.find((e) => e.timeStr === '2026-10-04 12:00:01.000');
      assert.ok(hygieneDiagnosed);
      assert.equal(hygieneDiagnosed.diagnosis, 'process-hygiene の kill');

      // 13:00:00 のイベントは channelClose=false, hygieneMatch=false -> 原因不明
      const unknownDiagnosed = jsonResult.events.find((e) => e.timeStr === '2026-10-04 13:00:00.000');
      assert.ok(unknownDiagnosed);
      assert.equal(unknownDiagnosed.diagnosis, '原因不明（同じ window の exthost.log を見る）');

    } finally {
      console.log = originalLog;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
