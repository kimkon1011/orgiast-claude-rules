import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { preflightCheck } from './auto-progress-check.mjs';
import { progressHome, notificationMocks } from './test-helpers/auto-progress-home.mjs';
import { addCheck } from './auto-progress.mjs';
import { executeCheck } from './auto-progress-check.mjs';
import { run } from './auto-progress-watch.mjs';
import { compactDigest } from './lib/owner-dm-digest.mjs';
import { formatDigest, MAX_ITEM_CHARS } from './auto-progress-digest.mjs';
import { ledgerFile, readLedger } from './auto-progress-ledger.mjs';
const now = Date.parse('2026-11-02T00:00:00Z');
test('exit3 は最終行を理由に記録し、既存の再開間隔・上限に従う', async t => {
  const home = progressHome('stalled-check-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  addCheck({ home, cwd: home, now, session: 'stalled', check: 'node check.mjs', label: '返信待ち', deadline: '+7d', probe: () => ({ code: 3, text: '未開封' }) });
  let resumed = 0;
  const io = { ...notificationMocks, sheetConfig: () => null, digest: async () => ({}), executeCheck: () => ({ code: 3, text: 'ログ\n作業用011 が未開封 5日\n' }),
    askLlm: () => assert.fail('check を AI で判定しない'), resume: () => { resumed++; return { state: 'done', reason: '再依頼完了' }; },
    notifyOwner: async () => ({ delivered: 'dm' }) };
  await run({ home, now, io });
  let row = readLedger(ledgerFile(home))[0];
  assert.equal(row.checkResult, 'stalled'); assert.equal(row.source, 'check-stalled');
  assert.equal(row.checkText, '作業用011 が未開封 5日'); assert.equal(row.verdict, 'stalled');
  assert.equal(resumed, 1); assert.notEqual(row.status, 'done');
  assert.match(formatDigest([row], now), /止まっている:/);
  await run({ home, now: now + 3600000, io });
  assert.equal(resumed, 1);
  row = readLedger(ledgerFile(home))[0];
  assert.equal(row.reason, '作業用011 が未開封 5日');
  // 上限に達した行は翌日も再開しない。
  const rows = [{ ...row, resumeCount: 8 }];
  fs.writeFileSync(ledgerFile(home), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await run({ home, now: now + 86400000, io }); assert.equal(resumed, 1);
  await run({ home, now: now + 86400000, io: { ...io, executeCheck: () => ({ code: 0, text: '返信あり' }) } });
  assert.equal(readLedger(ledgerFile(home))[0].status, 'done');
});
test('executeCheck は main の stdout 全文保存を維持する', () => {
  const result = executeCheck({ check: 'x' }, { spawnImpl: () => ({ status: 3, stdout: 'log\n未開封\n' }) });
  assert.equal(result.code, 3); assert.equal(result.text, 'log\n未開封');
});
test('進行中に状態句を出し、長い件名でも状態句と80字制限を維持', () => {
  for (const extra of [{ checkText: 'log\n相手が対応中' }, { reason: '確認を継続中' }, {}]) {
    const text = formatDigest([{ status: 'open', promise: '件名'.repeat(100), ...extra }], now);
    const line = text.split('\n').find(line => line.startsWith('・進行中:'));
    assert.ok(line.length <= MAX_ITEM_CHARS); assert.match(line, / — /);
    assert.ok(line.endsWith(extra.checkText ? '相手が対応中' : extra.reason || '状態未確認'));
  }
});

test('登録時は exit3 を許可し、開始予約では拒否する', t => {
  const home = progressHome('stalled-preflight-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const check = `"${process.execPath}" -e "console.log('未開封');process.exit(3)"`;
  const pf = preflightCheck({ check, checkCwd: home }, { home });
  assert.equal(pf.ok, true); assert.equal(pf.preflight, 'stalled');
  const options = { home, cwd: home, now, session: 'registration', check, label: '返信待ち', deadline: '+7d', probe: () => pf };
  assert.equal(addCheck(options).status, 'open');
  assert.throws(() => addCheck({ ...options, startWhen: check, nextClaude: '到着後の作業' }), /この PC で実行できません/);
});

test('期限超過後の exit3 も停滞として再開し、完了 check 後は再開しない', async t => {
  const home = progressHome('stalled-overdue-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  addCheck({ home, cwd: home, now, session: 'overdue-stalled', check: 'node check.mjs', label: '返信待ち', deadline: '+1h' });
  let code = 3, resumes = 0;
  const io = { ...notificationMocks, sheetConfig: () => null, digest: async () => ({}),
    executeCheck: () => ({ code, stdout: '詳細ログ\n未開封のまま5日\n' }),
    resume: () => { resumes++; return { state: 'done', reason: '再依頼済み' }; },
    askLlm: () => assert.fail('check を AI 判定しない'), notifyOwner: async () => ({ delivered: 'inbox' }) };
  await run({ home, now: now + 7200000, io });
  let row = readLedger(ledgerFile(home))[0];
  assert.equal(row.verdict, 'stalled'); assert.notEqual(row.status, 'overdue_reported');
  assert.equal(row.reason, '未開封のまま5日'); assert.equal(resumes, 1);
  code = 0;
  await run({ home, now: now + 7300000, io });
  row = readLedger(ledgerFile(home))[0]; assert.equal(row.status, 'done');
  await run({ home, now: now + 2 * 86400000, io });
  assert.equal(readLedger(ledgerFile(home))[0].status, 'done'); assert.equal(resumes, 1);
});

test('push ダイジェストも check の停滞を件数に含める', () => {
  const row = { status: 'open', verdict: 'stalled', label: '返信待ち', nextKim: 'なし', unattended: true };
  assert.match(compactDigest([row], [], now).text, /自動作業\n完了 0件・止まっている 1件/);
});
