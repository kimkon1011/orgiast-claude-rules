import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 実ファイル tools/eval-providers.json を守る回帰テスト。
// eval-harness.test.mjs は一時ディレクトリに自前の config を書くため、実ファイルは無検査だった。
// ここの skip が外れると毎晩15件の 403 (tier_not_allowed) を無駄撃ちし続けるので内容を固定する。
const config = JSON.parse(fs.readFileSync(new URL('eval-providers.json', import.meta.url), 'utf8'));

test('eval-providers.json は provider/model を持つ配列', () => {
  assert.ok(Array.isArray(config), '配列であること');
  assert.ok(config.length > 0, '空ではないこと');
  for (const entry of config) {
    assert.equal(typeof entry.provider, 'string', `provider が文字列でない: ${JSON.stringify(entry)}`);
    assert.equal(typeof entry.model, 'string', `model が文字列でない: ${JSON.stringify(entry)}`);
    if ('skip' in entry) assert.equal(typeof entry.skip, 'boolean', 'skip は真偽値');
  }
  const names = config.map((x) => x.provider);
  assert.equal(new Set(names).size, names.length, `provider が重複している: ${names.join(',')}`);
});

test('mistral は skip:true（mistral-large-latest は契約で tier_not_allowed 403 になる）', () => {
  const mistral = config.find((x) => x.provider === 'mistral');
  assert.ok(mistral, 'mistral エントリが消えている');
  assert.equal(
    mistral.skip,
    true,
    'skip を外すと eval が毎晩 mistral へ 15 件投げて全部 403 になる。' +
      'eval-harness.mjs 159行目が x.skip を見て実行前に continue するので、skip がそのまま無駄撃ち停止になる。' +
      'Mistral の契約を上げて mistral-large-latest が使えるようになったら外してよい',
  );
});
