import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentKey, attachmentParts, collectForUser, driveName, shouldCollect, loadState } from './lahaina-doc-collect.mjs';

test('伊藤氏以外の添付は拾わない（他案件の「立替」写真を混ぜない）', () => {
  assert.equal(shouldCollect({ from: '金社長 <president@example.com>', subject: '金社長立替分の経費申請' }), false);
  assert.equal(shouldCollect({ from: '伊藤和晃 <ito@k-ikou.co.jp>', subject: 'Re: 書類の件' }), true);
  assert.equal(shouldCollect({ from: 'staff@K-IKOU.co.jp', subject: '' }), true);
});

test('添付パートだけを再帰的に集める', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'text/plain', body: { data: 'abc' } },
      { mimeType: 'multipart/alternative', parts: [{ mimeType: 'application/pdf', filename: 'shonin.pdf', body: { attachmentId: 'A1', size: 10 } }] },
      { mimeType: 'image/png', filename: 'x.png', body: { attachmentId: 'A2', size: 5 } },
    ],
  };
  assert.deepEqual(attachmentParts(payload).map((p) => p.filename), ['shonin.pdf', 'x.png']);
  assert.deepEqual(attachmentParts(undefined), []);
});

test('同じ添付を二度上げない（キーはメッセージID＋添付ID）', () => {
  assert.equal(attachmentKey({ messageId: 'm1', attachmentId: 'a1' }), 'm1:a1');
  assert.notEqual(attachmentKey({ messageId: 'm1', attachmentId: 'a1' }), attachmentKey({ messageId: 'm2', attachmentId: 'a1' }));
});

test('ファイル名が空でも Drive 名を作れる', () => {
  assert.equal(driveName('旅館業営業承継承認書.pdf'), '旅館業営業承継承認書.pdf');
  assert.equal(driveName('', 3), 'attachment-3.bin');
});

test('state が壊れていても空から始まる', () => {
  assert.deepEqual(loadState('C:/nonexistent/lahaina-state.json'), { saved: {} });
});

// 検索→絞り込み→添付取得→アップロードの配線を通しで確かめる。
// ここが壊れると「実行は成功するが何も保存されない」無音の失敗になる。
function fakeGmail({ from = '伊藤和晃 <ito@k-ikou.co.jp>', subject = 'Re: 書類の件', attachments = ['A1'], id = 'm1' } = {}) {
  return async (url) => {
    const path = String(url).replace('https://gmail.googleapis.com/gmail/v1/users/me', '');
    const json = (value) => ({ ok: true, status: 200, json: async () => value, text: async () => '' });
    if (path.startsWith('/messages?')) return json({ messages: [{ id }] });
    if (path.includes('/attachments/')) return json({ data: Buffer.from('pdf-bytes').toString('base64url') });
    if (path.includes('format=full')) {
      return json({ id, payload: { mimeType: 'multipart/mixed', parts: attachments.map((a) => ({ mimeType: 'application/pdf', filename: `${a}.pdf`, body: { attachmentId: a, size: 9 } })) } });
    }
    return json({ id, payload: { headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Thu, 22 Oct 2026 10:00:00 +0900' }] } });
  };
}

test('伊藤氏の添付だけを拾って Drive へ上げ、2回目は上げ直さない', async () => {
  const uploaded = [];
  const uploadImpl = async ({ name, folder, as }) => { uploaded.push({ name, folder, as }); return { id: `d-${name}`, url: `https://drive/${name}` }; };
  const getToken = async () => 'token';
  const state = { saved: {} };

  const first = await collectForUser({ user: 'kim@orgiast.jp', days: 30, folder: 'F1', state, dryRun: false, fetchImpl: fakeGmail(), getToken, uploadImpl });
  assert.deepEqual(first.matched.map((m) => m.id), ['m1']);
  assert.equal(first.saved.length, 1);
  assert.equal(first.saved[0].filename, 'A1.pdf');
  assert.equal(uploaded[0].folder, 'F1');
  assert.equal(state.saved['m1:A1'].driveId, 'd-A1.pdf');

  const again = await collectForUser({ user: 'kim@orgiast.jp', days: 30, folder: 'F1', state, dryRun: false, fetchImpl: fakeGmail(), getToken, uploadImpl });
  assert.deepEqual(again.matched.map((m) => m.id), ['m1'], '既読でも matched には残る');
  assert.equal(again.saved.length, 0, '2回目はアップロードしない');
  assert.equal(uploaded.length, 1);
});

test('伊藤氏以外からの添付は取得もしない', async () => {
  const uploaded = [];
  const result = await collectForUser({
    user: 'kim@orgiast.jp', days: 30, folder: 'F1', state: { saved: {} }, dryRun: false,
    fetchImpl: fakeGmail({ from: '金社長 <president@example.com>', subject: '金社長立替分の経費申請' }),
    getToken: async () => 'token',
    uploadImpl: async (args) => { uploaded.push(args); return { id: 'x', url: 'x' }; },
  });
  assert.deepEqual(result.matched, []);
  assert.deepEqual(result.saved, []);
  assert.equal(uploaded.length, 0);
});
