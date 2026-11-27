import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addItem } from './kim-inbox.mjs';

test('常設許可に一致する送信承認は info に変換し再開台帳へ積む', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const messages = [];
  const item = await addItem(home, {
    kind: 'ask', text: '営業の1日待ち後のフォローアップを送信してよいか承認してください',
    sessionId: 'session-standing', source: 'test', stderr: value => messages.push(value),
  }, { localOnly: true });
  assert.equal(item.kind, 'info');
  assert.equal(item.standingPermission, 'sales-1day-followup');
  assert.match(messages.join('\n'), /常設許可あり/);
  const ledger = fs.readFileSync(path.join(home, '.claude', 'stall-ledger', 'standing-sends.jsonl'), 'utf8');
  assert.match(ledger, /session-standing/);
});

test('常設許可に一致しない承認依頼は ask のまま', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = await addItem(home, { kind: 'ask', text: '別件メールの送信を承認してください', source: 'test' }, { localOnly: true });
  assert.equal(item.kind, 'ask');
});

test('今回の無人処理が明示的に承認待ちを指定した場合は常設許可より優先する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = await addItem(home, { kind: 'ask', forceKind: true, sessionId: 'hourly-source',
    text: '営業のフォローアップ送信の承認が必要です', source: 'stalled-session-hourly-preflight' }, { localOnly: true });
  assert.equal(item.kind, 'ask'); assert.equal(item.standingPermission, undefined);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'stall-ledger', 'standing-sends.jsonl')), false);
});

test('施設名だけを含む価格変更の承認依頼は ask のまま', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = await addItem(home, {
    kind: 'ask', text: 'メルシアター 12/11〜24 の値下げ上限を30%→50%に広げる変更の本番反映（GAS）の承認依頼です', source: 'test',
  }, { localOnly: true });
  assert.equal(item.kind, 'ask');
  assert.equal(item.standingPermission, undefined);
});

test('メルシ延泊・前倒し案内の送信承認は info に変換する', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = await addItem(home, {
    kind: 'ask', text: 'メルシ延泊・前倒し案内10通の送信を承認してください', source: 'test',
  }, { localOnly: true });
  assert.equal(item.kind, 'info');
  assert.equal(item.standingPermission, 'merci-extend');
});

test('営業だけを含む資料送信の承認依頼は ask のまま', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-standing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const item = await addItem(home, {
    kind: 'ask', text: '営業資料を顧客へ送信してよいか承認してください', source: 'test',
  }, { localOnly: true });
  assert.equal(item.kind, 'ask');
  assert.equal(item.standingPermission, undefined);
});
