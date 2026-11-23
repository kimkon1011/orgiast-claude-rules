import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { looksLikeApprovalRequest } from './lib/kim-inbox-kind.mjs';
import { main, addItem, listItems, __test } from './kim-inbox.mjs';

// ============================================================
// looksLikeApprovalRequest のテスト
// ============================================================

test('looksLikeApprovalRequest: 空文字は false', () => {
  assert.equal(looksLikeApprovalRequest(''), false);
});

test('looksLikeApprovalRequest: 無関係な本文は false', () => {
  assert.equal(looksLikeApprovalRequest('本日の進捗を報告します'), false);
  assert.equal(looksLikeApprovalRequest('自動処理が完了しました'), false);
});

test('looksLikeApprovalRequest: 「承認」を含む本文は true', () => {
  assert.equal(looksLikeApprovalRequest('この案件の承認をお願いします'), true);
});

test('looksLikeApprovalRequest: 「判断」を含む本文は true', () => {
  assert.equal(looksLikeApprovalRequest('判断が必要な案件があります'), true);
});

test('looksLikeApprovalRequest: 「どちら」を含む本文は true', () => {
  assert.equal(looksLikeApprovalRequest('どちらにするか決めてください'), true);
});

test('looksLikeApprovalRequest: 「YES」を含む本文は true', () => {
  assert.equal(looksLikeApprovalRequest('YES or NO で答えて'), true);
});

test('looksLikeApprovalRequest: 「決めて」を含む本文は true', () => {
  assert.equal(looksLikeApprovalRequest('決めてください'), true);
});

test('looksLikeApprovalRequest: null や undefined は false', () => {
  assert.equal(looksLikeApprovalRequest(null), false);
  assert.equal(looksLikeApprovalRequest(undefined), false);
});

// ============================================================
// --add の kind 自動昇格テスト
// ============================================================

function seat(t, label = 'kim-PC') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-kind-test-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/cost-reporter.env'), `REPORTER_LABEL=${label}`);
  fs.writeFileSync(path.join(home, '.claude/fleet-pc-map.json'), JSON.stringify({ [label]: { account: label === 'kim-PC' ? 'kim@orgiast.jp' : 'test@example.test' } }));
  t.after(() => fs.rmSync(home, { force: true, recursive: true }));
  return home;
}

test('--add info で承認要求の本文 → kind が ask に昇格し kindPromotedFrom が残る', async t => {
  const home = seat(t);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, 'この案件の承認をお願いします');
  const errors = [];
  await main(['--add', 'info', '--body-file', bodyFile], {
    home,
    stdout: () => {},
    stderr: message => errors.push(message),
  });
  const items = listItems(home, { status: 'open' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'ask', 'kind が ask に昇格している');
  assert.equal(items[0].kindPromotedFrom, 'info', 'kindPromotedFrom が info に設定されている');
  assert.deepEqual(errors, ['[kim-inbox] kind=info で登録されましたが本文が承認を求めているため ask に昇格しました']);
});

test('addItem 直接呼び出しでも承認要求の info を ask に昇格する', async t => {
  const home = seat(t);
  const errors = [];
  const item = await addItem(home, {
    kind: 'info',
    text: 'この案件の判断をお願いします',
    stderr: message => errors.push(message),
  });
  assert.equal(item.kind, 'ask');
  assert.equal(item.kindPromotedFrom, 'info');
  assert.equal(errors.length, 1);
});

test('--add info + --force-kind で承認要求の本文 → kind は info のまま', async t => {
  const home = seat(t);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '承認が必要な件です');
  await main(['--add', 'info', '--force-kind', '--body-file', bodyFile], {
    home,
    stdout: () => {},
    stderr: () => {},
  });
  const items = listItems(home, { status: 'open' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'info', '--force-kind で info のまま');
  assert.equal(items[0].kindPromotedFrom, undefined, 'kindPromotedFrom は無い');
});

test('--add info で承認要求のない本文 → kind は info のまま', async t => {
  const home = seat(t);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '本日の処理が完了しました');
  await main(['--add', 'info', '--body-file', bodyFile], {
    home,
    stdout: () => {},
    stderr: () => {},
  });
  const items = listItems(home, { status: 'open' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'info', '通常の info はそのまま');
  assert.equal(items[0].kindPromotedFrom, undefined);
});

test('--add ask で承認要求の本文 → kind は ask のまま（kindPromotedFrom は無し）', async t => {
  const home = seat(t);
  const bodyFile = path.join(home, 'body.txt');
  fs.writeFileSync(bodyFile, '承認が必要な件です');
  await main(['--add', 'ask', '--body-file', bodyFile], {
    home,
    stdout: () => {},
    stderr: () => {},
  });
  const items = listItems(home, { status: 'open' });
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'ask', 'ask はそのまま');
  assert.equal(items[0].kindPromotedFrom, undefined, '元々 ask なので kindPromotedFrom は無し');
});

// ============================================================
// sweepInfoCandidates の判定が切り出し前後で変わらないことの確認
// ============================================================

test('looksLikeApprovalRequest と sweepInfoCandidates の除外判定が一致する', () => {
  const { sweepInfoCandidates, computeSweepInfoSummary } = __test;
  const items = [
    { id: 'a1', kind: 'info', status: 'open', text: '承認が必要', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
    { id: 'a2', kind: 'info', status: 'open', text: '判断してほしい', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
    { id: 'a3', kind: 'info', status: 'open', text: 'どちらにする？', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
    { id: 'a4', kind: 'info', status: 'open', text: 'YES で返事', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
    { id: 'a5', kind: 'info', status: 'open', text: '決めて', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
    { id: 'a6', kind: 'info', status: 'open', text: '完了しました', createdAt: new Date(Date.now() - 60 * 86400000).toISOString(), lastAt: new Date(Date.now() - 60 * 86400000).toISOString(), deliveredToKim: true },
  ];
  // sweepInfoCandidates の除外判定は looksLikeApprovalRequest と同じ基準を使っている
  const { targetIds, excludedReasons } = sweepInfoCandidates(items);
  // a1〜a5 は承認キーワードを含む → 対象外
  assert.equal(targetIds.has('a1'), false, 'a1(承認) は対象外');
  assert.equal(targetIds.has('a2'), false, 'a2(判断) は対象外');
  assert.equal(targetIds.has('a3'), false, 'a3(どちら) は対象外');
  assert.equal(targetIds.has('a4'), false, 'a4(YES) は対象外');
  assert.equal(targetIds.has('a5'), false, 'a5(決めて) は対象外');
  // a6 は対象
  assert.equal(targetIds.has('a6'), true, 'a6(完了) は対象');
  // excludedReasons に5件の承認キーワード除外が含まれている
  const approvalExcluded = excludedReasons.filter(r => r.reason.includes('承認キーワード'));
  assert.equal(approvalExcluded.length, 5, '5件が承認キーワードで除外されている');
});
