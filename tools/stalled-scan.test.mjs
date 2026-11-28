#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  scanCase, scanReports, scanReportsWithBreakdown, enumerateCaseDirs, readCaseFiles,
  containsStalledKeywords, extractKimOnlyAction, isKimWaiting,
  findExistingEntries, toAddFlags, normalizeFolderName,
  selftest, STALLED_KEYWORDS, SKIP_FOLDERS, STATUS_INDICATOR_FILES, isValidCaseFolder,
} from './lib/stalled-scan.mjs';
import { main, loadLocalStore, parseArgs as followupParseArgs } from './followup-ledger.mjs';

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(__dirname, `.stalled-scan-test-${name}-`));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function touchFile(filePath, mtime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
  if (mtime) {
    const m = mtime instanceof Date ? mtime : new Date(mtime);
    fs.utimesSync(filePath, m, m);
  }
}

function writeFile(filePath, content, mtime) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  if (mtime) {
    const m = mtime instanceof Date ? mtime : new Date(mtime);
    fs.utimesSync(filePath, m, m);
  }
}

// Helper: create a mock gb-reports structure for testing
function createMockReports(baseDir, cases) {
  const reportsDir = path.join(baseDir, 'gb-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  for (const c of cases) {
    const caseDir = path.join(reportsDir, c.name);
    fs.mkdirSync(caseDir, { recursive: true });
    if (c.files) {
      for (const f of c.files) {
        writeFile(path.join(caseDir, f.name), f.content || '', f.mtime);
      }
    }
  }
  return reportsDir;
}

/**
 * Integration test helper: runs stalled-scan via main() with temp gb-reports and temp ledger.
 * The ledger is stored under a tmp dir so the real ~/.claude/followup-ledger is never touched.
 */
async function stalledScanScenario(name, cases, fn, overrides = {}) {
  const dir = tmpDir(name);
  const reportsDir = createMockReports(dir, cases);
  const ledgerDir = path.join(dir, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const config = {
    spreadsheetId: '',
    url: '',
    owner: 'seisaku-team@orgiast.jp',
    approvalChannelId: '',
    approverUserIds: [],
    approvalTimeoutMinutes: 120,
    quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' },
    alertFile: path.join(dir, 'ALERT.md'),
    pcAliases: {},
    ...overrides,
  };

  const env = { ...process.env, FOLLOWUP_LEDGER_HOME: ledgerDir, FOLLOWUP_PC: 'test-pc' };
  const prev = {};
  for (const key of Object.keys(env)) prev[key] = process.env[key];
  Object.assign(process.env, env);
  try {
    const run = (extraArgs = [], options = {}) => main(
      ['stalled-scan', '--store', 'local', '--reports-dir', reportsDir, '--pc', 'test-pc', ...extraArgs],
      { config, storeMode: 'local', now: options.now || new Date() },
    );
    const store = () => loadLocalStore(path.join(ledgerDir, 'ledger.json'));
    await fn({ dir, reportsDir, run, store });
  } finally {
    for (const key of Object.keys(env)) {
      if (key in prev) process.env[key] = prev[key];
      else delete process.env[key];
    }
  }
}

async function withEnv(env, fn) {
  const prev = { ...process.env };
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in prev)) delete process.env[key];
    }
    Object.assign(process.env, prev);
  }
}

