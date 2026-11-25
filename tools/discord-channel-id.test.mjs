import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { formatChannelLines, pickResult } from './discord-channel-id.mjs';

const files = ['UpsertLogic.gs', 'CloudLedgerLogic.gs', 'DiscordChannelsLogic.gs'];
const source = files.map((file) => fs.readFileSync(new URL(`../gas/fleet-status-sheet/${file}`, import.meta.url), 'utf8')).join('\n');
const context = {};
vm.createContext(context);
vm.runInContext(source.replace(/\bconst\s+/g, 'var ').replace(/\blet\s+/g, 'var '), context);
const headers = [...context.DISCORD_CHANNEL_HEADERS_];
const row = (values) => headers.map((header) => values[header] ?? '');
const rows = [
  row({ カテゴリ: '営業', チャンネル名: 'Sales News', チャンネルID: '1234567890123456789', 種別: 'テキスト', チャンネルURL: 'u1', '用途・何のチャンネルか【手入力】': '速報', '担当【手入力】': 'kim', 状態: 'あり', '最終確認日(JST)': '2026-08-31' }),
  row({ カテゴリ: '営業', チャンネル名: 'sales　room', チャンネルID: '2234567890123456789', 種別: 'テキスト', チャンネルURL: 'u2', 状態: 'あり' }),
  row({ カテゴリ: '旧', チャンネル名: 'sales old', チャンネルID: '3234567890123456789', 種別: 'テキスト', 状態: '削除/非表示' }),
];

test('discordMatchRows supports partial and exact matching', () => {
  assert.equal(context.discordMatchRows(headers, rows, { query: 'news' }).rows[0].id, '1234567890123456789');
  assert.equal(context.discordMatchRows(headers, rows, { query: 'sales', exact: true }).count, 0);
  assert.equal(context.discordMatchRows(headers, rows, { query: 'Sales News', exact: true }).count, 1);
});

test('discordMatchRows ignores case and full/half-width spaces', () => {
  const result = context.discordMatchRows(headers, rows, { query: 'SALES ROOM', exact: true });
  assert.equal(result.rows[0].id, '2234567890123456789');
});

test('discordMatchRows prioritizes exact 19-digit IDs', () => {
  const result = context.discordMatchRows(headers, rows, { query: '1234567890123456789' });
  assert.equal(result.count, 1);
  assert.equal(result.rows[0].name, 'Sales News');
});

test('discordMatchRows excludes missing rows unless requested', () => {
  assert.equal(context.discordMatchRows(headers, rows, { query: 'old' }).count, 0);
  assert.equal(context.discordMatchRows(headers, rows, { query: 'old', includeMissing: true }).count, 1);
});

test('discordMatchRows enforces limit and reports truncation', () => {
  const result = context.discordMatchRows(headers, rows, { query: '', includeMissing: true, limit: 2 });
  assert.equal(result.count, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
});

test('pickResult returns only the ID for one row', () => {
  assert.deepEqual(pickResult([{ id: '123', name: 'general' }]), { exitCode: 0, stdout: '123\n', stderr: '' });
});

test('pickResult rejects ambiguous and empty results', () => {
  const many = pickResult([{ id: '1', name: 'a' }, { id: '2', name: 'b' }]);
  assert.equal(many.exitCode, 1);
  assert.match(many.stderr, /1 \/ a/);
  const empty = pickResult([]);
  assert.equal(empty.exitCode, 1);
  assert.equal(empty.stdout, '');
});

test('pickResult JSON always exits zero', () => {
  for (const values of [[], [{ id: '1' }], [{ id: '1' }, { id: '2' }]]) {
    const result = pickResult(values, { json: true, query: 'x' });
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), { query: 'x', count: values.length, rows: values });
  }
});

test('formatChannelLines tolerates empty manual purpose', () => {
  assert.equal(formatChannelLines([{ id: '1', name: 'general', category: 'info' }]), 'ID / 名前 / カテゴリ / 用途\n1 / general / info / ');
});
