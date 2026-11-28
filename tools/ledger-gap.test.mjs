#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  decodeText, redactSecrets, stableId,
  classifyWorkDir, defaultDue, buildAddArgs, openItem, scanReports,
} from './ledger-open-item.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── helper ──

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(__dirname, `.test-${prefix}-`));
  test.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ── 1: 神原グループ再現（UPDATE + 残件） ──

test('1: kanbara reproduction — UPDATE with 金さん待ち and 残件', () => {
  const result = classifyWorkDir({
    dirName: 'kanbara-groups-1126',
    statusText: 'UPDATE 2026-11-26 19:30 JST 100人未復旧・金さん待ち／PC=000 で対応中',
    reportText: '## 残件：ユーザー復旧が未完了\n100人分のグループ再追加が必要',
    exitText: '',
    doneExists: false,
    mtime: Date.now() - 3600000,
  }, new Date('2026-11-27T12:00:00+09:00'));
  assert.ok(result.incomplete, '未完了と判定されるべき');
  assert.ok(result.kimWaiting, '金さん待ち');
  assert.equal(result.ownerPc, '000', 'PC=000 を検出');
  assert.ok(result.reasons.length > 0);
  assert.ok(result.remaining.includes('100人'));
});

// ── 2: classify の正常終了（exit=0, 完了）──