// ===== T1: 神原型（統合テスト版） =====
test('T1: 神原型（STATUS.txt「金さん待ち・100人未復旧」、DONE無し、INCIDENT.md有り）→ main経由で登録される', async () => {
  await stalledScanScenario('t1', [
    {
      name: 'common-users-delete-incident',
      files: [
        { name: 'STATUS.txt', content: '状態: 金さん待ち\n理由: 100人未復旧\n次の一手: 金さんの確認が必要' },
        { name: 'INCIDENT.md', content: '# INCIDENT\ncommon.users 誤削除' },
      ],
    },
  ], async ({ run, store }) => {
    const code = await run();
    assert.equal(code, 0);
    const items = store().items;
    assert.equal(items.length, 1);
    const row = items[0];
    assert.match(row.id, /GB-STALL-test-pc-common-users-delete-incident/);
    assert.match(row.statusReason, /金さん待ち/);
    assert.match(row.statusReason, /未復旧/);
    assert.ok(row.kimOnlyAction);
    assert.equal(row.status, '止まった');
    // due: INCIDENT なので当日 23:59 JST
    const dueDate = new Date(row.dueAt);
    assert.equal(dueDate.getHours(), 23);
    assert.equal(dueDate.getMinutes(), 59);
    assert.equal(row.ownerPc, 'test-pc');
  });
});
test('T1: 神原型（STATUS.txt「金さん待ち・100人未復旧」、DONE無し、INCIDENT.md有り）→登録される', () => {
  const dir = tmpDir('t1');
  const reportsDir = createMockReports(dir, [
    {
      name: 'common-users-delete-incident',
      files: [
        { name: 'STATUS.txt', content: '状態: 金さん待ち\n理由: 100人未復旧\n次の一手: 金さんの確認が必要' },
        { name: 'INCIDENT.md', content: '# INCIDENT\ncommon.users 誤削除' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
  const r = results[0];
  assert.match(r.id, /GB-STALL-test-pc-common-users-delete-incident/);
  assert.match(r.reason, /金さん待ち/);
  assert.match(r.reason, /未復旧/);
  assert.ok(r.hasIncident);
  assert.ok(r.kimOnlyAction);
  // INCIDENT は当日 23:59
  const dueDate = new Date(r.due);
  assert.equal(dueDate.getHours(), 23);
  assert.equal(dueDate.getMinutes(), 59);
});

// ===== T2: 重複防止（統合テスト版） =====
test('T2: 同じ物を2回走査→ store.items は1行', async () => {
  await stalledScanScenario('t2', [
    {
      name: 'stalled-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: 承認待ち' },
      ],
    },
  ], async ({ run, store }) => {
    const code1 = await run();
    assert.equal(code1, 0);
    assert.equal(store().items.length, 1);
    // 2回目（upsert: 同じ id が既存なので上書き、件数は1のまま）
    const code2 = await run();
    assert.equal(code2, 0);
    assert.equal(store().items.length, 1);
    const row = store().items[0];
    assert.match(row.id, /GB-STALL-test-pc-stalled-case/);
    assert.equal(row.status, '止まった');
  });
});

// ===== T3: GB-174 重複（統合テスト版） =====
test('T3: GB-174 が先に同キー行を入れていた→2回目後も1行、updatedAt更新', async () => {
  await stalledScanScenario('t3', [
    {
      name: 'stalled-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: 承認待ち' },
      ],
    },
  ], async ({ run, store }) => {
    // 1回目: 登録
    await run();
    assert.equal(store().items.length, 1);
    const firstUpdatedAt = store().items[0].updatedAt;
    // 手動で updatedAt を過去に書き換え（更新を検証するため）
    const oldTime = new Date(Date.now() - 86400000).toISOString();
    const ledgerPath = path.join(path.dirname(store()._file || ''), 'ledger.json');
    // 1回目の走査で items は既に1件ある。updatedAt を書き換え
    store().items[0].updatedAt = oldTime;
    // 2回目: upsert で更新
    await run();
    assert.equal(store().items.length, 1);
    const secondUpdatedAt = store().items[0].updatedAt;
    assert.notEqual(secondUpdatedAt, oldTime, 'updatedAt が更新されていない');
    assert.match(store().items[0].id, /GB-STALL-test-pc-stalled-case-/);
    assert.equal(store().items[0].status, '止まった');
  });
});

// ===== T4: DONE 完了 =====
test('T4: DONE.txt あり・本文「完了」→載らない', () => {
  const dir = tmpDir('t4');
  const reportsDir = createMockReports(dir, [
    {
      name: 'completed-case',
      files: [
        { name: 'DONE.txt', content: '完了' },
        { name: 'STATUS.txt', content: '状態: 完了\n理由: 作業完了' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 0);
});

// ===== T5: DONE無し・6h以上更新なし =====
test('T5: DONE無し・6h以上更新なし→「止まった」で載る', () => {
  const dir = tmpDir('t5');
  const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago
  const reportsDir = createMockReports(dir, [
    {
      name: 'abandoned-case',
      files: [
        { name: 'PROGRESS.md', content: '進捗: 途中まで', mtime: oldTime },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
  assert.match(results[0].id, /GB-STALL-test-pc-abandoned-case/);
  assert.match(results[0].reason, /止まった（未完了）/);
});

// ===== T6: 各検出語 =====
test('T6: 「中断」「承認待ち」「ブロック」各語→載る', () => {
  const dir = tmpDir('t6');
  const reportsDir = createMockReports(dir, [
    {
      name: 'case-interrupted',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: 外部要因' },
      ],
    },
    {
      name: 'case-approval',
      files: [
        { name: 'STATUS.md', content: '状態: 承認待ち' },
      ],
    },
    {
      name: 'case-blocked',
      files: [
        { name: 'STATUS.txt', content: '状態: ブロック\n理由: 先方未返信' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 3, `Expected 3 results, got ${results.length}: ${results.map(r => r.folder).join(', ')}`);
  assert.ok(results.some((r) => r.reason.includes('中断')), '中断 not found');
  assert.ok(results.some((r) => r.reason.includes('承認待ち')), '承認待ち not found');
  assert.ok(results.some((r) => r.reason.includes('ブロック')), 'ブロック not found');
});

// ===== T7: 期限・担当・金さんだけができること（統合テスト版） =====
test('T7: 台帳行の期限・ownerPc・kimOnlyAction・reasonが埋まる', async () => {
  await stalledScanScenario('t7', [
    {
      name: 'kim-waiting-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 金さん待ち\n理由: 支払い承認待ち\n次の一手: 金さんに請求書を確認してもらう' },
      ],
    },
  ], async ({ run, store }) => {
    const code = await run();
    assert.equal(code, 0);
    const items = store().items;
    assert.equal(items.length, 1);
    const row = items[0];
    // ID に pc 名を含む
    assert.match(row.id, /test-pc/);
    // ownerPc
    assert.equal(row.ownerPc, 'test-pc');
    // 金さんだけができること
    assert.ok(row.kimOnlyAction);
    assert.match(row.kimOnlyAction, /金さん/);
    // dueAt が設定されている
    assert.ok(row.dueAt);
    const dueMs = Date.parse(row.dueAt);
    assert.ok(Number.isFinite(dueMs));
    assert.ok(dueMs > Date.now());
    // reason に検出語と相対パスが含まれる
    assert.match(row.statusReason, /金さん待ち/);
    assert.match(row.statusReason, /kim-waiting-case/);
  });
});

// ===== T8: トークン風文字列 =====
test('T8: トークン風文字列→台帳に写らない', () => {
  const dir = tmpDir('t8');
  const reportsDir = createMockReports(dir, [
    {
      name: 'token-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: APIキー ghp_abcdefghijklmnopqrstuvwxyz123456 が失効' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
  const r = results[0];
  // トークン本体が理由に含まれていない
  assert.doesNotMatch(r.reason, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
  assert.doesNotMatch(r.reason, /abcdefghijklmnopqrstuvwxyz123456/);
  // ghp_ で始まる長い文字列は redact-secrets で ***REDACTED*** に置換される
  assert.doesNotMatch(r.reason, /ghp_[A-Za-z0-9]{10,}/);
});

// ===== T9: sheet モード障害 =====
test('T9: sheet モードで sheets 注入が例外を投げる→非0終了・ALERT.mdにpendingSync/syncError', async () => {
  const dir = tmpDir('t9');
  const reportsDir = createMockReports(dir, [
    {
      name: 'stalled-sheet-test',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: テスト' },
      ],
    },
  ]);
  const ledgerDir = path.join(dir, 'ledger');
  fs.mkdirSync(ledgerDir, { recursive: true });

  // sheets クライアントのスタブ — 全操作が失敗する
  const failingSheets = {
    metadata: async () => { throw new Error('Sheets HTTP 403 Forbidden'); },
    get: async () => { throw new Error('Sheets HTTP 403 Forbidden'); },
    update: async () => { throw new Error('Sheets HTTP 403 Forbidden'); },
    append: async () => { throw new Error('Sheets HTTP 403 Forbidden'); },
    updateStructure: async () => { throw new Error('Sheets HTTP 403 Forbidden'); },
  };

  const config = {
    spreadsheetId: 'mock-sheet-id',
    url: '',
    owner: 'seisaku-team@orgiast.jp',
    approvalChannelId: '',
    approverUserIds: [],
    approvalTimeoutMinutes: 120,
    quietHours: { start: '00:00', end: '00:00', tz: 'Asia/Tokyo' },
    alertFile: path.join(dir, 'ALERT.md'),
    pcAliases: {},
  };

  await withEnv({ FOLLOWUP_LEDGER_HOME: ledgerDir, FOLLOWUP_PC: 'test-pc' }, async () => {
    const code = await main(
      ['stalled-scan', '--store', 'sheet', '--reports-dir', reportsDir, '--pc', 'test-pc'],
      { config, storeMode: 'sheet', sheets: failingSheets, now: new Date() },
    );
    // シート不達時は非0で終了
    assert.notEqual(code, 0, `シート不達時は非0で終了すべき（実際: ${code}）`);

    // ALERT.md が存在し、pendingSync/syncError を含む
    const alertPath = path.join(dir, 'ALERT.md');
    assert.ok(fs.existsSync(alertPath), 'ALERT.md が存在すべき');
    const alertContent = fs.readFileSync(alertPath, 'utf8');
    assert.match(alertContent, /pendingSync|同期|syncError|エラー/);
  });
});

// ===== T10: 規則ファイルの存在検査 =====
test('T10: rules/followup-ledger.md に追記文が存在し、register-followup-ledger.ps1 に BEEPER_PREFER_LOCAL の注意書きがあり OrgiastFollowupLedger 行が残っている', () => {
  const rulesPath = path.resolve(__dirname, '..', 'rules', 'followup-ledger.md');
  const rulesContent = fs.readFileSync(rulesPath, 'utf8');
  // 追記文: 「登録できなければ止めたと言えない」
  assert.match(rulesContent, /登録できなければ止めたと言えない/);
  // stalled-scan に関する記述
  assert.match(rulesContent, /stalled-scan/);
  // 再発事例（2026-11-26 common.users）
  assert.match(rulesContent, /common.users/);

  const ps1Path = path.resolve(__dirname, '..', 'tools', 'register-followup-ledger.ps1');
  const ps1Content = fs.readFileSync(ps1Path, 'utf8');
  // BEEPER_PREFER_LOCAL の注意書き
  assert.match(ps1Content, /BEEPER_PREFER_LOCAL/);
  // OrgiastFollowupLedger 行が残っている
  assert.match(ps1Content, /OrgiastFollowupLedger/);
  // 新しい StalledScan タスク
  assert.match(ps1Content, /OrgiastStalledScan/);
  // StalledScanOnly スイッチ
  assert.match(ps1Content, /StalledScanOnly/);
});

// ===== F1: 誤登録（ノイズ）対策 =====

test('F1-T1: ステータス指標ファイル無し（DONE.txtのみ）→ skip（対象ファイル無し）', () => {
  const dir = tmpDir('f1t1');
  const reportsDir = createMockReports(dir, [
    {
      name: 'only-done',
      files: [
        { name: 'DONE.txt', content: '完了' },
      ],
    },
  ]);
  // scanCase は null（STATUS/REPORT/INCIDENT/PROGRESS が無い）
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 0);
  // scanReportsWithBreakdown で noStatusFiles がカウントされる
  const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(breakdown.noStatusFiles, 1);
  assert.equal(entries.length, 0);
});

test('F1-T2: max-age-days より古いフォルダ（検出語なし）→ skip（古すぎ）', () => {
  const dir = tmpDir('f1t2');
  const reportsDir = createMockReports(dir, [
    {
      name: 'old-abandoned',
      files: [
        { name: 'PROGRESS.md', content: '進捗: 半分まで', mtime: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) }, // 20日前
      ],
    },
  ]);
  // maxAgeDays=7 だと 20日前は古すぎ
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now(), 7);
  assert.equal(results.length, 0);
  const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, 'test-pc', 6, Date.now(), 7);
  assert.equal(breakdown.tooOld, 1);
  assert.equal(entries.length, 0);
});

test('F1-T3: max-age-days より古いが INCIDENT.md＋未復旧→登録される', () => {
  const dir = tmpDir('f1t3');
  const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'old-incident',
      files: [
        { name: 'INCIDENT.md', content: '# INCIDENT\n未復旧: データ復旧中', mtime: oldTime },
        { name: 'STATUS.txt', content: '状態: 未復旧\n理由: インシデント継続中', mtime: oldTime },
      ],
    },
  ]);
  // maxAgeDays=7 だが INCIDENT.md＋未復旧は例外
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now(), 7);
  assert.equal(results.length, 1);
  assert.match(results[0].reason, /未復旧/);
});

test('F1-T4: max-age-days より古く検出語あり（INCIDENT無し）→ skip（古すぎ）', () => {
  const dir = tmpDir('f1t4');
  const oldTime = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'old-stalled-no-incident',
      files: [
        { name: 'STATUS.txt', content: '状態: 金さん待ち\n理由: 古い案件', mtime: oldTime },
      ],
    },
  ]);
  // 検出語「金さん待ち」があるが max-age-days より古い
  // INCIDENT.md が無いので skip
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now(), 7);
  assert.equal(results.length, 0);
  const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, 'test-pc', 6, Date.now(), 7);
  assert.equal(breakdown.tooOld, 1);
  assert.equal(entries.length, 0);
});

