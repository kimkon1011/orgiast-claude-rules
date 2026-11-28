import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAssignment, runCases, loadCatalog, findPerson, CASES } from './staff-location-assign.mjs';

const catalog = loadCatalog();

test('所在一覧に番地・部屋番号を書かない', () => {
  for (const person of catalog.people) {
    if (person.residence !== 'unknown') {
      assert.match(person.residence, /都|道|府|県|市|区/);
      assert.doesNotMatch(person.residence, /\d/);
    }
  }
});

test('名前解決', () => {
  assert.equal(findPerson(catalog, '澤山さん').id, 'sawayama-takatoshi');
  assert.equal(findPerson(catalog, 'なっちゃん').id, 'nomura-natsuko');
  assert.equal(findPerson(catalog, '野村那津子').id, 'nomura-natsuko');
  assert.equal(findPerson(catalog, '澤田武').id, 'sawada-takeshi');
});

test('定義したケースはすべて合格する', () => {
  const rows = runCases(catalog);
  const failed = rows.filter((row) => !row.pass);
  assert.equal(failed.length, 0, failed.map((row) => `${row.id}:${row.result.code}`).join(','));
  assert.ok(CASES.length >= 3);
});

test('店舗を離れる印刷・郵送はカフェ不可、なっちゃん可', () => {
  const cafe = evaluateAssignment({ task: '書類を印刷して郵送して', location: '大阪', assignee: 'カフェスタッフ' }, catalog);
  const natchan = evaluateAssignment({ task: '書類を印刷して郵送して', location: '大阪', assignee: 'なっちゃん' }, catalog);
  assert.equal(cafe.ok, false);
  assert.equal(cafe.code, 'cafe-cannot-leave');
  assert.equal(natchan.ok, true);
});

test('住まい不明のアシスタントに法務局は割り振らない', () => {
  const result = evaluateAssignment({ task: '法務局で証明書を取って', location: '大阪', assignee: '田中歩' }, catalog);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'residence-unknown');
  assert.ok((result.suggested || []).includes('なっちゃん'));
});

test('倉庫の受取は澤田さんに限り、佐藤優奈さんには振らない', () => {
  const ok = evaluateAssignment({ task: '倉庫で荷物を受け取って', assignee: '澤田さん' }, catalog);
  const no = evaluateAssignment({ task: '倉庫で荷物を受け取って', assignee: '佐藤優奈' }, catalog);
  assert.equal(ok.ok, true);
  assert.equal(no.ok, false);
  assert.ok((no.suggested || []).includes('澤田武'));
});
