import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apiBaseFor, regionFromToken, isWorkspaceTokenExpired, durationToSeconds, epochToIso, extensionFromUrl, isTldvSupportedUrl, meetsMinimumDuration,
  mergeState, readState, redactSecret, regionFromRedirect, selectPlaudCookies, shouldImport,
} from './plaud-to-tldv.mjs';

test('Set-Cookie は削除用を無視し、最後の実値を採用する', () => {
  const cookies = [
    'pld_ut=old; Path=/; Max-Age=0', 'pld_ut=first; Path=/', 'pld_urt=gone; Max-Age=0',
    'pld_ut=real-ut; HttpOnly', 'pld_urt=real-urt; HttpOnly',
  ];
  assert.deepEqual(selectPlaudCookies(cookies), { ut: 'real-ut', urt: 'real-urt' });
  assert.deepEqual(selectPlaudCookies(['pld_ut=new; Path=/'], { ut: 'old', urt: 'keep' }), { ut: 'new', urt: 'keep' });
});

test('epoch 秒とミリ秒を ISO8601 に変換する', () => {
  assert.equal(epochToIso(1_700_000_000), '2023-11-14T22:13:20.000Z');
  assert.equal(epochToIso(1_700_000_000_123), '2023-11-14T22:13:20.123Z');
  assert.equal(epochToIso(123), undefined);
});

test('duration の秒/ミリ秒判定と最低分数フィルタ', () => {
  assert.equal(durationToSeconds(300), 300);
  assert.equal(durationToSeconds(300_000), 300);
  assert.equal(meetsMinimumDuration(299, 5), false);
  assert.equal(meetsMinimumDuration(300_000, 5), true);
});

test('署名 URL のパスから拡張子を安全に判定する', () => {
  assert.equal(extensionFromUrl('https://s3.example/audio.M4A?X-Amz-Signature=secret'), '.m4a');
  assert.equal(isTldvSupportedUrl('https://s3.example/audio.M4A?x=1'), true);
  assert.equal(extensionFromUrl('https://s3.example/audio?x=1'), '');
  assert.equal(isTldvSupportedUrl('https://s3.example/audio.opus?x=1'), false);
});

test('リージョン不一致 envelope の api host を逆引きする', () => {
  assert.equal(regionFromRedirect({ status: -302, data: { domains: { api: 'api-euc1.plaud.ai' } } }), 'aws:eu-central-1');
  assert.equal(regionFromRedirect({ status: 0, data: { domains: { api: 'api-euc1.plaud.ai' } } }), undefined);
});

test('state マージを繰り返しても imported は維持され、既 import は除外する', () => {
  const raw = { imported: { abc: { jobId: 'job-1', name: 'n', at: 1 } }, session: { ut: 'state-ut' } };
  const once = mergeState(raw, { ut: 'env-ut', urt: 'env-urt' });
  const twice = mergeState(once, { ut: 'other-env' });
  assert.deepEqual(twice, once);
  assert.equal(twice.session.ut, 'state-ut');
  assert.deepEqual(shouldImport({ id: 'abc', duration: 600 }, twice), { import: false, reason: 'imported' });
});

test('壊れた state を退避して新規 state を返す', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plaud-state-test-'));
  const statePath = path.join(dir, 'state.json');
  fs.writeFileSync(statePath, '{broken');
  const result = readState(statePath, { ut: 'bootstrap' }, 123456);
  assert.equal(result.corruptPath, `${statePath}.corrupt-123456`);
  assert.equal(fs.readFileSync(result.corruptPath, 'utf8'), '{broken');
  assert.equal(result.state.session.ut, 'bootstrap');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('秘匿値は先頭3文字と長さだけに伏字化する', () => {
  assert.equal(redactSecret('abcdefghij'), 'abc…(len=10)');
  assert.equal(redactSecret(''), '(empty)');
  assert.equal(redactSecret('ab'), 'ab…(len=2)');
});

test('fetch スタブは実ネットワークなしで差し替え可能', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('{}', { status: 200 }); };
  try { await globalThis.fetch('https://offline.invalid'); assert.equal(called, true); }
  finally { globalThis.fetch = original; }
});

test('duration の単位は start_time/end_time の差分から実測で決まる', () => {
  // 秒 epoch + 秒 duration
  assert.equal(durationToSeconds(1800, { start_time: 1_760_000_000, end_time: 1_760_001_800 }), 1800);
  // ミリ秒 epoch + ミリ秒 duration
  assert.equal(durationToSeconds(1_800_000, { start_time: 1_760_000_000_000, end_time: 1_760_001_800_000 }), 1800);
  // 秒 epoch + ミリ秒 duration（閾値だけでは判定できない混在ケース）
  assert.equal(durationToSeconds(1_800_000, { start_time: 1_760_000_000, end_time: 1_760_001_800 }), 1800);
  // 90秒をミリ秒で持つ短い録音: 閾値だけだと 90000 秒(25時間)に化けるが差分で救える
  assert.equal(durationToSeconds(90_000, { start_time: 1_760_000_000, end_time: 1_760_000_090 }), 90);
  // start/end が無ければ従来の閾値フォールバック
  assert.equal(durationToSeconds(300), 300);
  assert.equal(durationToSeconds(300_000), 300);
});

test('リージョンは JWT の region クレームと未知ホストの両方を解決できる', () => {
  const jwt = (payload) => `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`;
  assert.equal(regionFromToken(jwt({ region: 'aws:ap-northeast-1' })), 'aws:ap-northeast-1');
  assert.equal(regionFromToken(jwt({ region: 'aws:mars-1' })), '');
  assert.equal(regionFromToken('not-a-jwt'), '');
  assert.equal(apiBaseFor('aws:ap-northeast-1'), 'https://api-apne1.plaud.ai');
  assert.equal(apiBaseFor(undefined), 'https://api.plaud.ai');
  // 表に無いリージョンが増えても plaud.ai 配下なら追従する
  const raw = regionFromRedirect({ status: -302, data: { domains: { api: 'https://api-apne9.plaud.ai' } } });
  assert.equal(raw, 'https://api-apne9.plaud.ai');
  assert.equal(apiBaseFor(raw), 'https://api-apne9.plaud.ai');
  // 無関係なホストへは飛ばさない
  assert.equal(regionFromRedirect({ status: -302, data: { domains: { api: 'https://evil.example.com' } } }), undefined);
});


test('WT 失効は envelope status -419 と文言の双方で検出する', () => {
  const withEnvelope = (envelope) => Object.assign(new Error('録音一覧失敗'), { envelope });
  assert.equal(isWorkspaceTokenExpired(withEnvelope({ status: -419, msg: 'workspace token expired' })), true);
  assert.equal(isWorkspaceTokenExpired(withEnvelope({ status: -1, msg: 'workspace token invalid' })), true);
  assert.equal(isWorkspaceTokenExpired(withEnvelope({ status: -1, msg: 'something else' })), false);
  assert.equal(isWorkspaceTokenExpired(new Error('network')), false);
});
