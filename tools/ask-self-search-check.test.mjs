import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from './ask-self-search-check.mjs';

// T1: 金さんのマイナンバー写しの場所をなっちゃん(staff, itemOwner kim)に聞く → block
test('T1: 金さん本人の写しを社員に聞くとblock', () => {
  const result = judge({
    question: '金さんのマイナンバーの写しはどこにありますか？',
    targetType: 'staff',
    searchedPlaces: ['Google Drive全体', 'Gmail', '過去チャット'],
    itemOwner: 'kim',
    itemHandledBy: 'なっちゃん',
    askTarget: 'なっちゃん',
    yesNoForm: true,
    found: false,
  });
  assert.equal(result.verdict, 'block');
  assert.ok(
    result.reasons.some((r) => r.includes('社員に聞かない')),
    `理由に『社員に聞かない』を含むこと: ${JSON.stringify(result.reasons)}`
  );
});

// T2: 金さんに探す作業を返す質問＋未検索＋非yesNo → block
test('T2: 金さんに「置いていれば教えて／なければないと返して」はblock', () => {
  const result = judge({
    question: '写しを置いていれば場所を教えてください。なければ「ない」と返してください',
    targetType: 'kim',
    searchedPlaces: [],
    itemOwner: 'kim',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: false,
    found: false,
  });
  assert.equal(result.verdict, 'block');
  assert.ok(result.reasons.some((r) => r.includes('探した場所の一覧が無い')));
  assert.ok(result.reasons.some((r) => r.includes('探す範囲が足りない')));
  assert.ok(result.reasons.some((r) => r.includes('はい／いいえ')));
  assert.ok(result.reasons.some((r) => r.includes('探す作業を金さんに返している')));
});

// T3: found=true → pass（他の条件が悪くても質問不要）
test('T3: 探して見つかった場合はpass', () => {
  const result = judge({
    question: '写しはどこにありますか？',
    targetType: 'kim',
    searchedPlaces: [],
    itemOwner: 'kim',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: false,
    found: true,
  });
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.reasons, ['探して見つかったので質問不要（送らない）']);
});

// T4: 金さんに「印刷されましたか？」→ block（AIが確かめられる）
test('T4: 印刷されたかを金さんに聞くとblock', () => {
  const result = judge({
    question: '印刷されましたか？',
    targetType: 'kim',
    searchedPlaces: ['Google Drive全体', 'Gmail', '過去チャット'],
    itemOwner: 'kim',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: true,
    found: false,
  });
  assert.equal(result.verdict, 'block');
  assert.ok(
    result.reasons.some((r) => r.includes('AIが確かめられること')),
    `理由に『AIが確かめられること』を含むこと: ${JSON.stringify(result.reasons)}`
  );
});

// T5: 実際に扱った社員本人に聞く → pass
test('T5: 物を扱った社員本人に聞くとpass', () => {
  const result = judge({
    question: '昨日あなたが受け取った原本の置き場所は？',
    targetType: 'staff',
    searchedPlaces: ['Drive全体', 'Gmail', '過去チャット'],
    itemOwner: 'staff',
    itemHandledBy: 'なっちゃん',
    askTarget: 'なっちゃん',
    yesNoForm: false,
    found: false,
  });
  assert.equal(result.verdict, 'pass');
  assert.deepEqual(result.reasons, ['全項目合格']);
});

// T6: 「誰がいつ取得したか」を金さんに聞く → block、取得した本人に聞く → pass
test('T6: 取得者・取得日を金さんに聞くとblock、取得本人に聞くとpass', () => {
  const toKim = judge({
    question: '資格証明書は誰がいつどこで取得しましたか',
    targetType: 'kim',
    searchedPlaces: [],
    itemOwner: 'staff',
    itemHandledBy: '田中',
    askTarget: '金さん',
    yesNoForm: false,
    found: false,
  });
  assert.equal(toKim.verdict, 'block');
  assert.ok(toKim.reasons.some((r) => r.includes('AIが確かめられること')));

  const toHandler = judge({
    question: '資格証明書は誰がいつどこで取得しましたか',
    targetType: 'staff',
    searchedPlaces: ['Google Drive全体', 'Gmail', '過去チャット'],
    itemOwner: 'staff',
    itemHandledBy: '田中',
    askTarget: '田中',
    yesNoForm: false,
    found: false,
  });
  assert.equal(toHandler.verdict, 'pass');
  assert.deepEqual(toHandler.reasons, ['全項目合格']);
});

// T7: 未検索のまま聞く → block、探して無かった報告＋はい/いいえ形式 → pass
test('T7: 未検索はblock、検索済みでyesNo形式ならpass', () => {
  const notSearched = judge({
    question: '趣意書はありますか',
    targetType: 'kim',
    searchedPlaces: [],
    itemOwner: 'unknown',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: false,
    found: false,
  });
  assert.equal(notSearched.verdict, 'block');
  assert.ok(notSearched.reasons.some((r) => r.includes('探した場所の一覧が無い')));

  const searched = judge({
    question: '趣意書は見つかりませんでした。お手元にありますか？［はい／いいえ］',
    targetType: 'kim',
    searchedPlaces: ['Google Drive全体', 'Gmail', '学会サイト'],
    itemOwner: 'unknown',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: true,
    found: false,
  });
  assert.equal(searched.verdict, 'pass');
  assert.deepEqual(searched.reasons, ['全項目合格']);
});

// T8: 探した場所リスト付き＋yesNoForm true → pass、自由記述「場所を教えて」型 → block
test('T8: 検索済みyesNo形式はpass、「場所を教えて」型はblock', () => {
  const ok = judge({
    question: '保険証の写しは見つかりませんでした。お手元にありますか？［はい／いいえ］',
    targetType: 'kim',
    searchedPlaces: ['Google Drive全体', 'Gmail', '案件フォルダ'],
    itemOwner: 'kim',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: true,
    found: false,
  });
  assert.equal(ok.verdict, 'pass');
  assert.deepEqual(ok.reasons, ['全項目合格']);

  const ng = judge({
    question: '保険証の写しの場所を教えてください',
    targetType: 'kim',
    searchedPlaces: ['Google Drive全体', 'Gmail', '案件フォルダ'],
    itemOwner: 'kim',
    itemHandledBy: null,
    askTarget: '金さん',
    yesNoForm: false,
    found: false,
  });
  assert.equal(ng.verdict, 'block');
  assert.ok(ng.reasons.some((r) => r.includes('はい／いいえ')));
  assert.ok(ng.reasons.some((r) => r.includes('探す作業を金さんに返している')));
});
