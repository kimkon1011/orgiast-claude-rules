import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const files = ['UpsertLogic.gs', 'CloudLedgerLogic.gs', 'DiscordChannelsLogic.gs', 'ManualColumnsLogic.gs', 'ExtensionAudit.gs'];
const source = files.map((file) => fs.readFileSync(new URL(`../gas/fleet-status-sheet/${file}`, import.meta.url), 'utf8')).join('\n');
const context = {};
vm.createContext(context);
vm.runInContext(source.replace(/\bconst\s+/g, 'var ').replace(/\blet\s+/g, 'var '), context);
const headers = [...context.DISCORD_CHANNEL_HEADERS_];
const makeRow = (names, values = {}) => names.map((name) => values[name] ?? '');
const payload = { checkedAt: '2026-08-31', channels: [{ id: '1', name: 'general', category: '', type: 'テキスト', parentId: '', url: 'https://discord.com/channels/g/1' }] };

test('empty Discord sheet appends rows with manual columns blank', () => {
  const plan = context.discordPlanChannels(headers, [], payload);
  assert.equal(plan.appendRows.length, 1);
  for (const name of headers.filter((header) => header.includes('【手入力】'))) assert.equal(plan.appendRows[0][headers.indexOf(name)], '');
});

test('rename updates only the changed machine column and never manual columns', () => {
  const existing = makeRow(headers, { チャンネルID: '1', チャンネル名: 'old', 種別: 'テキスト', チャンネルURL: 'https://discord.com/channels/g/1', 状態: 'あり', '最終確認日(JST)': '2026-08-31', '担当【手入力】': 'kim' });
  const plan = context.discordPlanChannels(headers, [existing], payload);
  assert.deepEqual([...plan.updates].map((update) => headers[update.columnIndex - 1]), ['チャンネル名']);
  assert(!plan.updates.some((update) => headers[update.columnIndex - 1].includes('【手入力】')));
});

test('shuffled columns are resolved by header name', () => {
  const shuffled = [headers[8], headers[2], ...headers.filter((_, index) => index !== 8 && index !== 2)];
  const existing = makeRow(shuffled, { チャンネルID: '1', チャンネル名: 'old', 種別: 'テキスト', チャンネルURL: 'https://discord.com/channels/g/1', 状態: 'あり', '最終確認日(JST)': '2026-08-31' });
  const plan = context.discordPlanChannels(shuffled, [existing], payload);
  assert.equal(shuffled[plan.updates[0].columnIndex - 1], 'チャンネル名');
});

test('missing IDs remain and are marked hidden', () => {
  const existing = makeRow(headers, { チャンネルID: 'gone', 状態: 'あり', '最終確認日(JST)': 'old' });
  const plan = context.discordPlanChannels(headers, [existing], { checkedAt: '2026-08-31', channels: [] });
  assert.deepEqual([...plan.missing], ['gone']);
  assert.equal(plan.appendRows.length, 0);
  assert.deepEqual(Object.fromEntries(plan.updates.map((update) => [headers[update.columnIndex - 1], update.value])), { 状態: '削除/非表示', '最終確認日(JST)': '2026-08-31' });
});

test('identical Discord snapshot produces no updates', () => {
  const existing = makeRow(headers, { チャンネルID: '1', チャンネル名: 'general', 種別: 'テキスト', チャンネルURL: 'https://discord.com/channels/g/1', 状態: 'あり', '最終確認日(JST)': '2026-08-31' });
  assert.equal(context.discordPlanChannels(headers, [existing], payload).updates.length, 0);
});

test('Discord ID header is required', () => {
  assert.throws(() => context.discordPlanChannels(headers.filter((name) => name !== 'チャンネルID'), [], payload), /required header not found: チャンネルID/);
});

test('manual columns respect equivalent headers and are idempotent', () => {
  assert.deepEqual([...context.manualPlanColumns(['名前', '備考'])], ['担当【手入力】']);
  assert.deepEqual([...context.manualPlanColumns(['名前', '担当【手入力】', '備考'])], []);
  assert.deepEqual([...context.manualPlanColumns([])], []);
});

test('login replace restores matching manual values, reports dropped values, and supports old headers', () => {
  const loginHeaders = [...context.CLOUD_LOGIN_HEADERS_, '担当【手入力】'];
  const rows = [
    makeRow(loginHeaders, { 'PC名/ホスト名': 'PC', サービス: 'GitHub', ログインアカウント: 'a', '担当【手入力】': '保持' }),
    makeRow(loginHeaders, { 'PC名/ホスト名': 'PC', サービス: 'Vercel', ログインアカウント: 'b', '担当【手入力】': '消失' }),
  ];
  const plan = context.cloudPlanLoginReplace(loginHeaders, rows, { label: 'PC', rows: [{ service: 'GitHub', account: 'a' }] });
  assert.equal(plan.appendRows[0][loginHeaders.indexOf('担当【手入力】')], '保持');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.droppedManual)), [{ key: 'Vercel\u0000b', header: '担当【手入力】', value: '消失' }]);
  const legacy = context.cloudPlanLoginReplace([...context.CLOUD_LOGIN_HEADERS_], [], { label: 'PC', rows: [{ service: 'GitHub', account: 'a' }] });
  assert.equal(legacy.appendRows.length, 1);
  assert.deepEqual([...legacy.droppedManual], []);
});

test('extension replace restores matching manual values, reports dropped values, and supports old headers', () => {
  const base = Object.keys(context.EXT_HEADERS_).map((key) => context.EXT_HEADERS_[key]);
  const extHeaders = [...base, '備考【手入力】'];
  const rows = [
    makeRow(extHeaders, { 'PC名/ホスト名': 'PC', ブラウザ: 'Chrome', プロファイル: 'Default', 拡張ID: 'keep', '備考【手入力】': '保持' }),
    makeRow(extHeaders, { 'PC名/ホスト名': 'PC', ブラウザ: 'Edge', プロファイル: 'P1', 拡張ID: 'gone', '備考【手入力】': '消失' }),
  ];
  const plan = context.extPlanReplace(extHeaders, rows, { label: 'PC', rows: [{ browser: 'Chrome', profile: 'Default', id: 'keep' }] });
  assert.equal(plan.appendRows[0][extHeaders.indexOf('備考【手入力】')], '保持');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.droppedManual)), [{ key: 'Edge\u0000P1\u0000gone', header: '備考【手入力】', value: '消失' }]);
  const legacy = context.extPlanReplace(base, [], { label: 'PC', rows: [] });
  assert.deepEqual([...legacy.droppedManual], []);
});
