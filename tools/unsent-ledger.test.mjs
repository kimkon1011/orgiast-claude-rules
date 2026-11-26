import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerArgs } from './unsent-ledger-runner.mjs';
import {
  addItem,
  autoSend,
  buildAlert,
  check,
  exportLedger,
  hasKimDecision,
  ingest,
  loadLedger,
  migrateItem,
  migrateLedger,
  normalizeItem,
  scanDraftFiles,
  setStatus,
  maybeNotifyStuck,
  scanGmailDrafts,
  patchSummary,
  acquireLedgerLock,
} from './unsent-ledger.mjs';

function tmpDir(prefix = 'unsent-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('定期ランナーは実送信フラグが渡されても常にdry-run', () => {
  assert.deepEqual(runnerArgs([]), ['--dry-run']);
  assert.deepEqual(runnerArgs(['--send','--auto-send','--dry-run']), ['--dry-run']);
});

test('ingest は id 重複を除外し done へ移す', () => {
  const root = tmpDir();
  const inbox = path.join(root, 'inbox');
  fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'a.json'), JSON.stringify({ id: 'a', to: 'x@example.com' }));
  const l = { items: [] };
  assert.equal(ingest(l, inbox), 1);
  assert.equal(l.items.length, 1);
  assert.ok(fs.existsSync(path.join(inbox, 'done', 'a.json')));
  assert.equal(l.items[0].status, '承認待ち');
});

test('check は件名条件に合う送信済みだけを更新する', async () => {
  const l = {
    items: [{
      id: 'a',
      status: '承認待ち',
      from: 'seisaku-team@orgiast.jp',
      to: ['x@example.com'],
      match: { to: 'x@example.com', after: '2026-11-01', subject_any: ['会議URL'] },
    }],
  };
  await check(l, async () => ({ messages: [{ id: 'm1', subject: 'Re: 会議URL', threadId: 't' }] }));
  assert.equal(l.items[0].status, '送信済み');
  assert.equal(l.items[0].sent_message_id, 'm1');
});

test('Gmail 失敗は状態を変えず error を残す', async () => {
  const l = {
    items: [{
      id: 'a',
      status: '承認待ち',
      subject: 'quota test',
      from: 'seisaku-team@orgiast.jp',
      to: ['x@example.com'],
      match: { to: 'x@example.com', after: '2026-11-01' },
    }],
  };
  await check(l, async () => { throw new Error('quota'); });
  assert.equal(l.items[0].status, '承認待ち');
  assert.match(l.items[0].last_check_error, /quota/);
});

test('(1) 取り下げは金さんの記録なしで拒否', () => {
  const item = normalizeItem({ id: 'x', decided_by: 'AI only' });
  assert.equal(hasKimDecision(item), false);
  assert.throws(() => setStatus(item, '取り下げ', '不要', { by: 'test' }), /金さん|hasKimDecision|決定/);
});

test('(2) 止まった は理由必須', () => {
  const item = normalizeItem({ id: 'y' });
  assert.throws(() => setStatus(item, '止まった', '', { by: 'test' }), /reason/);
  setStatus(item, '止まった', '認証切れ', { by: 'test' });
  assert.equal(item.status, '止まった');
  assert.equal(item.history.at(-1).reason, '認証切れ');
});

test('(3) 台帳未登録の DRAFT を自動登録', () => {
  const root = tmpDir('gb-');
  const folder = path.join(root, 'case-a');
  fs.mkdirSync(folder);
  const draft = path.join(folder, 'DRAFT-hello.md');
  fs.writeFileSync(draft, 'hello body');
  // mtime を今にする
  const now = Date.now();
  fs.utimesSync(folder, new Date(now), new Date(now));
  const ledger = { schema: 'unsent-ledger/v2', items: [] };
  const result = scanDraftFiles(ledger, { root, now });
  assert.equal(result.registered, 1);
  assert.equal(ledger.items[0].status, '止まった');
  assert.match(ledger.items[0].status_reason, /下書きのみで台帳未登録/);
  // 冪等
  assert.equal(scanDraftFiles(ledger, { root, now }).registered, 0);
});

test('(4) 送信未確認3回で止まった', async () => {
  const l = {
    items: [normalizeItem({
      id: 'u1',
      status: '送信未確認',
      channel: 'email',
      from: 'seisaku-team@orgiast.jp',
      to: ['x@example.com'],
      match: { to: 'x@example.com', after: '2026-11-01', subject_any: ['never'] },
      unconfirmed_checks: 0,
    })],
  };
  const empty = async () => ({ messages: [] });
  await check(l, empty);
  await check(l, empty);
  await check(l, empty);
  assert.equal(l.items[0].unconfirmed_checks, 3);
  assert.equal(l.items[0].status, '止まった');
  assert.match(l.items[0].status_reason, /送信未確認が3時間解消しない/);
});