test('F1-T5: scanReportsWithBreakdown が正しい内訳を返す', () => {
  const dir = tmpDir('f1t5');
  const now = Date.now();
  const reportsDir = createMockReports(dir, [
    {
      name: 'active-stalled',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断', mtime: new Date(now - 1000) },
      ],
    },
    {
      name: 'completed',
      files: [
        { name: 'DONE.txt', content: '完了' },
        { name: 'STATUS.txt', content: '状態: 完了', mtime: new Date(now - 1000) },
      ],
    },
    {
      name: 'only-done',
      files: [
        { name: 'DONE.txt', content: '完了', mtime: new Date(now - 1000) },
      ],
    },
    {
      name: 'too-old',
      files: [
        { name: 'PROGRESS.md', content: '進捗: 途中', mtime: new Date(now - 20 * 24 * 60 * 60 * 1000) },
      ],
    },
  ]);
  const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, 'test-pc', 6, now, 7);
  // active-stalled: 登録対象
  assert.equal(breakdown.registered, 1);
  // completed: DONE.txt＋検出語なし→完了
  assert.equal(breakdown.completed, 1);
  // only-done: ステータス指標ファイル無し→対象外
  assert.equal(breakdown.noStatusFiles, 1);
  // too-old: 20日前→古すぎ
  assert.equal(breakdown.tooOld, 1);
  assert.equal(breakdown.completedByContent, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].folder, 'active-stalled');
});

