import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFreeeCsv, classifyAccount, aggregateMonthly, judge, parseDmCommand, formatWeeklyReport, makeStatus, shouldSkipWeekly, createAutopilot, readSettings, readMonthly, readLedger, isFinalized } from './sga-autopilot.mjs';
const settingRows = [['項目', '値'], ['期首', '2026/10/01'], ['期末', '2027/09/30'], ['報酬', 1200000], ['その他', 6000000], ['年間', 100000000], ['粗利', 120000000], ['警戒', 0.9]];
const settings = readSettings(settingRows);
const monthlyRows = Array.from({ length: 12 }, (_, i) => [`${i < 3 ? 2026 : 2027}/${String((i + 9) % 12 + 1).padStart(2, '0')}`, 1200000, '', 6000000, '', '', '', '', '', '', '', '', '', '', '']);
const data = () => ({ settings, monthly: readMonthly(monthlyRows), ledger: [] });
const csv = (date = '2026/10/17', debit = '外注費', amount = 100, credit = '未払金', creditAmount = amount, desc = '摘要') => ['', '', '', date, debit, '', '', '', amount, '', credit, '', '', '', creditAmount, '', desc].map(v => `"${String(v).replaceAll('"', '""')}"`).join(',');

test('CSV：BOM・クォート・改行・ヘッダ・ASCII・CP932', () => {
  const parsed = parseFreeeCsv(Buffer.from('\uFEFF' + csv('取引日', '借方勘定科目') + '\r\n' + csv(undefined, undefined, undefined, undefined, undefined, '会議,"資料"\n続き')));
  assert.equal(parsed.lines[0].description, '会議,"資料"\n続き'); assert.equal(parsed.rowCount, 1);
  assert.equal(parseFreeeCsv(Buffer.from(csv('2026-10-17', 'expense', 1, 'cash', 1, 'memo'))).lines[0].debitAmount, 1);
  const bytes = Buffer.concat([Buffer.from(csv('2026-10-17', 'expense', 1, 'cash', 1, '')), Buffer.from([0x82, 0xa0])]);
  assert.equal(parseFreeeCsv(bytes).encoding, 'CP932');
  assert.throws(() => parseFreeeCsv(Buffer.from('"未完')));
});
test('科目分類', () => { for (const [name, expected] of [['外注費', 'assistant'], ['仕入・外注', 'cogs'], ['売上高', 'revenue'], ['未払金', 'excluded'], ['通信費', 'sga'], ['受取利息', 'excluded']]) assert.equal(classifyAccount(name, settings), expected); });
test('期間・貸方戻し・粗利・内訳', () => {
  const lines = parseFreeeCsv(Buffer.from([csv('2026/09/30'), csv(), csv('2026/10/18', '未払金', 20, '外注費', 20), csv('2026/10/18', '売掛金', 500, '売上高', 500), csv('2026/10/18', '仕入・外注', 50)].join('\n'))).lines;
  const result = aggregateMonthly(lines, settings);
  assert.equal(result.size, 1); assert.equal(result.get('2026/10').assistant, 80); assert.equal(result.get('2026/10').grossProfit, 450); assert.equal(result.get('2026/10').byAccount['外注費'], 80);
});
test('承認判定の4分岐・例外・二重計上除外・翌月不足', () => {
  const input = { ...data(), amount: 1000, kind: 'その他販管費', month: '2026/10' };
  assert.equal(judge(input).verdict, '承認'); assert.match(judge(input).reason, /¥6,000,000 → 承認後 ¥5,999,000／年間残枠 ¥100,000,000/);
  assert.equal(judge({ ...input, amount: 100000001, force: true }).verdict, '却下');
  assert.equal(judge({ ...input, amount: 6000001 }).verdict, '保留');
  assert.match(judge({ ...input, amount: 6000001 }).reason, /翌月も残枠不足/);
  const ledger = [{ month: '2026/10', kind: input.kind, verdict: '承認', amount: 90000000, posted: '未' }];
  assert.match(judge({ ...input, ledger }).reason, /警戒モード/);
  assert.equal(judge({ ...input, ledger: [{ ...ledger[0], month: '2026/11' }], force: true }).verdict, '承認');
  assert.equal(judge({ ...input, ledger: [{ ...ledger[0], posted: '済' }] }).verdict, '承認');
  assert.throws(() => judge({ ...input, amount: -1 })); assert.throws(() => judge({ ...input, month: '2026/9' }));
});
test('DM の書式と金額', () => {
  for (const text of ['支出 備品 50,000', '備品に50000円', '備品 5万円', '50000円 備品', '支出 備品 ¥50000', '備品 5万']) assert.equal(parseDmCommand(text).amount, 50000, text);
  assert.equal(parseDmCommand('アシスタント報酬に1.2万円 強制').amount, 12000);
  assert.equal(parseDmCommand('アシスタント報酬に1.2万円 強制').force, true);
  assert.equal(parseDmCommand('アシスタント報酬に1.2万円').kind, 'アシスタント報酬');
  for (const text of ['販管費', '状況', '残枠']) assert.deepEqual(parseDmCommand(text), { type: 'status' });
  assert.equal(parseDmCommand('こんにちは'), null);
});
test('週次本文と同日判定・確定判定', () => {
  const text = formatWeeklyReport(makeStatus(data(), '2026/10', Date.parse('2026-10-22')));
  assert.ok(text.length < 2000); assert.doesNotMatch(text, /sga-autopilot|--force|grossProfit|undefined|NaN/);
  assert.equal(shouldSkipWeekly({ lastWeekly: { at: '2026-10-22' } }, Date.parse('2026-10-21T16:00Z'), false), true);
  assert.equal(shouldSkipWeekly({ lastWeekly: { at: '2026-10-22' } }, Date.parse('2026-10-21T16:00Z'), true), false);
  assert.equal(isFinalized({ memo: '確定：確認済み' }), true);
  assert.equal(readLedger([['', '', '', '-']]).length, 0);
});
async function fixture(t, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), 'sga-test-')); t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'freee_journals_20260101_20261017_20261022-0501.csv'); await writeFile(path, csv());
  const written = new Map(), writes = [];
  const client = { get: async (_id, range) => written.get(range) ?? (range.includes('設定') ? settingRows : range.includes('月次') ? structuredClone(monthlyRows) : []), update: async (_id, range, rows) => { writes.push(range); written.set(range, rows); }, append: async (_id, range, rows) => { const target = "'承認ログ'!A3:H3"; writes.push(range); written.set(target, rows); return { updates: { updatedRange: target } }; } };
  let notifications = 0;
  const app = createAutopilot({ home, now: () => Date.parse('2026-10-22T03:00Z'), client, notify: async () => { notifications++; return { delivered: 'dm' }; }, ...extra });
  return { home, path, client, app, writes, written, notifications: () => notifications };
}
test('sync：書込列限定と再読込・確定行保護', async t => {
  const f = await fixture(t); await f.app.execute('sync', { csv: f.path });
  assert.deepEqual(f.writes, ["'月次'!C2", "'月次'!E2", "'月次'!K2", "'月次'!O2"]);
  f.writes.length = 0; const original = f.client.get;
  f.client.get = async (id, range) => { if (range.endsWith('A2:O13')) { const rows = structuredClone(monthlyRows); rows[0][14] = '確定'; return rows; } return original(id, range); };
  const result = await f.app.execute('sync', { csv: f.path }); assert.equal(result.months[0].skipped, true); assert.equal(f.writes.length, 0);
});
test('approve：追記の照合不一致で失敗', async t => {
  const f = await fixture(t); const original = f.client.get;
  f.client.get = async (id, range) => range.endsWith('A3:H3') ? [] : original(id, range);
  await assert.rejects(f.app.execute('approve', { item: '通信費', amount: 1000 }), /確認が一致しません/);
});
test('weekly：仮反映・実通知成功後の同日スキップ・強制再送', async t => {
  const f = await fixture(t);
  const dry = await f.app.execute('weekly', { csv: f.path, 'dry-run': true }); assert.equal(dry.status.current.assistant, 100); assert.equal(f.writes.length, 0); assert.equal(f.notifications(), 0);
  await f.app.execute('weekly', { csv: f.path }); assert.equal(f.notifications(), 1);
  assert.equal((await f.app.execute('weekly', { csv: '/存在しない' })).skipped, true);
  await f.app.execute('weekly', { csv: f.path, 'force-send': true }); assert.equal(f.notifications(), 2);
});
test('Drive：既定スコープ・最新 CSV・8日超過警告', async t => {
  let calls = 0;
  const f = await fixture(t, { getToken: async options => { assert.equal(options.scope, undefined); return '非公開'; }, driveApi: async (_token, url) => { calls++; if (url.includes('alt=media')) return new Response(csv()); assert.match(url, /orderBy=modifiedTime\+desc/); return Response.json({ files: [{ id: 'test', name: 'freee_journals_20260101_20261017_20261012-0501.csv', modifiedTime: '2026-10-18T00:00Z' }] }); } });
  const result = await f.app.execute('sync', { 'dry-run': true }); assert.equal(calls, 2); assert.equal(result.warnings.length, 1); assert.equal(result.months[0].assistant, 100); assert.equal(f.writes.length, 0);
});
test('DM：本人のみ・同じチャンネルへ返信・再実行で重複なし', async t => {
  const replies = [], message = { id: '1420000000000000000', author: { id: '715210673642012733' }, content: '備品に1000円' };
  const f = await fixture(t, { discordToken: '非公開', fetchMessages: async () => ({ messages: [message, { ...message, id: '1420000000000000001', author: { id: 'bot', bot: true } }], truncated: false }), fetchImpl: async (url, opts) => { if (url.endsWith('/users/@me/channels')) return Response.json({ id: 'dm' }); replies.push({ url, body: JSON.parse(opts.body) }); return Response.json({ id: 'reply' }); } });
  await f.app.execute('watch-dm'); await f.app.execute('watch-dm'); assert.equal(replies.length, 1); assert.match(replies[0].url, /channels\/dm\/messages/); assert.match(replies[0].body.content, /台帳 3行目/); assert.equal(f.writes.length, 1);
  assert.equal(JSON.parse(await readFile(join(f.home, '.claude/state/sga-autopilot.json'), 'utf8')).lastMessageId, message.id);
});
test('保留：当月の未計上承認を差引き、翌月なら可', () => {
  const input = { ...data(), amount: 1000, kind: 'その他販管費', month: '2026/10' };
  input.ledger.push({ month: input.month, kind: input.kind, verdict: '承認', amount: 5999500, posted: '未' });
  const result = judge(input); assert.equal(result.verdict, '保留'); assert.match(result.reason, /翌月なら可/); assert.match(result.reason, /当月残枠 ¥500/);
});
test('初期設定：既存項目を保持し、二回目は追記しない', async t => {
  const f = await fixture(t), rows = [['アシスタント報酬 科目', '既存科目', '維持']];
  f.client.get = async (_id, range) => range.endsWith('A15:C1000') ? rows : f.written.get(range) ?? [];
  f.client.update = async (_id, range, values) => { f.writes.push(range); f.written.set(range, values); };
  await f.app.execute('init-settings'); assert.equal(f.writes.length, 4); assert.equal(rows[0][1], '既存科目');
  await f.app.execute('init-settings'); assert.equal(f.writes.length, 4);
});
test('通知失敗は週次送信済みとして保存しない', async t => {
  const f = await fixture(t, { notify: async () => ({ delivered: 'none' }) });
  await assert.rejects(f.app.execute('weekly', { csv: f.path }), /通知を送信できません/);
  await assert.rejects(readFile(join(f.home, '.claude/state/sga-autopilot.json')), { code: 'ENOENT' });
});
test('打合せメモ：マイドライブ直下の Markdown・再読込・通知', async t => {
  let contents, notification;
  const f = await fixture(t, { upload: async options => { assert.equal(options.folder, 'root'); assert.equal(options.as, 'kim@orgiast.jp'); assert.match(options.file, /meeting-2026-10.md$/); contents = await readFile(options.file, 'utf8'); return { id: 'memo', url: 'https://drive.google.com/file/d/memo/view' }; }, getToken: async () => '非公開', driveApi: async () => new Response(contents), notify: async text => { notification = text; return { delivered: 'dm' }; } });
  assert.equal((await f.app.execute('meeting-memo', { scheduled: true })).skipped, true);
  const result = await f.app.execute('meeting-memo', { csv: f.path }); assert.match(result.text, /未計上の固定費/); assert.match(notification, /（kim@orgiast.jp で開く）/);
});
test('DM：照合失敗の返信は一度だけ・dry-run は書込も返信もしない', async t => {
  const replies = [], message = { id: '1420000000000000000', author: { id: '715210673642012733' }, content: '備品に1000円' };
  const f = await fixture(t, { discordToken: '非公開', fetchMessages: async () => ({ messages: [message], truncated: false }), fetchImpl: async (url, opts) => {
    if (opts.method !== 'POST') return Response.json([{ id: 'dm', type: 1, recipients: [{ id: message.author.id }] }]);
    if (url.endsWith('/users/@me/channels')) return Response.json({ id: 'dm' });
    replies.push(JSON.parse(opts.body).content); return Response.json({ id: 'reply' });
  } });
  await f.app.execute('watch-dm', { 'dry-run': true }); assert.equal(f.writes.length, 0); assert.equal(replies.length, 0);
  f.client.append = async () => { throw new Error('追記に失敗'); };
  await f.app.execute('watch-dm'); await f.app.execute('watch-dm'); assert.equal(replies.length, 1); assert.match(replies[0], /読み取れなかったので/);
});
test('sync：不一致で停止して後続列を更新しない', async t => {
  const f = await fixture(t), original = f.client.get;
  f.client.get = async (id, range) => range === "'月次'!C2" ? [[999]] : original(id, range);
  await assert.rejects(f.app.execute('sync', { csv: f.path }), /確認が一致しません/); assert.deepEqual(f.writes, ["'月次'!C2"]);
});