test('(5) 社外は自動送信しない（dry-run 出力に出ない）', async () => {
  const ledger = {
    items: [
      normalizeItem({
        id: 'ext',
        status: '自動送信待ち',
        internal: false,
        channel: 'discord',
        chat_id: '1',
        decided_by: '金さん 11/25',
        to: ['a@example.com'],
      }),
      normalizeItem({
        id: 'int',
        status: '自動送信待ち',
        internal: true,
        channel: 'discord',
        chat_id: '2',
        decided_by: '金さん 11/25',
        to: ['kim@orgiast.jp'],
      }),
    ],
  };
  const results = await autoSend(ledger, { dryRun: true });
  assert.equal(results.some((r) => r.id === 'ext'), false);
  assert.equal(results.some((r) => r.id === 'int' && r.dryRun), true);
});

test('(6) ALERT.md の順が 最優先→止まった→照合エラー→未送信', () => {
  const now = new Date('2026-11-26T10:00:00+09:00');
  const ledger = {
    items: [
      normalizeItem({
        id: 'u',
        status: '承認待ち',
        to: ['a@ex.com'],
        subject: '未送信件',
        decided_at: '2026-11-20T00:00:00Z',
      }),
      normalizeItem({
        id: 's',
        status: '止まった',
        status_reason: '理由S',
        to: ['b@ex.com'],
        subject: '停止件',
        history: [{ at: '2026-11-26T01:00:00Z', status: '止まった', reason: '理由S' }],
      }),
      normalizeItem({
        id: 'p',
        status: '承認待ち',
        to: ['c@ex.com'],
        subject: '優先件',
        deadline: '2026-11-26T10:30:00+09:00',
      }),
      normalizeItem({
        id: 'e',
        status: '承認待ち',
        to: ['d@ex.com'],
        subject: 'エラー件',
        last_check_error: 'auth failed',
      }),
    ],
  };
  const built = buildAlert(ledger, { now });
  const iPri = built.markdown.indexOf('## 【最優先】');
  const iStop = built.markdown.indexOf('## 【止まった】');
  const iErr = built.markdown.indexOf('## 【照合エラー】');
  const iUn = built.markdown.indexOf('## 【未送信】');
  assert.ok(iPri < iStop && iStop < iErr && iErr < iUn);
  assert.match(built.markdown.slice(iPri, iStop), /優先件/);
  assert.match(built.markdown.slice(iStop, iErr), /停止件/);
  assert.match(built.markdown.slice(iErr, iUn), /auth failed/);
  assert.match(built.markdown.slice(iUn), /未送信件/);
});

test('(7) 0件でも ALERT.md が更新される', () => {
  const dir = tmpDir('alert-');
  const ledger = { schema: 'unsent-ledger/v2', generated_at: new Date().toISOString(), items: [] };
  exportLedger(ledger, [dir]);
  const text = fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8');
  assert.match(text, /件数: 0件/);
  assert.match(text, /生成:/);
  const alerts = JSON.parse(fs.readFileSync(path.join(dir, 'alerts.json'), 'utf8'));
  assert.equal(alerts.counts.total, 0);
});

test('(8) 旧ステータス移行', () => {
  const a = migrateItem({ id: '1', status: '未送信', to: ['kim@orgiast.jp'], client: '社内', case: 'X' });
  assert.equal(a.status, '承認待ち');
  assert.equal(a.channel, 'email');
  assert.equal(a.internal, true);
  const b = migrateItem({ id: '2', status: '保留', stop_reason: '承認待ち中', to: ['out@example.com'] });
  assert.equal(b.status, '止まった');
  assert.match(b.status_reason, /承認待ち中|旧/);
  assert.equal(b.internal, false);
  const ledger = migrateLedger({ schema: 'unsent-ledger/v1', items: [a, b] });
  assert.equal(ledger.schema, 'unsent-ledger/v2');
});

test('add --file 相当の addItem は検証して追記', () => {
  const ledger = { items: [] };
  const { added, item } = addItem(ledger, { id: 'n1', to: 'kim@orgiast.jp', subject: 'hi' });
  assert.equal(added, true);
  assert.equal(item.internal, true);
  assert.equal(addItem(ledger, { id: 'n1', subject: 'hi2' }).added, false);
});