// ===== ユニットテスト =====

test('containsStalledKeywords: 各キーワードを検出', () => {
  for (const kw of STALLED_KEYWORDS) {
    assert.ok(containsStalledKeywords(kw), `キーワード "${kw}" を検出できない`);
    assert.ok(containsStalledKeywords(`本文に ${kw} と書いてある`), `文中の "${kw}" を検出できない`);
  }
  assert.equal(containsStalledKeywords('正常に完了しました'), false);
  assert.equal(containsStalledKeywords(''), false);
});

test('isKimWaiting: 金さん待ちを検出', () => {
  assert.ok(isKimWaiting('金さん待ち'));
  assert.ok(isKimWaiting('金さんだけができる'));
  assert.equal(isKimWaiting('通常の中断'), false);
});

test('extractKimOnlyAction: 「次の一手」から抽出', () => {
  const text = '状態: 金さん待ち\n理由: 支払い承認\n次の一手: 金さんに請求書を確認してもらう\n期限: なし';
  const action = extractKimOnlyAction(text);
  assert.ok(action);
  assert.match(action, /金さん/);
});

test('normalizeFolderName: 日本語→英数と-_', () => {
  assert.equal(normalizeFolderName('common-users-delete-incident'), 'common-users-delete-incident');
  assert.equal(normalizeFolderName('大阪LINE学会郵送物の自動取込'), 'LINE');
  assert.equal(normalizeFolderName('test_case_123'), 'test_case_123');
  assert.equal(normalizeFolderName(''), '');
});

