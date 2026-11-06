import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HEADERS, parseRows, serializeRow, isDuplicate, nextId, normalizeSeed, initialize, dataPath, saveJson, withLedgerLock, googleClient, createLedger } from './deadline-ledger.mjs';

test('台帳の列、連番、重複と未確認種の候補化', () => {
  const seed = normalizeSeed({ title: '=質問書', kind: '行政・消防', sourceId: 'one' }, '2026-11-04');
  assert.equal(seed.status, '候補'); assert.equal(seed.title, '=質問書');
  const row = { ...seed, id: 'D-003', due: '2026-11-06' };
  assert.equal(parseRows([HEADERS, serializeRow(row)])[0].due, '2026-11-06');
  assert.equal(nextId([row, { id: 'V20' }]), 'D-004');
  assert.ok(isDuplicate({ ...row, status: '未着手' }, [{ ...row, status: '完了' }]));
  assert.ok(isDuplicate({ ...row, sourceId: 'other', due: '2026-11-08' }, [row]));
  assert.ok(!isDuplicate({ ...row, sourceId: 'other', due: '2026-11-09' }, [row]));
  assert.throws(() => parseRows([['ID']]));
});

test('--initはkim所有で作成、通知メールなし共有、途中再実行で二重作成しない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-init-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const tabs = {}, requests = []; let creates = 0;
  const sheets = {
    metadata: async () => ({ sheets: ['期限台帳','候補','使い方'].map(title => ({ properties: { title } })) }),
    get: async (_, range) => { const rows = tabs[range.split('!')[0]] || []; return /Q1$/.test(range) ? rows.slice(0, 1) : rows; },
    update: async (_, range, rows) => { const key = range.split('!')[0]; if (range.endsWith('A2')) return; tabs[key] = rows; },
    append: async (_, range, rows) => tabs[range.split('!')[0]].push(...rows),
  };
  const request = async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith('/spreadsheets')) { creates++; return { spreadsheetId: 'test-book' }; }
    return { permissions: [{ type: 'user', emailAddress: 'kim@orgiast.jp', role: 'owner' }] };
  };
  saveJson(dataPath(home, 'seeds.json'), [{ title: '支払', kind: '支払', due: '2026-11-30', sourceId: 'mail-one' }, { title: '質問書', sourceId: 'mail-two' }]);
  assert.equal((await initialize({ home, sheets, request })).added, 2);
  assert.equal((await initialize({ home, sheets, request })).added, 0);
  assert.equal(creates, 1); assert.equal(tabs["'期限台帳'"][1][7], '経理');
  assert.ok(requests.filter(([url, o]) => o?.method === 'POST' && url.includes('permissions')).every(([url]) => url.endsWith('sendNotificationEmail=false')));
  await withLedgerLock(home, async () => { await assert.rejects(withLedgerLock(home, async () => {}), /更新中/); });
});

test('Google client explicitly impersonates kim and preserves HTTP error status', async () => {
  const client = googleClient({ getToken: async opts => { assert.equal(opts.impersonate, 'kim@orgiast.jp'); return 'token'; }, fetchImpl: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(client('https://example.invalid'), e => e.status === 403);
});

test('既存seedsのevidence/noteとgmail:メール箱形式を保持して正規化する', () => {
  const row=normalizeSeed({title:'協業回答',source:'gmail:seisaku-team@orgiast.jp',sourceId:'mail-one',due:'2026-11-06',kind:'回答・返信',evidence:'https://example.invalid/message',note:'確認メモ'});
  assert.equal(row.source,'Gmail'); assert.equal(row.sourceId,'gmail:seisaku-team@orgiast.jp:mail-one');
  assert.equal(row.quote,'https://example.invalid/message'); assert.match(row.notes,/確認メモ/);
  assert.deepEqual(JSON.parse(row.notes.split('\n')[0]),{mailbox:'seisaku-team@orgiast.jp',messageId:'mail-one'});
});

test('延期先などの書込成功後に状態を更新し、途中失敗で期限を隠さない', async () => {
  const writes=[];
  const sheets={get:async()=>[HEADERS,serializeRow({id:'D-001',title:'提出',due:'2026-11-06',status:'未着手'})],update:async(_,range,values)=>writes.push([range,values])};
  const ledger=createLedger({config:{sheetId:'test'},sheets});
  await ledger.patch('D-001',{status:'延期',notes:'延期先: 2026-11-20',lastNotified:''});
  assert.match(writes.at(-1)[0],/!G2$/); assert.match(writes[0][0],/!Q2$/);
  const failed=createLedger({config:{sheetId:'test'},sheets:{...sheets,update:async(_,range)=>{assert.doesNotMatch(range,/!G2$/);throw Error('offline');}}});
  await assert.rejects(failed.patch('D-001',{status:'延期',notes:'延期先: 2026-11-20'}),/offline/);
});
