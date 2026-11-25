// customer-data-local-vs-cloud.mjs の純関数のみをテストする（ネットワーク・Ollama不要）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { CASES, FIELDS, buildPrompt, canon, extractJson, scoreRecord } from './customer-data-local-vs-cloud.mjs';

test('extractJson: 素のJSONを読む', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test('extractJson: コードフェンスと前置き混入に耐える', () => {
  const s = 'はい、こちらです。\n```json\n{"a": 1, "b": "x"}\n```\nご確認ください。';
  assert.deepEqual(extractJson(s), { a: 1, b: 'x' });
});

test('extractJson: 壊れたJSON/非文字列は null', () => {
  assert.equal(extractJson('{壊れている'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('canon: 電話は数字のみ・郵便は7桁・メールは小文字', () => {
  assert.equal(canon('phone', '０３－１２３４－５６７８'), '0312345678');
  assert.equal(canon('postal_code', '〒150-0001'), '1500001');
  assert.equal(canon('email', ' Yamada.Taro@Example.co.jp '), 'yamada.taro@example.co.jp');
});

test('canon: 全角スペースと敬称を落とす', () => {
  assert.equal(canon('name', '山田　太郎 様'), '山田 太郎');
  assert.equal(canon('company', '株式会社テスト さん'), '株式会社テスト');
});

test('scoreRecord: 完全一致で schemaOk かつ全項目一致', () => {
  const g = { customer_id: 'C-1001', name: '山田 太郎', company: 'A', postal_code: '1500001', prefecture: '東京都', city: '渋谷区', address: 'X', phone: '0312345678', email: 'a@b.jp' };
  const r = scoreRecord(g, { ...g });
  assert.equal(r.schemaOk, true);
  assert.equal(r.matched, FIELDS.length);
  assert.equal(r.total, FIELDS.length);
});

test('scoreRecord: 表記ゆれは canon 経由で吸収して一致とみなす', () => {
  const g = { customer_id: 'C-1001', name: '山田 太郎', company: 'A', postal_code: '1500001', prefecture: '東京都', city: '渋谷区', address: 'X', phone: '0312345678', email: 'a@b.jp' };
  const got = { ...g, phone: '03-1234-5678', email: 'A@B.JP', name: '山田 太郎 様' };
  const r = scoreRecord(g, got);
  assert.equal(r.matched, FIELDS.length);
});

test('scoreRecord: キー欠落は schemaOk=false だが項目一致は数える', () => {
  const g = CASES[0].gold;
  const got = { ...g };
  delete got.email;
  const r = scoreRecord(g, got);
  assert.equal(r.schemaOk, false);
  assert.equal(r.matched, FIELDS.length - 1);
});

test('scoreRecord: JSONでない入力は 0 点', () => {
  assert.deepEqual(scoreRecord(CASES[0].gold, null).matched, 0);
  assert.equal(scoreRecord(CASES[0].gold, null).schemaOk, false);
});

test('buildPrompt: 入力原文と customer_id 指示を含む', () => {
  const p = buildPrompt(CASES[1]);
  assert.ok(p.includes(CASES[1].raw));
  assert.ok(p.includes('C-1002'));
  for (const f of FIELDS) assert.ok(p.includes(f), 'キー ' + f + ' が指示に無い');
});

test('CASES: gold は自分のスキーマを満たす（採点基準の自己整合）', () => {
  for (const c of CASES) {
    const r = scoreRecord(c.gold, c.gold);
    assert.equal(r.schemaOk, true, c.id + ' の gold がスキーマ違反');
    assert.equal(r.matched, FIELDS.length, c.id + ' の gold が自己不一致');
    assert.ok(c.raw.includes(c.id) || c.raw.length > 0, c.id + ' の raw が空');
  }
});

test('CASES: 合成データのみ（実在しそうな実ドメインを含まない）', () => {
  for (const c of CASES) {
    assert.match(c.gold.email, /@[a-z0-9.-]*example\.(jp|com|co\.jp)$/, c.id + ' のメールが example ドメインでない');
  }
});