test('isValidCaseFolder: 自動生成フォルダを除外', () => {
  for (const skip of SKIP_FOLDERS) {
    assert.equal(isValidCaseFolder(skip), false, `SKIP_FOLDERS "${skip}" が除外されていない`);
  }
  assert.ok(isValidCaseFolder('my-case-folder'));
  assert.ok(isValidCaseFolder('案件名'));
  assert.equal(isValidCaseFolder(''), false);
  assert.equal(isValidCaseFolder('.hidden'), false);
});

test('enumerateCaseDirs: 案件フォルダのみ列挙', () => {
  const dir = tmpDir('enum');
  const reportsDir = path.join(dir, 'gb-reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(path.join(reportsDir, 'real-case'), { recursive: true });
  fs.mkdirSync(path.join(reportsDir, 'followup-ledger'), { recursive: true }); // skip
  fs.mkdirSync(path.join(reportsDir, 'session-status'), { recursive: true }); // skip
  fs.mkdirSync(path.join(reportsDir, 'stalled-sessions-hourly'), { recursive: true }); // skip
  fs.mkdirSync(path.join(reportsDir, '.hidden'), { recursive: true }); // skip
  const cases = enumerateCaseDirs(reportsDir);
  assert.equal(cases.length, 1);
  assert.equal(cases[0].name, 'real-case');
});

test('readCaseFiles: STATUS.txt と INCIDENT.md を読み、hasDone を正しく判定', () => {
  const dir = tmpDir('read');
  const caseDir = path.join(dir, 'case');
  fs.mkdirSync(caseDir, { recursive: true });
  writeFile(path.join(caseDir, 'STATUS.txt'), '状態: 金さん待ち');
  writeFile(path.join(caseDir, 'INCIDENT.md'), '# INCIDENT');
  const result = readCaseFiles(caseDir);
  assert.equal(result.hasDone, false);
  assert.ok(result.statusText.includes('金さん待ち'));
  assert.ok(result.watchedFiles.includes('STATUS.txt'));
  assert.ok(result.watchedFiles.includes('INCIDENT.md'));

  // DONE.txt がある場合
  writeFile(path.join(caseDir, 'DONE.txt'), '完了');
  const result2 = readCaseFiles(caseDir);
  assert.equal(result2.hasDone, true);
});

test('scanCase: 条件を満たさないものは null', () => {
  const dir = tmpDir('scan-null');
  const caseDir = path.join(dir, 'empty-case');
  fs.mkdirSync(caseDir, { recursive: true });
  // 監視ファイルが何も無い
  const r1 = scanCase(caseDir, 'empty-case', 'test-pc', 6, Date.now());
  assert.equal(r1, null);

  // DONE.txt のみで検出語なし
  writeFile(path.join(caseDir, 'DONE.txt'), '完了');
  const r2 = scanCase(caseDir, 'done-case', 'test-pc', 6, Date.now());
  assert.equal(r2, null);
});

test('findExistingEntries: 重複を検出', () => {
  const entry = {
    id: 'GB-STALL-test-pc-my_case',
    folder: 'my_case',
    folderId: 'my_case',
    pc: 'test-pc',
    reason: '検出語: 中断',
    kimOnlyAction: '',
    due: '',
    detectedWords: '中断',
    hasIncident: false,
  };
  // 完全一致
  const items1 = [{ id: 'GB-STALL-test-pc-my_case', status: '止まった', statusReason: '検出語: 中断', note: 'my_case' }];
  assert.equal(findExistingEntries(items1, entry).length, 1);
  // 未完了で note に folder 名を含む
  const items2 = [{ id: 'OTHER-ID', status: '依頼中', statusReason: 'my_case', note: '' }];
  assert.equal(findExistingEntries(items2, entry).length, 1);
  // 完了はスキップ
  const items3 = [{ id: 'GB-STALL-test-pc-my_case', status: '完了', statusReason: '', note: '' }];
  assert.equal(findExistingEntries(items3, entry).length, 0);
});

test('toAddFlags: 正しいフラグを生成', () => {
  const entry = {
    id: 'GB-STALL-test-pc-test_folder',
    folder: 'test_folder',
    folderId: 'test_folder',
    pc: 'test-pc',
    reason: '検出語: 中断／根拠: test_folder',
    kimOnlyAction: '金さんに確認が必要',
    due: '2026-11-29T23:59:00.000Z',
    detectedWords: '中断',
    hasIncident: false,
  };
  const flags = toAddFlags(entry, false);
  assert.equal(flags.id, 'GB-STALL-test-pc-test_folder');
  assert.equal(flags.status, '止まった');
  assert.equal(flags.reason, '検出語: 中断／根拠: test_folder');
  assert.equal(flags.kind, 'automation');
  assert.equal(flags['owner-pc'], 'test-pc');
  assert.equal(flags.upsert, false);
  assert.equal(flags['kim-only'], '金さんに確認が必要');
  // 重複あり
  const flags2 = toAddFlags(entry, true);
  assert.equal(flags2.upsert, true);
});

test('selftest: タスク存在確認（タスクが無くてもエラーにならない）', async () => {
  const results = await selftest({
    spawnImpl: () => {
      // Simulate schtasks failure (task not found)
      const error = new Error('NoMatchingMSFT_ScheduledTaskFound');
      error.status = 1;
      throw error;
    },
  });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  // 両方とも exists=false になる（シミュレート環境）
  assert.equal(results[0].exists, false);
  assert.equal(results[1].exists, false);
});

// ===== G1: 完了語による誤検知防止 =====

test('G1-1: 完了語のみ・未復旧なし → skip（scanCase）', () => {
  const dir = tmpDir('g1-1');
  const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'completed-no-done',
      files: [
        { name: 'STATUS.txt', content: '状態: 成功\n理由: 全て完了', mtime: oldTime },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 0);
});

test('G1-2: 完了語あり・未復旧あり→載る', () => {
  const dir = tmpDir('g1-2');
  const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'unrecovered-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 完了\n理由: 復旧済み\n未復旧: あり', mtime: oldTime },
      ],
    },
  ]);
  // "未復旧" は検出語なので hasStalledKeywords=true → 完了語チェックはスキップ
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
});

