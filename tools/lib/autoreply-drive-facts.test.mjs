import test from 'node:test';
import assert from 'node:assert/strict';
import { needsDriveFactSearch, searchDriveFacts } from './autoreply-drive-facts.mjs';

test('PJコードだけのメッセージを連続判定しても常にDrive検索が必要になる', () => {
  assert.equal(needsDriveFactSearch('260430EIGの請求について'), true);
  assert.equal(needsDriveFactSearch('260430EIGの請求について'), true);
});

test('エイトを検索し、ファイル名の一意なPJコードを返す', async () => {
  const urls = [];
  const result = await searchDriveFacts({ message: '吉村日和さんの請求にある「エイト」のプロジェクトコードを教えて', terms: ['エイト'], request: async url => { urls.push(url); return { files: [{ id: '1', name: '実施計画書（260430EIG_エイトの森様 _ピッチイベント企画運営委託費）' }] }; } });
  assert.equal(new URL(urls[0]).searchParams.get('q'), "name contains 'エイト' and trashed=false");
  assert.equal(result.uniqueCode, '260430EIG');
});

test('異なるコードが2件なら一意にしない', async () => {
  const result = await searchDriveFacts({ message: 'エイトのPJコードは？', terms: ['エイト'], request: async () => ({ files: [{ id: '1', name: '260430EIG_エイト' }, { id: '2', name: '2601007MED_エイト' }] }) });
  assert.equal(result.uniqueCode, null);
});

test('コードの話でなければDriveを呼ばない', async () => {
  let called = false;
  const result = await searchDriveFacts({ message: '明日の集合時間を教えて', request: async () => { called = true; } });
  assert.equal(called, false); assert.equal(result.searched, false);
});

test('APIエラーをthrowせずerrorで返す', async () => {
  const result = await searchDriveFacts({ message: 'エイトの案件コードを教えて', terms: ['エイト'], request: async () => { throw new Error('offline'); } });
  assert.match(result.error, /offline/);
});
