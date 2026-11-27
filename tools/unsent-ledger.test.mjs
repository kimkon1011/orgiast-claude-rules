import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runnerArgs, runNode, main as runLedgerJob } from './unsent-ledger-runner.mjs';
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
  isGmailDraftItem,
  isOldDraftAggregate,
  run,
} from './unsent-ledger.mjs';

function tmpDir(prefix = 'unsent-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('定期ランナーは実送信フラグが渡されても常にdry-run', () => {
  assert.deepEqual(runnerArgs([]), ['--dry-run']);
  assert.deepEqual(runnerArgs(['--send','--auto-send','--dry-run']), ['--dry-run']);
});

test('補助取込の60秒タイムアウトは台帳完了を取り消さずALERTへ記録（プロセスモック）', () => {
  const calls=[], errors=[];
  runLedgerJob({
    run: (script, options) => runNode(script, {...options, spawn: (exe,args,opts) => {
      calls.push({script,opts,args});
      return options.fatal ? {status:0} : {error:new Error('ETIMEDOUT'),status:null};
    }}), recordCaptureError: message => errors.push(message),
  });
  assert.deepEqual(calls.map(x=>x.script),['unsent-ledger.mjs','discord-appointment-capture.mjs']);
  assert.equal(calls[0].opts.timeout,600000);
  assert.equal(calls[1].opts.timeout,60000);
  assert.ok(calls.every(x=>x.opts.windowsHide&&x.args.includes('--dry-run')));
  assert.ok(calls[0].args.includes('--refresh'));
  assert.ok(!calls[1].args.includes('--refresh'));
  assert.deepEqual(errors,['ETIMEDOUT']);
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

test('ALERT.md は要約版で手動止まったを全文保持し古いGmail下書きは集計', () => {
  const now = new Date('2026-11-26T12:00:00+09:00');
  const items = [];
  for (let i = 0; i < 1000; i++) {
    items.push(normalizeItem({
      id: `gmail-draft-seisaku-team@orgiast.jp-d${i}`,
      gmail_draft_id: `d${i}`,
      from: i % 2 ? 'kim@orgiast.jp' : 'seisaku-team@orgiast.jp',
      to: [`user${i % 30}@domain${i % 25}.example`],
      subject: `draft ${i}`,
      body_text: `大量本文${'あ'.repeat(1500)}-${i}`,
      status: '止まった',
      status_reason: '台帳未登録のGmail下書き',
      decided_at: '2026-10-01T00:00:00Z',
      last_check_error: 'match.to または match.after が未設定',
      history: [{ at: '2026-10-01T00:00:00Z', status: '止まった', reason: '台帳未登録のGmail下書き', by: 'scanGmailDrafts' }],
    }));
  }
  const manualBody = 'これは手動登録の本文全文です。確認必須の連絡内容をここに書く。';
  items.push(normalizeItem({
    id: 'manual-1',
    status: '止まった',
    status_reason: '人手停止',
    decided_by: '金さん 11/25',
    to: ['important@client.jp'],
    subject: '手動登録の重要連絡',
    body_text: manualBody,
    decided_at: '2026-11-25T00:00:00Z',
    history: [{ at: '2026-11-25T01:00:00Z', status: '止まった', reason: '人手停止', by: 'add' }],
  }));
  const dir = tmpDir('alert-compact-');
  exportLedger({ schema: 'unsent-ledger/v2', items }, [dir], { now });
  const alert = fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8');
  const full = fs.readFileSync(path.join(dir, 'ALERT-full.md'), 'utf8');
  assert.ok(Buffer.byteLength(alert, 'utf8') <= 200 * 1024, `ALERT.md too large: ${Buffer.byteLength(alert, 'utf8')}`);
  const iStop = alert.indexOf('## 【止まった】');
  const iOld = alert.indexOf('## 【古い下書き（要整理）】');
  const iErr = alert.indexOf('## 【照合エラー】');
  assert.ok(iStop >= 0 && iOld > iStop && iErr > iOld);
  assert.match(alert.slice(iStop, iOld), /手動登録の重要連絡/);
  assert.match(alert.slice(iStop, iOld), new RegExp(manualBody.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(alert.slice(iOld, iErr), /件数: 1000件/);
  assert.match(alert.slice(iOld, iErr), /seisaku-team@orgiast\.jp/);
  assert.match(alert.slice(iOld, iErr), /宛先ドメイン上位20/);
  assert.doesNotMatch(alert.slice(iStop, iOld), /大量本文/);
  assert.match(full, /gmail-draft-seisaku-team@orgiast\.jp-d0/);
  assert.match(full, /大量本文/);
  const alerts = JSON.parse(fs.readFileSync(path.join(dir, 'alerts.json'), 'utf8'));
  assert.equal(alerts.counts.stopped, 1001);
  assert.equal(alerts.counts.checkErrors, 0);
  assert.ok(isGmailDraftItem(items[0]));
  assert.ok(isOldDraftAggregate(items[0], now.getTime()));
});

test('Gmail下書きは照合をスキップし match 未設定をエラーにしない', async () => {
  const item = normalizeItem({
    id: 'gmail-draft-seisaku-team@orgiast.jp-x1',
    gmail_draft_id: 'x1',
    from: 'seisaku-team@orgiast.jp',
    to: [],
    status: '止まった',
    status_reason: '台帳未登録のGmail下書き',
    match: {},
  });
  const l = { items: [item] };
  await check(l, async () => { throw new Error('should not search'); }, {
    existingDrafts: ['seisaku-team@orgiast.jp:x1'],
  });
  assert.equal(l.items[0].status, '止まった');
  assert.equal(l.items[0].last_check_error, undefined);
  assert.equal(buildAlert(l).counts.checkErrors, 0);
});

test('直近7日のファイル下書きと人の決定は本文全文を保持し14日超は集計する', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  const body = '本文'.repeat(500) + '全文末尾';
  const draft = (id, date, extra = {}) => normalizeItem({ id, status: '止まった',
    status_reason: '下書きのみで台帳未登録', created_by: 'test|scanDraftFiles',
    decided_at: date, body_text: body, ...extra });
  const items = [draft('recent', '2026-11-20'), draft('old', '2026-11-01'),
    draft('decided', '2026-11-01', { decided_by: '担当者の判断' }),
    normalizeItem({ id: 'manual', status: '止まった', status_reason: '確認待ち', body_text: body,
      decided_at: '2026-10-01', history: [{ by: 'add' }] })];
  const before = JSON.stringify(items);
  const built = buildAlert({ items }, { now });
  const stop = built.markdown.split('## 【止まった】')[1].split('## 【古い下書き')[0];
  for (const id of ['recent', 'decided', 'manual']) assert.ok(stop.includes(`### ${id}\n`));
  assert.equal(stop.split(body).length - 1, 3);
  assert.ok(!stop.includes('### old\n'));
  assert.equal(built.counts.oldDrafts, 1);
  assert.equal(JSON.stringify(items), before);
});

test('最優先は全文、未送信は300文字でカードと全件版には全文を保持', () => {
  const body = '😀'.repeat(301) + '末尾';
  const dir = tmpDir();
  exportLedger({ items: [normalizeItem({ id: 'priority', body_text: body, deadline: '2026-11-26T12:00:00Z' }),
    normalizeItem({ id: 'pending', body_text: body })] }, [dir], { now: new Date('2026-11-26T12:00:00Z') });
  const text = fs.readFileSync(path.join(dir, 'ALERT.md'), 'utf8');
  assert.ok(text.split('## 【最優先】')[1].split('## 【止まった】')[0].includes(body));
  const unsent = text.split('## 【未送信】')[1];
  assert.ok(unsent.includes('😀'.repeat(300)));
  assert.ok(!unsent.includes('😀'.repeat(301)));
  assert.ok(unsent.includes('cards/pending.json'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'cards', 'pending.json'))).body_text, body);
  assert.ok(fs.readFileSync(path.join(dir, 'ALERT-full.md'), 'utf8').includes(body));
});

test('照合エラーは理由別5件で、Gmailの設定不足以外のエラーを隠さない', () => {
  const items = Array.from({ length: 7 }, (_, i) => normalizeItem({ id: `error-${i}`, last_check_error: 'offline' }));
  items.push(normalizeItem({ id: 'gmail-draft-auth', last_check_error: 'auth failed' }));
  items.push(normalizeItem({ id: 'gmail-draft-match', last_check_error: 'match.to または match.after が未設定' }));
  const built = buildAlert({ items });
  const errors = built.markdown.split('## 【照合エラー】')[1].split('## 【未送信】')[0];
  assert.equal(built.counts.checkErrors, 8);
  assert.match(errors, /offline（7件）/);
  assert.match(errors, /error-4/);
  assert.doesNotMatch(errors, /error-5/);
  assert.match(errors, /auth failed/);
});

test('Gmail下書きの現存確認はアカウント別、消えた下書きは送信照合する', async () => {
  const item = normalizeItem({ id: 'gmail-draft-gone', gmail_draft_id: 'gone', status: '止まった',
    status_reason: '下書き', from: 'seisaku-team@orgiast.jp', to: ['a@example.com'],
    decided_at: '2026-11-01', subject: '件名' });
  const ledger = { items: [item] };
  let searches = 0;
  await check(ledger, async () => { searches++; return { messages: [{ id: 'sent', subject: '件名' }] }; },
    { existingDrafts: ['kim@orgiast.jp:gone'] });
  assert.equal(searches, 1);
  assert.equal(ledger.items[0].status, '送信済み');
});

test('明示dry-runは台帳をバイト単位で保持し照合・送信・スキャンしない', async () => {
  const dir = tmpDir(), ledgerFile = path.join(dir, 'ledger.json');
  const original = JSON.stringify({ items: [normalizeItem({ id: 'preview', status: '止まった',
    status_reason: '停止', body_text: '実本文' })] });
  fs.writeFileSync(ledgerFile, original);
  const forbidden = async () => assert.fail('dry-runから外部操作を呼ばない');
  const result = await run({ previewOnly: true, doAutoSend: true, ledgerFile,
    exportDirs: [path.join(dir, 'output')], search: forbidden, listDrafts: forbidden, reader: forbidden, sender: forbidden });
  assert.equal(result.previewOnly, true);
  assert.equal(fs.readFileSync(ledgerFile, 'utf8'), original);
  assert.ok(!fs.existsSync(`${ledgerFile}.lock`));
  assert.ok(fs.readFileSync(path.join(dir, 'output', 'ALERT.md'), 'utf8').includes('実本文'));
});