test('hasKimDecision は日付または出典が必要', () => {
  assert.equal(hasKimDecision({ decided_by: '金さん' }), false);
  assert.equal(hasKimDecision({ decided_by: '金さん 11/25' }), true);
  assert.equal(hasKimDecision({ decided_by: 'kim t845u' }), true);
});

test('exportLedger は UNSENT_LEDGER_EXPORT_DIR を使える', () => {
  const dir = tmpDir('exp-');
  const prev = process.env.UNSENT_LEDGER_EXPORT_DIR;
  process.env.UNSENT_LEDGER_EXPORT_DIR = dir;
  try {
    const ledger = {
      items: [normalizeItem({ id: 'c1', status: '承認待ち', to: ['a@ex.com'], subject: 's', body_path: null })],
    };
    exportLedger(ledger);
    assert.ok(fs.existsSync(path.join(dir, 'ALERT.md')));
    assert.ok(fs.existsSync(path.join(dir, 'cards', 'c1.json')));
  } finally {
    if (prev === undefined) delete process.env.UNSENT_LEDGER_EXPORT_DIR;
    else process.env.UNSENT_LEDGER_EXPORT_DIR = prev;
  }
});

test('loadLedger は空ファイルでも v2', () => {
  const dir = tmpDir('led-');
  const file = path.join(dir, 'ledger.json');
  const l = loadLedger(file);
  assert.equal(l.schema, 'unsent-ledger/v2');
  assert.deepEqual(l.items, []);
});

const chatItem = (extra = {}) => normalizeItem({ id: 'chat', channel: 'discord', internal: true,
  chat_id: 'test-chat', status: '送信未確認', decided_at: '2026-11-26T00:00:00Z',
  body_text: '署名した陳述書の写真をお願いします。', decided_by: '金さん 11/25', ...extra });
const ownMessage = (extra = {}) => ({ id: 'm1', isSender: true, timestamp: '2026-11-26T01:00:00Z',
  text: '署名した陳述書の写真をお願いします。', ...extra });

test('受信・決定前・本文不一致・時刻不明は送信済みにしない', async () => {
  for (const msg of [ownMessage({ isSender: false }), ownMessage({ timestamp: '2026-11-25T00:00:00Z' }),
    ownMessage({ text: '別件の写真' }), ownMessage({ timestamp: null })]) {
    const l = { items: [chatItem()] };
    await check(l, null, { reader: async () => [msg] });
    assert.equal(l.items[0].status, '送信未確認');
  }
  const l = { items: [chatItem()] };
  await check(l, null, { reader: async () => [ownMessage()] });
  assert.equal(l.items[0].status, '送信済み');
  assert.ok(l.items[0].evidence.includes('beeper:test-chat:m1'));
});

test('照合設定不足/API停止では未確認回数を増やさずエラー表示', async () => {
  for (const item of [chatItem({ chat_id: null }), chatItem({ body_text: '' }), chatItem()]) {
    const l = { items: [item] };
    await check(l, null, { reader: async () => { throw new Error('API offline'); } });
    assert.equal(l.items[0].unconfirmed_checks, 0);
    assert.equal(l.items[0].status, '送信未確認');
    assert.ok(l.items[0].last_check_error);
  }
});

test('live autoSend は二重送信を防ぎ、API成功だけでは送信済みにしない（モックのみ）', async () => {
  let sends = 0;
  const sender = async () => { sends++; return { id: 'api-accepted' }; };
  const l = { items: [chatItem({ status: '自動送信待ち' })] };
  await autoSend(l, { dryRun: false, sender, reader: async () => [ownMessage()] });
  assert.equal(sends, 0);
  assert.equal(l.items[0].status, '送信済み');
  const missing = { items: [chatItem({ status: '自動送信待ち' })] };
  await autoSend(missing, { dryRun: false, sender, reader: async () => [] });
  assert.equal(sends, 1);
  assert.equal(missing.items[0].status, '止まった');
  const ext = { items: [chatItem({ status: '自動送信待ち', internal: false })] };
  await autoSend(ext, { dryRun: false, sender, reader: async () => [] });
  assert.equal(sends, 1);
  assert.match(ext.items[0].last_check_error, /拒否/);
});

test('add は不正status/channelと決定なしの状態変更を拒否', () => {
  for (const raw of [{ status: '取り下げ' }, { status: '止まった' }, { status: '自動送信待ち' },
    { status: 'bad' }, { channel: 'bad' }]) assert.throws(() => addItem({ items: [] }, { id: 'bad', ...raw }));
  assert.throws(() => setStatus(normalizeItem({ id: 'x' }), '自動送信待ち', 'AIだけ'));
});