test('承認ログ：サンプル・非数値・0以下を除外して status/weekly/judge に反映', async t => {
  const row = (item, amount, verdict = '承認') => ['2026/10/22', '2026/10', item, amount, 'その他販管費', verdict, '', '未'];
  const rows = [row('（記入例）サンプル', 0), row('（記入例）有額サンプル', 99999999), row('ゼロ', 0), row('負数', -100), ...['-', '100', NaN, Infinity, null].map(amount => row('不正', amount)), row('通信費', 1000), row('消耗品', 2000), row('検討中', 4000, '保留')];
  const ledger = readLedger(rows);
  assert.equal(ledger.length, 3);
  const f = await fixture(t), original = f.client.get;
  f.client.get = async (id, range) => range.includes('承認ログ') ? rows : original(id, range);
  const status = await f.app.execute('status');
  assert.deepEqual(status.approvedThisMonth, { count: 2, amount: 3000 });
  assert.deepEqual(status.pendingThisMonth, { count: 1, amount: 4000 });
  assert.equal(status.sgaRemaining, 5997000);
  const weekly = await f.app.execute('weekly', { csv: f.path, 'dry-run': true });
  assert.match(weekly.text, /承認済み 2件 ¥3,000／保留 1件 ¥4,000/);
  const input = { ...data(), ledger, month: '2026/10', kind: 'その他販管費' };
  assert.equal(judge({ ...input, amount: 5997000 }).verdict, '承認');
  assert.equal(judge({ ...input, amount: 5997001 }).verdict, '保留');
  assert.equal(f.writes.length, 0); assert.equal(f.notifications(), 0);
});

