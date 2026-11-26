import test from 'node:test';
import assert from 'node:assert/strict';
import { notificationContent, readDiscordNotifications, selectTargetRows } from './inquiry-discord-watch.mjs';

const headers = ['問い合わせ日時', ...Array(11).fill(''), '対応状況'];
function valuesThrough(last) { return [headers, ...Array.from({ length: last - 1 }, (_, i) => [`2026/11/26 00:${String(i % 60).padStart(2, '0')}`])]; }

test('通知済み最大3239・最終行3259なら3240〜3259を選ぶ', () => {
  const targets = selectTargetRows({ values: valuesThrough(3259), headers, notifiedRows: new Set([3239]), lastNotifiedRow: 3239, limit: 30 });
  assert.deepEqual(targets.map(x => x.rowNumber), Array.from({ length: 20 }, (_, i) => 3240 + i));
});

test('対応状況が除外の行をスキップする', () => {
  const values = valuesThrough(12); values[10][12] = '除外';
  assert.deepEqual(selectTargetRows({ values, headers, notifiedRows: new Set([9]), lastNotifiedRow: 9, limit: 30 }).map(x => x.rowNumber), [10, 12]);
});

test('notifiedRowsに含まれる行は再投稿しない', () => {
  assert.deepEqual(selectTargetRows({ values: valuesThrough(12), headers, notifiedRows: new Set([9, 11]), lastNotifiedRow: 9, limit: 30 }).map(x => x.rowNumber), [10, 12]);
});

test('Discordに行番号がなければエラーになり投稿へ進まない', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify([{ id: '1', content: '別の投稿' }]), { status: 200 }); };
  await assert.rejects(readDiscordNotifications({ fetchImpl, token: 'dummy' }), /1件も取得できません/);
  assert.equal(calls, 1);
});

test('limitで件数を制限する', () => {
  assert.deepEqual(selectTargetRows({ values: valuesThrough(20), headers, notifiedRows: new Set([9]), lastNotifiedRow: 9, limit: 3 }).map(x => x.rowNumber), [10, 11, 12]);
});

test('投稿本文が指定フォーマットと完全一致する', () => {
  assert.equal(notificationContent(3240), '<@&1382575757997379596>\nオージャストHPに新しい問い合わせが入りました。\nシートの3240行目の対応をお願いします。\n対応後はM列を「完了」にしてください。\nhttps://docs.google.com/spreadsheets/d/1AZVagLiJ4kz3CGyvzXFGuRFM3HFmqhQym5Ts8NIa244/edit?gid=88076728#gid=88076728');
});