test('sent-unconfirmed は送信済みに誤移行せず移行は冪等', () => {
  const once = migrateItem({ id: 'legacy', status: 'sent-unconfirmed', client: '顧客', case: '123' });
  assert.equal(once.status, '送信未確認');
  assert.deepEqual(migrateItem(once), once);
  assert.ok(once.history.length);
});

test('ALERT件数はエラー重複を除きカードを保管・SUMMARYは他本文を保持', () => {
  const dir = tmpDir();
  const item = chatItem({ status: '止まった', status_reason: '停止', last_check_error: 'offline' });
  const l = { items: [item] };
  assert.equal(buildAlert(l).counts.total, 1);
  exportLedger(l, [dir]);
  assert.match(fs.readFileSync(path.join(dir, 'cards', 'chat.json'), 'utf8'), /署名/);
  setStatus(item, '送信済み', '確認');
  exportLedger(l, [dir]);
  assert.equal(fs.readdirSync(path.join(dir, 'cards')).length, 0);
  assert.equal(fs.readdirSync(path.join(dir, 'cards-archive')).length, 1);
  const summary = path.join(dir, 'summary-test.md');
  fs.writeFileSync(summary, '他の作業\n');
  patchSummary(buildAlert({ items: [] }), summary);
  patchSummary(buildAlert(l), summary);
  const text = fs.readFileSync(summary, 'utf8');
  assert.ok(text.endsWith('他の作業\n'));
  assert.equal(text.match(/UNSENT-ALERT-START/g).length, 1);
});

test('Gmail下書きはアカウント別・2時間以上のみ登録し失敗を残す', async () => {
  const l = { items: [] }, now = Date.now();
  const listDrafts = async () => [{ id: 'old', createdMs: now - 3 * 3600000, body_text: '本文' },
    { id: 'new', createdMs: now - 60000 }];
  assert.equal((await scanGmailDrafts(l, { now, listDrafts })).registered, 2);
  assert.equal((await scanGmailDrafts(l, { now, listDrafts })).registered, 0);
  assert.equal(l.items[0].body_text, '本文');
  l.items[0].body_text = '';
  await scanGmailDrafts(l, { now, listDrafts });
  assert.equal(l.items[0].body_text, '本文');
  assert.equal((await scanGmailDrafts(l, { listDrafts: async () => { throw new Error('auth'); } })).errors.length, 2);
});

test('排他中の書き込みを拒否し、解放はロック履歴への移動で行う', () => {
  const root=tmpDir(), file=path.join(root,'ledger.json');
  const release=acquireLedgerLock(file);
  assert.throws(()=>acquireLedgerLock(file), /実行中/);
  release();
  assert.equal(fs.readdirSync(path.join(root,'lock-history')).length,1);
  acquireLedgerLock(file)();
});

test('Gmailは件名の部分一致や本文条件の違うメールを確定しない', async () => {
  const l={items:[normalizeItem({id:'email',to:['a@example.com'],subject:'日程',decided_at:'2026-11-26T00:00:00Z',match:{needles:['12月9日']}})]};
  await check(l,async()=>({messages:[{id:'wrong',subject:'日程変更',body:'12月9日'},{id:'other',subject:'日程',body:'12月10日'}]}));
  assert.equal(l.items[0].status,'承認待ち');
  await check(l,async()=>({messages:[{id:'right',subject:'Re: 日程',body:'12月9日'}]}));
  assert.equal(l.items[0].sent_message_id,'right');
});

test('ack無し2回・1日1件、解消後は連続回数リセット（通知モック）', async () => {
  const exportDir = tmpDir(), statePath = path.join(exportDir, 'state.json');
  let notifications = 0;
  const opts = { exportDir, statePath, notify: async () => { notifications++; }, now: new Date('2026-11-26T01:00:00Z') };
  const l = { items: [chatItem({ status: '止まった', status_reason: '停止' })] };
  await maybeNotifyStuck(l, opts);
  await maybeNotifyStuck({ items: [] }, opts);
  await maybeNotifyStuck(l, opts);
  assert.equal(notifications, 0);
  await maybeNotifyStuck(l, opts);
  await maybeNotifyStuck(l, opts);
  assert.equal(notifications, 1);
  fs.mkdirSync(path.join(exportDir, 'ack'));
  fs.writeFileSync(path.join(exportDir, 'ack', 'chat.json'), '{}');
  await maybeNotifyStuck(l, { ...opts, now: new Date('2026-11-27T01:00:00Z') });
  assert.equal(notifications, 1);
});