test('sync：週次 CSV の8日境界と日付入り警告・weekly は末尾に注意', async t => {
  const created = Date.parse('2026-10-19T05:01:00+09:00');
  let current = created;
  const warning = '注意：会計データ（仕訳）が 10/19 時点のもので、8日以上更新されていません。';
  const f = await fixture(t, { now: () => current });
  const path = join(f.home, 'freee_journals_20260101_20261019_20261019-0501.csv');
  await writeFile(path, csv());
  for (const age of [72 * 3600000 + 1, 7 * 86400000, 8 * 86400000]) {
    current = created + age;
    assert.deepEqual((await f.app.execute('sync', { csv: path, 'dry-run': true })).warnings, []);
  }
  current = created + 8 * 86400000 + 1;
  assert.deepEqual((await f.app.execute('sync', { csv: path, 'dry-run': true })).warnings, [warning]);
  const weekly = await f.app.execute('weekly', { csv: path, 'dry-run': true });
  assert.equal(weekly.text.split('\n')[0], '2026/10 販管費のお知らせ（速報）');
  assert.equal(weekly.text.split('\n').at(-1), warning);
  assert.match(weekly.text, /承認済み 0件 ¥0/);
  assert.ok(weekly.text.length <= 2000);
  assert.equal(f.writes.length, 0); assert.equal(f.notifications(), 0);
  await assert.rejects(readFile(join(f.home, '.claude/state/sga-autopilot.json')), { code: 'ENOENT' });
});

test('登録スクリプト：ASCII の説明・完了表示と既存起動設定を維持', async () => {
  // .gitattributes が ps1 を CRLF でチェックアウトするため、改行を正規化してから検査する。
  const script = (await readFile(new URL('./register-sga-autopilot.ps1', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(script.startsWith('# Register the SGA (hanbai-kanrihi) autopilot tasks. ASCII only for Windows PowerShell 5.1.\n'));
  assert.doesNotMatch(script, /[^\x00-\x7f]/);
  assert.equal((script.match(/Description = 'SGA autopilot: [^']+'/g) ?? []).length, 4);
  assert.match(script, /Register-ScheduledTask .* -Description \$job.Description/);
  assert.match(script, /-MultipleInstances IgnoreNew/);
  assert.match(script, /nightly-bootstrap.ps1/);
  assert.match(script, /-File', \$bootstrap/);
  assert.ok(script.trimEnd().endsWith("Write-Host 'OK: 4 SGA autopilot tasks registered'"));
});
