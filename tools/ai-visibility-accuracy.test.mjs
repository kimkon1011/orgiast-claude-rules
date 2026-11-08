import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAiVisibilityAccuracy } from './ai-visibility-accuracy.mjs';

const canonicalFacts = {
  companyName: '株式会社サンプル展示',
  location: '大阪府大阪市北区1-2-3',
  foundedYear: 2012,
  representative: '山田 花子',
};

function judge(response) {
  return scoreAiVisibilityAccuracy({ response, canonicalFacts });
}

test('canonical facts と完全一致する会社情報を受け入れる', () => {
  const result = judge([
    '会社名: 株式会社サンプル展示',
    '所在地: 大阪府大阪市北区1-2-3',
    '設立年: 2012年',
    '代表者: 山田 花子',
  ].join('\n'));
  assert.equal(result.decision, 'pass');
  assert.equal(result.score, 1);
});

const rejected = [
  ['別会社名', '会社名: 株式会社サンプル\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2012年\n代表者: 山田 花子', 'companyName'],
  ['所在地違い', '会社名: 株式会社サンプル展示\n所在地: 東京都港区9-9-9\n設立年: 2012年\n代表者: 山田 花子', 'location'],
  ['設立年違い', '会社名: 株式会社サンプル展示\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2021年\n代表者: 山田 花子', 'foundedYear'],
  ['代表者違い', '会社名: 株式会社サンプル展示\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2012年\n代表者: 山田 太郎', 'representative'],
  ['正答と誤答の併記', '会社名: 株式会社サンプル展示\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2012年\n代表者: 山田 花子\n代表者: 山田 太郎', 'representative'],
];

for (const [name, response, failedField] of rejected) test(`${name}を拒否する`, () => {
  const result = judge(response);
  assert.equal(result.decision, 'fail');
  assert.equal(result.details[failedField].pass, false);
});

test('年の部分文字列一致を拒否する', () => {
  const result = judge('会社名: 株式会社サンプル展示\n所在地: 大阪府大阪市北区1-2-3\n設立年: 12012年\n代表者: 山田 花子');
  assert.equal(result.decision, 'fail');
  assert.equal(result.details.foundedYear.pass, false);
});

test('会社名の部分文字列一致を拒否する', () => {
  const result = judge('会社名: 株式会社サンプル展示ホールディングス\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2012年\n代表者: 山田 花子');
  assert.equal(result.decision, 'fail');
  assert.equal(result.details.companyName.pass, false);
});

test('canonical facts の省略を許さない', () => {
  const result = judge('会社名: 株式会社サンプル展示');
  assert.equal(result.decision, 'fail');
  assert.equal(result.details.location.reason, 'missing');
});

test('空の canonical facts を拒否する', () => {
  assert.throws(() => scoreAiVisibilityAccuracy({ response: 'anything', canonicalFacts: {} }), /must not be empty/);
});

const correct = '会社名: 株式会社サンプル展示\n所在地: 大阪府大阪市北区1-2-3\n設立年: 2012年\n代表者: 山田 花子';

for (const [field, wrong] of [
  ['会社名', '株式会社別会社'], ['所在地', '東京都港区'],
  ['設立年', '2021年'], ['代表者', '山田 太郎'],
]) {
  test(`${field}の正答と誤答を別行に併記しても拒否`, () => {
    assert.equal(judge(`${correct}\n${field}: ${wrong}`).decision, 'fail');
  });
  test(`${field}の正答の後に同じ行で誤答を追加しても拒否`, () => {
    const response = correct.replace(new RegExp(`(${field}: [^\\n]+)`), `$1、${wrong}`);
    assert.equal(judge(response).decision, 'fail');
  });
}

test('正答の後の未解析文にある幻覚を見逃さない', () => {
  for (const extra of ['実際は2021年設立です。', '株式会社別会社の会社概要です。', '- 代表者: 山田 太郎']) {
    assert.equal(judge(`${correct}\n${extra}`).decision, 'fail');
  }
});

test('別会社の見出しの下の正しい値を合格させない', () => {
  assert.equal(judge(`株式会社別会社\n${correct}`).decision, 'fail');
});

test('検証用canonical factsがないフィールドを黙認しない', () => {
  const result = scoreAiVisibilityAccuracy({ response: correct, canonicalFacts: { companyName: canonicalFacts.companyName } });
  assert.equal(result.decision, 'fail');
  assert.deepEqual(result.uncheckedFields, ['location', 'foundedYear', 'representative']);
});

test('全角のラベル区切りと年はNFKC正規化で照合できる', () => {
  assert.equal(judge(correct.replaceAll(':', '：').replace('2012', '２０１２')).decision, 'pass');
  assert.deepEqual(judge(correct), judge(correct));
});

test('不正入力や継承プロパティ名をcanonical factsとして受け付けない', () => {
  for (const canonicalFacts of [{ toString: 'x' }, { foundedYear: '12012' }, { companyName: '' }]) {
    assert.throws(() => scoreAiVisibilityAccuracy({ response: correct, canonicalFacts }), TypeError);
  }
  assert.throws(() => scoreAiVisibilityAccuracy({ response: null, canonicalFacts }), TypeError);
});
