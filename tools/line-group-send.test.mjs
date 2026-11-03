import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, buildMessages, loadSecrets, resolveGroup, assertSendableText } from './line-group-send.mjs';

test('assertSendableText: 文字化けとプレースホルダ残りは送らない', () => {
  assert.doesNotThrow(() => assertSendableText('皆さん、お疲れさまです。'));
  assert.throws(() => assertSendableText('Ã§Ã£Ã¤Ã¥Ã¦'), /文字化け/);
  assert.throws(() => assertSendableText('料金は XX 円です'), /プレースホルダ/);
});

test('parseArgs: グループと本文・画像を受け取る', () => {
  const o = parseArgs(['--group', '株式会社ラハイナ', '--text-file', 'a.txt', '--image', '1.jpg', '--image', '2.jpg', '--dry-run']);
  assert.equal(o.group, '株式会社ラハイナ');
  assert.deepEqual(o.images, ['1.jpg', '2.jpg']);
  assert.equal(o.dryRun, true);
});

test('parseArgs: グループ無し・本文も画像も無しは使い方エラー', () => {
  assert.throws(() => parseArgs(['--text-file', 'a.txt']), /使い方/);
  assert.throws(() => parseArgs(['--group', 'x']), /使い方/);
  assert.throws(() => parseArgs(['--group', 'x', '--bogus']), /不明なオプション/);
});

test('buildMessages: 本文が先頭・1回の push は最大5件', () => {
  const chunks = buildMessages('本文', ['u1', 'u2', 'u3', 'u4', 'u5']);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, 5);
  assert.deepEqual(chunks[0][0], { type: 'text', text: '本文' });
  assert.equal(chunks[1][0].originalContentUrl, 'u5');
  assert.equal(buildMessages('', ['u1']).flat()[0].type, 'image');
});

test('loadSecrets: env と line-send.env が揃えば Vercel に行かない', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lgs-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'line-send.env'), 'SUPABASE_URL=https://x.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=k\n');
  const s = await loadSecrets({ env: { LINE_CHANNEL_ACCESS_TOKEN: 't' }, home });
  assert.equal(s.LINE_CHANNEL_ACCESS_TOKEN, 't');
  assert.equal(s.SUPABASE_URL, 'https://x.supabase.co');
});

test('resolveGroup: groupId はそのまま、名前は Supabase 無しならエラー', async () => {
  const id = 'C812a1d8216456feca9043b9f8d3bd35d';
  assert.equal(await resolveGroup({}, id), id);
  await assert.rejects(() => resolveGroup({}, '株式会社ラハイナ'), /SUPABASE_URL/);
});