test('2: normal exit=0 no keywords — not incomplete', () => {
  const result = classifyWorkDir({
    dirName: 'normal-work',
    statusText: 'START ...\nEND ... exit=0',
    reportText: '',
    exitText: '0',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.equal(result.incomplete, false, 'exit=0 未完了キーワード無しは完了');
});

// ── 3: EXIT=0 + DONE → 完了 ──

test('3: EXIT 0 with DONE file — not incomplete', () => {
  const result = classifyWorkDir({
    dirName: 'done-work',
    statusText: 'START ...\nEND ... exit=0',
    reportText: '',
    exitText: '0',
    doneExists: true,
    mtime: Date.now(),
  });
  assert.equal(result.incomplete, false);
});

// ── 4: EXIT=1 → 未完了 ──

test('4: EXIT non-zero — incomplete', () => {
  const result = classifyWorkDir({
    dirName: 'failed-work',
    statusText: 'START ...\nEND ... exit=1',
    reportText: '',
    exitText: '1',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result.incomplete);
  assert.ok(result.reasons.some(r => r.includes('exit=1')));
});

// ── 5: 週次上限・usage limit → 未完了 ──

test('5: weekly limit / usage limit — incomplete', () => {
  const result1 = classifyWorkDir({
    dirName: 'limit-work',
    statusText: 'END ... exit=0\nログに usage limit 上限超過',
    reportText: '',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result1.incomplete, 'usage limit は未完了');
  assert.ok(result1.reasons.some(r => r.includes('上限') || r.includes('usage limit')));

  const result2 = classifyWorkDir({
    dirName: 'weekly-limit',
    statusText: '上限超過で強制終了',
    reportText: '',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result2.incomplete, '上限超過は未完了');
});

// ── 6: 冪等 ──

test('6: openItem same item same existingRows — both added (no existingRows tracking)', () => {
  const runCalls = [];
  const runAdd = (args) => { runCalls.push(args); };

  const item = {
    id: 'GB-OPEN-test-work',
    task: '未完了の作業',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '2026-11-28 09:00',
    status: '止まった',
    reason: 'exit=1',
  };

  const result1 = openItem(item, { existingRows: [], runAdd, dryRun: false });
  assert.equal(result1.action, 'added');
  assert.equal(runCalls.length, 1);

  // 同じ item を同じ existingRows（空）で呼ぶと毎回 added（existingRows に id が無いため）
  const result2 = openItem(item, { existingRows: [], runAdd, dryRun: false });
  assert.equal(result2.action, 'added');
  assert.equal(runCalls.length, 2, '既存行が無いので毎回 add');
});

// ── 7: 既存ID → skip-existing ──

test('7: existing id in ledger — skip', () => {
  const runCalls = [];
  const existingRows = [{ id: 'GB-OPEN-already', status: '依頼中', task: '何か', ownerPc: '000' }];
  const item = {
    id: 'GB-OPEN-already',
    task: '重複',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  };
  const result = openItem(item, { existingRows, runAdd: (a) => runCalls.push(a), dryRun: false });
  assert.equal(result.action, 'skip-existing');
  assert.equal(runCalls.length, 0);
});

// ── 8: openItem + scanReports 重複防止 ──

test('8: scanReports with existing id — no duplicate', async () => {
  const root = tmpDir('8-dupe');
  const workDir = path.join(root, 'test-project-1128');
  fs.mkdirSync(workDir);
  writeFile(path.join(workDir, 'STATUS.txt'), 'UPDATE 2026-11-28 JST 100人未復旧・金さん待ち');

  // 既に台帳にある行として（id は stableId で生成したものと同じにする）
  const itemId = stableId('test-project-1128');
  const existingRows = [{
    id: itemId,
    status: '依頼中',
    task: 'テストプロジェクト',
    ownerPc: '000',
  }];

  const results = await scanReports({
    root,
    pc: '000',
    existingRows,
    now: new Date(),
    fsImpl: fs,
    scanSessionStatus: false,
  });
  // existingRows に同じ id があるので追加されない
  // scan は結果を返すが action は skip-existing になる
  for (const r of results) {
    assert.equal(r.action, 'skip-existing', '既存行があるのでスキップ');
  }
});

// ── 9: 残件あり（部分完了） → 残件だけを task に ──

test('9: partial complete with 残件 — remaining extracted', () => {
  const result = classifyWorkDir({
    dirName: 'partial-work',
    statusText: 'UPDATE 2026-11-28 メイン処理完了 残件：別紙の署名取得が必要',
    reportText: '## 残件：別紙の署名取得が必要\n- 書類A: 未署名\n- 書類B: 未署名',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result.incomplete);
  assert.ok(result.remaining);
  assert.ok(result.remaining.includes('署名'));
});

// ── 10: 文字コード（BOM有/無・UTF-16LE）＋ 秘密値の伏せ字 ──

test('10a: decodeText UTF-8 BOM, UTF-16LE', () => {
  // UTF-8 BOM
  const utf8Bom = new Uint8Array([0xEF, 0xBB, 0xBF, 0xE6, 0x97, 0xA5, 0xE6, 0x9C, 0xAC]); // 日本
  assert.equal(decodeText(utf8Bom), '日本');

  // UTF-8 no BOM
  const utf8NoBom = new Uint8Array([0xE6, 0x97, 0xA5]); // 日
  assert.equal(decodeText(utf8NoBom), '日');

  // UTF-16LE with BOM
  // 0xFF 0xFE BOM, then '日' (0xE5 0x30) in LE
  const utf16Le = new Uint8Array([0xFF, 0xFE, 0xE5, 0x30]);
  const decoded = decodeText(utf16Le);
  assert.ok(decoded.length > 0);

  // UTF-16BE with BOM
  const utf16Be = new Uint8Array([0xFE, 0xFF, 0x30, 0xE5]);
  const decodedBe = decodeText(utf16Be);
  assert.ok(decodedBe.length > 0);
});

test('10b: redactSecrets — tokens redacted', () => {
  const withToken = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD token here';
  const result = redactSecrets(withToken);
  assert.ok(!result.includes('abcdefghijklmnopqrstuvwxyz'), 'トークンが伏せられた');
  assert.ok(result.includes('***REDACTED***'));

  const withPassword = 'password=mysecretpass';
  const result2 = redactSecrets(withPassword);
  assert.ok(result2.includes('***REDACTED***'));
  assert.ok(!result2.includes('mysecretpass'));

  // no false positive on normal text
  const normal = '通常の日本語テキストです';
  assert.equal(redactSecrets(normal), normal);
});

test('10c: buildAddArgs redacts task/reason', () => {
  const args = buildAddArgs({
    id: 'GB-OPEN-test',
    task: 'ghp_abcdefghijklmnopqrstuvwxyz123456 token 処理',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '2026-11-28 09:00',
    status: '止まった',
    reason: 'failure with token=secret123',
  });
  const joined = args.join(' ');
  assert.ok(!joined.includes('abcdefghijklmnopqrstuvwxyz123456'), 'トークンが伏せられた');
});

// ── 11: 完了済み作業が登録されない（回帰） ──

test('11: completed work — not registered', async () => {
  const root = tmpDir('11-complete');
  const workDir = path.join(root, 'completed-work');
  fs.mkdirSync(workDir);
  writeFile(path.join(workDir, 'STATUS.txt'), 'START ...\nEND ... exit=0');
  writeFile(path.join(workDir, 'DONE.txt'), '完了');

  const results = await scanReports({
    root,
    pc: '008',
    existingRows: [],
    now: new Date(),
    fsImpl: fs,
    scanSessionStatus: false,
  });
  assert.equal(results.length, 0, 'DONE のあるディレクトリは登録しない');
});

// ── 12: defaultDue の土日またぎ ──

test('12: defaultDue skips weekends', () => {
  // 2026-11-28 is Saturday
  const sat = new Date('2026-11-28T10:00:00+09:00');
  const dueSat = defaultDue({ kimWaiting: false, now: sat });
  const dueDate = new Date(dueSat + '+09:00');
  const dow = dueDate.getDay();
  assert.ok(dow !== 0 && dow !== 6, `土曜の期限は月〜金になるべき（got ${dow}: ${dueSat})`);

  // 金曜 → 月曜（9時過ぎ）
  const fri = new Date('2026-11-27T14:00:00+09:00');
  const dueFri = defaultDue({ kimWaiting: false, now: fri });
  const dowFri = new Date(dueFri + '+09:00').getDay();
  assert.ok(dowFri !== 0 && dowFri !== 6, `金曜の期限は月〜金になるべき（got ${dowFri}: ${dueFri}）`);
});

// ── 13: stableId の安定性 ──

test('13: stableId is deterministic', () => {
  const input = '神原グループ-1126-誤削除!@#$';
  const id1 = stableId(input);
  const id2 = stableId(input);
  assert.equal(id1, id2, '同じ入力から同じID');
  assert.match(id1, /^GB-OPEN-/);
  assert.ok(id1.length <= 80, '80文字以内');
  // 英数字・ハイフン・アンダースコアのみ
  assert.match(id1, /^[a-zA-Z0-9_-]+$/);
});

// ── 14: classifyWorkDir の PC パターン ──

test('14: ownerPc detection from text', () => {
  const result = classifyWorkDir({
    dirName: 'pc-test',
    statusText: 'UPDATE 2026-11-28 PC=014 で対応中',
    reportText: '',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.equal(result.ownerPc, '014');
});

// ── 15: buildAddArgs の channel=manual / kind=automation ──

test('15: buildAddArgs channel and kind', () => {
  const args = buildAddArgs({
    id: 'GB-OPEN-test',
    task: 'テスト',
    ownerPc: '008',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  });
  const argStr = args.join(' ');
  assert.ok(argStr.includes('--channel manual'), 'channel=manual');
  assert.ok(argStr.includes('--kind automation'), 'kind=automation');
  assert.ok(argStr.includes('--tema-check'), 'tema-check あり');
});

// ── 16: empty gb-reports root でエラーにならない ──

test('16: scan empty root — no error', async () => {
  const root = tmpDir('16-empty');
  const results = await scanReports({
    root,
    pc: '008',
    existingRows: [],
    now: new Date(),
    fsImpl: fs,
    scanSessionStatus: false,
  });
  assert.equal(results.length, 0);
});

// ── 17: scanReports は status なしのディレクトリをスキップ ──

test('17: dir without STATUS.txt or REPORT.md — skip', async () => {
  const root = tmpDir('17-nostat');
  const workDir = path.join(root, 'no-status-work');
  fs.mkdirSync(workDir);
  // 空のディレクトリ — STATUS.txt も REPORT.md も無い
  const results = await scanReports({
    root,
    pc: '008',
    existingRows: [],
    now: new Date(),
    fsImpl: fs,
    scanSessionStatus: false,
  });
  assert.equal(results.length, 0);
});

// ── 18: 長い日本語パス ──

test('18: long Japanese path name — stableId works', () => {
  const longName = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
  const id = stableId(longName);
  assert.ok(id.length <= 80);
  assert.match(id, /^GB-OPEN-/);
});

// ── 19: scanReports session-status integration ──

test('19: scanReports reads session-status entries with matching status dirs', async () => {
  const root = tmpDir('19-session');
  const sessionDir = path.join(root, 'session-status');
  fs.mkdirSync(sessionDir);
  writeFile(path.join(sessionDir, 'STATUS-008.md'),
    '# session-status PC=008\n' +
    '- 008・stopped-work-1128・金さん待ち・何か保留中・期限2026-12-01・次:金さん判断\n'
  );

  // 対応するディレクトリを作る（DONE なし）
  const workDir = path.join(root, 'stopped-work-1128');
  fs.mkdirSync(workDir);
  writeFile(path.join(workDir, 'STATUS.txt'), 'UPDATE ... exit=0');

  const existingRows = [];

  const results = await scanReports({
    root,
    pc: '008',
    existingRows,
    now: new Date('2026-11-28T12:00:00+09:00'),
    fsImpl: fs,
    scanSessionStatus: true,
  });

  assert.ok(results.length > 0, 'session-status から何か登録される');
  const dirResults = results.filter(r => r.dir === 'stopped-work-1128');
  assert.ok(dirResults.length > 0, 'stopped-work-1128 が登録される');
});

// ── 20: buildAddArgs with status=依頼中（止まったでない） ──

test('20: buildAddArgs without stop status', () => {
  const args = buildAddArgs({
    id: 'GB-OPEN-normal',
    task: '通常の未完了作業',
    ownerPc: '008',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '2026-11-30 09:00',
    status: '依頼中',
    reason: '',
  });
  const argStr = args.join(' ');
  assert.ok(argStr.includes('--due 2026-11-30'), 'due が設定される');
});

// ── 21a: buildAddArgs — default has no --store ──

test('21a: buildAddArgs default — no --store flag', () => {
  const savedEnv = process.env.FOLLOWUP_STORE;
  delete process.env.FOLLOWUP_STORE;
  try {
    const args = buildAddArgs({
      id: 'GB-OPEN-store-test',
      task: 'テスト',
      ownerPc: '008',
      ownerAi: 'Claude Code',
      kimWaiting: false,
      due: '',
      status: '止まった',
      reason: 'exit=1',
    });
    const argStr = args.join(' ');
    assert.ok(!argStr.includes('--store'), '既定では --store が含まれない');
  } finally {
    process.env.FOLLOWUP_STORE = savedEnv;
  }
});

// ── 21b: buildAddArgs — FOLLOWUP_STORE=local adds --store local ──

test('21b: buildAddArgs with FOLLOWUP_STORE=local — includes --store local', () => {
  const savedEnv = process.env.FOLLOWUP_STORE;
  process.env.FOLLOWUP_STORE = 'local';
  try {
    const args = buildAddArgs({
      id: 'GB-OPEN-store-local',
      task: 'テスト',
      ownerPc: '008',
      ownerAi: 'Claude Code',
      kimWaiting: false,
      due: '',
      status: '止まった',
      reason: 'exit=1',
    });
    const argStr = args.join(' ');
    assert.ok(argStr.includes('--store local'), 'FOLLOWUP_STORE=local で --store local が含まれる');
  } finally {
    process.env.FOLLOWUP_STORE = savedEnv;
  }
});

// ── 21c: openItem(dryRun:false) — no --store in args passed to runAdd ──

test('21c: openItem(dryRun:false) — no --store in runAdd args', () => {
  const savedEnv = process.env.FOLLOWUP_STORE;
  delete process.env.FOLLOWUP_STORE;
  try {
    const runCalls = [];
    const runAdd = (args) => { runCalls.push(args); };
    const item = {
      id: 'GB-OPEN-runadd-store',
      task: 'runAdd store test',
      ownerPc: '008',
      ownerAi: 'Claude Code',
      kimWaiting: false,
      due: '',
      status: '止まった',
      reason: 'exit=1',
    };
    const result = openItem(item, { existingRows: [], runAdd, dryRun: false });
    assert.equal(result.action, 'added');
    assert.equal(runCalls.length, 1);
    const argStr = runCalls[0].join(' ');
    assert.ok(!argStr.includes('--store'), 'openItem が runAdd に渡す args に --store が含まれない');
  } finally {
    process.env.FOLLOWUP_STORE = savedEnv;
  }
});

// ── 21: module import test ──

test('21: module exports are valid', async () => {
  const mod = await import('./ledger-open-item.mjs');
  assert.ok(typeof mod.defaultDue === 'function');
  assert.ok(typeof mod.stableId === 'function');
  assert.ok(typeof mod.scanReports === 'function');
});

// ── 22: 類似タスクスキップ ──

test('22: similar task skip — 2-gram Jaccard >= 0.6', () => {
  const row1 = { id: 'GB-OPEN-sim1', status: '依頼中', task: 'ユーザー復旧が未完了（100人分）', ownerPc: '000' };
  const existingRows = [row1];

  // 類似タスク
  const simTask = 'ユーザー復旧が未完了（100人分の再追加）';
  const result = openItem({
    id: 'GB-OPEN-new',
    task: simTask,
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows, runAdd: () => {}, dryRun: false });
  assert.equal(result.action, 'skip-similar', '類似タスクはスキップ');
  assert.equal(result.matchId, 'GB-OPEN-sim1');

  // 無関係なタスク
  const diffTask = '確定申告の書類作成';
  const result2 = openItem({
    id: 'GB-OPEN-diff',
    task: diffTask,
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows, runAdd: () => {}, dryRun: false });
  assert.equal(result2.action, 'added', '無関係タスクは追加');

  // 完了済み行とは類似比較しない
  const completeRow = { id: 'GB-OPEN-done', status: '完了', task: 'ユーザー復旧が未完了（100人分）', ownerPc: '000' };
  const result3 = openItem({
    id: 'GB-OPEN-after-done',
    task: 'ユーザー復旧が未完了（100人分の再追加）',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows: [completeRow], runAdd: () => {}, dryRun: true });
  // completed 行とは類似比較しない → would-add
  assert.equal(result3.action, 'would-add');
});

// ── 23: dryRun モード ──

test('23: dryRun does not call runAdd', () => {
  const runCalls = [];
  const item = {
    id: 'GB-OPEN-dry',
    task: 'dry-run task',
    ownerPc: '008',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'test',
  };
  const result = openItem(item, { existingRows: [], runAdd: (a) => runCalls.push(a), dryRun: true });
  assert.equal(result.action, 'would-add');
  assert.equal(runCalls.length, 0);
  assert.ok(Array.isArray(result.args));
});

// ── 24: EXIT=1 in STATUS.txt ──

test('24: exit=1 in STATUS.txt END line', () => {
  const result = classifyWorkDir({
    dirName: 'exit-one',
    statusText: 'START 2026-11-28 10:00:00 claude_pid=12345 cwd=/work\nEND 2026-11-28 11:00:00 exit=1',
    reportText: '',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result.incomplete);
  assert.ok(result.reasons.some(r => r === 'exit=1'));
});

// ── 25: 最新行優先チェック ──

test('25: latest update line with incomplete keyword', () => {
  const result = classifyWorkDir({
    dirName: 'mixed-status',
    statusText: 'DONE 完了しました\nUPDATE 2026-11-28 JST まだ問題が残っている・金さん待ち',
    reportText: '',
    exitText: '',
    doneExists: false,
    mtime: Date.now(),
  });
  assert.ok(result.incomplete, 'UPDATE 行に未完了語があれば未完了');
  assert.ok(result.kimWaiting);
});

// ── 26: 停止・STATUS.mdなし・期限なしの巡回行は登録されない ──

test('26: session-status 停止 line without date/error — not registered', async () => {
  const root = tmpDir('26-stop-nodate');
  const sessionDir = path.join(root, 'session-status');
  fs.mkdirSync(sessionDir);
  writeFile(path.join(sessionDir, 'STATUS-008.md'),
    '# session-status PC=008\n' +
    '- 008・some-stopped-work・停止・最終更新11/28、STATUS.mdなし・期限なし・次:作業フォルダを確認して続きを進める\n'
  );

  const results = await scanReports({
    root,
    pc: '008',
    existingRows: [],
    now: new Date('2026-11-28T12:00:00+09:00'),
    fsImpl: fs,
    scanSessionStatus: true,
  });

  const stopResults = results.filter(r => r.dir === 'some-stopped-work');
  assert.equal(stopResults.length, 0, '期限なし・エラーなしの停止行は登録されない');
});

// ── 27: 金さん待ちの巡回行は登録される ──

test('27: session-status 金さん待ち line — registered', async () => {
  const root = tmpDir('27-kimwait');
  const sessionDir = path.join(root, 'session-status');
  fs.mkdirSync(sessionDir);
  writeFile(path.join(sessionDir, 'STATUS-008.md'),
    '# session-status PC=008\n' +
    '- 008・waiting-work・金さん待ち・何か保留中・次:金さん判断\n'
  );

  const results = await scanReports({
    root,
    pc: '008',
    existingRows: [],
    now: new Date('2026-11-28T12:00:00+09:00'),
    fsImpl: fs,
    scanSessionStatus: true,
  });

  const waitResults = results.filter(r => r.dir === 'waiting-work');
  assert.ok(waitResults.length > 0, '金さん待ち行は登録される');
});

// ── 28: 日本語名 stableId がハッシュ付きで安定、別名と衝突しない ──

test('28: stableId with non-ASCII gets hash, different names differ', () => {
  const input1 = '20261126-EOラーニング-神原グループ復旧';
  const input2 = '20261126-別件-データ移行';

  const id1 = stableId(input1);
  const id2 = stableId(input2);

  // 両方にハッシュが付く
  assert.match(id1, /-[a-f0-9]{8}$/, '非ASCII名にハッシュが付く');
  assert.match(id2, /-[a-f0-9]{8}$/, '非ASCII名にハッシュが付く');

  // ハッシュが異なる（sha1 が異なるため）
  assert.notEqual(id1, id2, '異なる非ASCII名は異なるID');

  // 同じ入力 → 同じID
  assert.equal(stableId(input1), id1, '同じ入力で同じID');

  // 80文字以内
  assert.ok(id1.length <= 80, '80文字以内');
  assert.ok(id2.length <= 80, '80文字以内');

  // 英数字・ハイフン・アンダースコアのみ
  assert.match(id1, /^[a-zA-Z0-9_-]+$/);
  assert.match(id2, /^[a-zA-Z0-9_-]+$/);
});

// ── 29: LEDGER_SELF_DIR / --exclude のフォルダは登録されない ──

test('29: LEDGER_SELF_DIR and exclude skip registration', async () => {
  const root = tmpDir('29-exclude');
  const selfDir = path.join(root, 'my-current-work');
  fs.mkdirSync(selfDir);
  writeFile(path.join(selfDir, 'STATUS.txt'), 'UPDATE 2026-11-28 JST 何か保留中・金さん待ち');

  const excludeDir = path.join(root, 'excluded-work');
  fs.mkdirSync(excludeDir);
  writeFile(path.join(excludeDir, 'STATUS.txt'), 'UPDATE 2026-11-28 JST 未完了作業');

  // LEDGER_SELF_DIR 設定
  const origEnv = process.env.LEDGER_SELF_DIR;
  process.env.LEDGER_SELF_DIR = 'my-current-work';
  try {
    const results = await scanReports({
      root,
      pc: '008',
      existingRows: [],
      now: new Date('2026-11-28T12:00:00+09:00'),
      fsImpl: fs,
      scanSessionStatus: false,
      exclude: ['excluded-work'],
    });

    const selfResult = results.find(r => r.dir === 'my-current-work');
    assert.equal(selfResult, undefined, 'LEDGER_SELF_DIR のフォルダは登録されない');

    const excludedResult = results.find(r => r.dir === 'excluded-work');
    assert.equal(excludedResult, undefined, '--exclude 指定のフォルダは登録されない');
  } finally {
    process.env.LEDGER_SELF_DIR = origEnv;
  }
});

// ── 30: 既存行の task に GB174 があれば skip-existing ──

test('30: existing row with folder name in task — skip-existing', () => {
  const existingRows = [
    { id: 'GB174-restore-1128', status: '依頼中', task: 'GB174 ユーザー復旧', ownerPc: '000' },
  ];

  // フォルダ名が既存行の task に含まれる
  const result = openItem({
    id: 'GB-OPEN-kanbara-groups-1126',
    task: '未完: kanbara-groups-1126（金さん待ち）',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '',
    status: '止まった',
    reason: '金さん待ち',
  }, { existingRows, runAdd: () => {}, dryRun: false, originalName: 'kanbara-groups-1126' });

  // existingRows[0].task に 'GB174' が含まれるが、originalName や id は含まれない
  // なので similar のみチェックされるが、similarity は低いので added になる
  // このテストは originalName が行の task/id に含まれる場合を検証する
  // → ここでは含まれないので added
  assert.equal(result.action, 'added', '無関係な行はスキップされない');

  // 今度は既存行の task にフォルダ名が含まれる場合
  const existingRows2 = [
    { id: 'GB174-common-users-restore', status: '依頼中', task: 'kanbara-groups-1126 ユーザー復旧', ownerPc: '000' },
  ];
  const result2 = openItem({
    id: 'GB-OPEN-kanbara-groups-1126',
    task: '未完: kanbara-groups-1126（金さん待ち）',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '',
    status: '止まった',
    reason: '金さん待ち',
  }, { existingRows: existingRows2, runAdd: () => {}, dryRun: false, originalName: 'kanbara-groups-1126' });

  assert.equal(result2.action, 'skip-existing', '既存行の task にフォルダ名があればスキップ');
  assert.equal(result2.matchId, 'GB174-common-users-restore');
});

// ── 31: dry-run で scanReports 経由でも runAdd が呼ばれない ──

test('31: scanReports with dryRun — runAdd not called', async () => {
  const root = tmpDir('31-dryrun');
  const workDir = path.join(root, 'incomplete-work');
  fs.mkdirSync(workDir);
  writeFile(path.join(workDir, 'STATUS.txt'), 'UPDATE 2026-11-28 JST 100人未復旧・金さん待ち');

  let runAddCalled = false;
  const runAdd = () => { runAddCalled = true; };

  const results = await scanReports({
    root,
    pc: '000',
    existingRows: [],
    now: new Date('2026-11-28T12:00:00+09:00'),
    fsImpl: fs,
    scanSessionStatus: false,
    dryRun: true,
  });

  // openItem 内で dryRun が true なら runAdd は呼ばれない
  // scanReports 内で openItem に dryRun を渡すようになったので、
  // 結果は would-add になる
  const addedResults = results.filter(r => r.action === 'would-add');
  assert.ok(addedResults.length > 0, 'dry-run で would-add が返る');
  assert.equal(runAddCalled, false, 'runAdd は呼ばれない');
});

// ── 32: 短いフォルダ名の誤一致防止 ──

test('32: unrelated existing row does not block different folder name', () => {
  // 短い名前（3文字以下）が既存行のどのフィールドにも含まれなければ would-add
  const existingRows = [
    { id: 'GB174-restore-1128', status: '依頼中', task: 'GB174 ユーザー復旧', ownerPc: '000' },
  ];
  const result = openItem({
    id: 'GB-OPEN-ss',
    task: '未完: ss（failed）',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows, runAdd: () => {}, dryRun: true, originalName: 'ss' });
  assert.equal(result.action, 'would-add', '無関係な短い名前は would-add');

  // 短い名前が既存行の task に単語として完全一致すればスキップ
  const existingRows2 = [
    { id: 'GB-some-task', status: '依頼中', task: 'ss の処理', ownerPc: '000' },
  ];
  const result2 = openItem({
    id: 'GB-OPEN-ss',
    task: '未完: ss',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows: existingRows2, runAdd: () => {}, dryRun: true, originalName: 'ss' });
  assert.equal(result2.action, 'skip-existing', '短い名前が単語として完全一致すればスキップ');
  assert.equal(result2.matchId, 'GB-some-task');

  // 短い名前 "tasks" が長い単語 "mytasks" の部分文字列として現れても一致しない
  const existingRows3 = [
    { id: 'GB-mytask', status: '依頼中', task: 'mytasks 処理', ownerPc: '000' },
  ];
  const result3 = openItem({
    id: 'GB-OPEN-tasks',
    task: '未完: tasks',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: false,
    due: '',
    status: '止まった',
    reason: 'exit=1',
  }, { existingRows: existingRows3, runAdd: () => {}, dryRun: true, originalName: 'tasks' });
  assert.equal(result3.action, 'would-add', '短い名前の部分文字列一致ではスキップしない');

  // 長い名前（16文字 > 3）は従来通り部分一致でスキップ（kanbara-groups-1126 の回帰）
  const existingRows4 = [
    { id: 'GB174-common-users-restore', status: '依頼中', task: 'kanbara-groups-1126 ユーザー復旧', ownerPc: '000' },
  ];
  const result4 = openItem({
    id: 'GB-OPEN-kanbara-groups-1126',
    task: '未完: kanbara-groups-1126（金さん待ち）',
    ownerPc: '000',
    ownerAi: 'Claude Code',
    kimWaiting: true,
    due: '',
    status: '止まった',
    reason: '金さん待ち',
  }, { existingRows: existingRows4, runAdd: () => {}, dryRun: true, originalName: 'kanbara-groups-1126' });
  assert.equal(result4.action, 'skip-existing', '長い名前は部分一致でスキップ');
});