test('G1-3: OK（完了語）＋未復旧なし→skip（cc-probe-1125相当）', () => {
  const dir = tmpDir('g1-3');
  const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'cc-probe-1125-style',
      files: [
        { name: 'STATUS.txt', content: 'PC=011NEXT USER=kimko FLAG=FAIL exit= / OK', mtime: oldTime },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 0);
});

test('G1-4: 検出語あり・直近更新→載る（従来どおり）', () => {
  const dir = tmpDir('g1-4');
  const reportsDir = createMockReports(dir, [
    {
      name: 'recent-stalled',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: 外部要因' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
});

test('G1-5: 「金さん待ち: なし」は検出語にしない', () => {
  assert.equal(containsStalledKeywords('金さん待ち: なし'), false);
  assert.equal(containsStalledKeywords('金さん待ち：解消'), false);
  assert.equal(containsStalledKeywords('金さん待ち:不要'), false);
  // 否定されていない場合は検出される
  assert.ok(containsStalledKeywords('状態: 金さん待ち'));
  // 「なし」が別の行にある場合は検出される
  assert.ok(containsStalledKeywords('状態: 金さん待ち\n理由: なし'));
});

test('G1-6: 「金さん待ち: なし」＋完了語→skip（G1完結）', () => {
  const dir = tmpDir('g1-6');
  const oldTime = new Date(Date.now() - 10 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'negated-kim-waiting',
      files: [
        { name: 'STATUS.txt', content: '金さん待ち: なし\n状態: 成功', mtime: oldTime },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  // 金さん待ちが否定→hasStalledKeywords=false、isStale=true、完了語あり→skip
  assert.equal(results.length, 0);
});

test('G1-7: breakdown に completedByContent が出る', () => {
  const dir = tmpDir('g1-7');
  const now = Date.now();
  const oldTime = new Date(now - 10 * 60 * 60 * 1000);
  const reportsDir = createMockReports(dir, [
    {
      name: 'content-completed',
      files: [
        { name: 'STATUS.txt', content: '状態: 成功', mtime: oldTime },
      ],
    },
    {
      name: 'keyword-stalled',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断' },
      ],
    },
  ]);
  const { entries, breakdown } = scanReportsWithBreakdown(reportsDir, 'test-pc', 6, now, 7);
  assert.equal(breakdown.completedByContent, 1, '完了語でskipした件数');
  assert.equal(breakdown.registered, 1, '検出語で登録された件数');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].folder, 'keyword-stalled');
});

// ===== G2: ID 衝突防止 =====

test('G2-1: 日本語フォルダ名でID衝突しない', () => {
  const dir = tmpDir('g2-1');
  const reportsDir = createMockReports(dir, [
    {
      name: '20261126-クラフト坂口',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断' },
      ],
    },
    {
      name: '20261126-鈴木建設',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  // 2件とも日本語フォルダだがIDが衝突しない
  assert.equal(results.length, 2);
  // ID にハッシュが含まれている
  for (const r of results) {
    assert.match(r.id, /^GB-STALL-test-pc-[a-zA-Z0-9_-]+-[a-f0-9]{6}$/, `ID ${r.id} が正しい形式ではありません`);
  }
  // ID が異なる
  assert.notEqual(results[0].id, results[1].id, '日本語フォルダ名のIDが衝突しています');
});

test('G2-2: ASCIIのみのIDにもハッシュが付く', () => {
  const dir = tmpDir('g2-2');
  const reportsDir = createMockReports(dir, [
    {
      name: 'simple-ascii',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断' },
      ],
    },
  ]);
  const results = scanReports(reportsDir, 'test-pc', 6, Date.now());
  assert.equal(results.length, 1);
  assert.match(results[0].id, /^GB-STALL-test-pc-simple-ascii-[a-f0-9]{6}$/);
});

// ===== G3: dry-run はファイルを書き換えない =====

test('G3-1: dry-run は ALERT.md / ledger.json を書かない', async () => {
  await stalledScanScenario('g3-1', [
    {
      name: 'stalled-case',
      files: [
        { name: 'STATUS.txt', content: '状態: 中断\n理由: 承認待ち' },
      ],
    },
  ], async ({ dir, run, store }) => {
    const alertFile = path.join(dir, 'ALERT.md');
    const ledgerFile = path.join(dir, 'ledger', 'ledger.json');
    const fixedNow = new Date();

    // dry-run: 何も書かない
    const code1 = await run(['--dry-run'], { now: fixedNow });
    assert.equal(code1, 0);
    assert.equal(fs.existsSync(alertFile), false, 'dry-run後ALERT.mdは存在しない');
    assert.equal(fs.existsSync(ledgerFile), false, 'dry-run後ledger.jsonは存在しない');

    // 本実行: ファイルができる
    const code2 = await run([], { now: fixedNow });
    assert.equal(code2, 0);
    assert.ok(fs.existsSync(alertFile), '本実行後ALERT.mdが存在する');
    assert.ok(fs.existsSync(ledgerFile), '本実行後ledger.jsonが存在する');

    // スナップショット（同じ fixedNow なので時刻が変わらない）
    const alertBefore = fs.readFileSync(alertFile, 'utf8');
    const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');

    // 2回目の dry-run: ファイルが変わらない
    const code3 = await run(['--dry-run'], { now: fixedNow });
    assert.equal(code3, 0);
    const alertAfter = fs.readFileSync(alertFile, 'utf8');
    const ledgerAfter = fs.readFileSync(ledgerFile, 'utf8');
    assert.equal(alertBefore, alertAfter, 'dry-run後ALERT.mdの内容が変わっている');
    assert.equal(ledgerBefore, ledgerAfter, 'dry-run後ledger.jsonの内容が変わっている');
  });
});