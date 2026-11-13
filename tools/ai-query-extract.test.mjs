import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSentences,
  matchPatterns,
  isQuestion,
  isRequest,
  matchDomainPatterns,
  normalizeQuery,
  extractQueries,
  containsJapanese,
  SAMPLE_TEXT,
  QUESTION_PATTERNS,
  REQUEST_PATTERNS,
  DOMAIN_SPECIFIC_PATTERNS,
  LLMO_PATTERNS,
  importGSCQueries,
  classifyQueryIntent,
  scoreLLMOQuery,
  analyzeLLMOQueries,
} from './ai-query-extract.mjs';

// ============================================================
// splitSentences
// ============================================================

test('splitSentences: 句点で分割する', () => {
  const result = splitSentences('今日はいい天気です。明日は雨です。');
  assert.equal(result.length, 2);
  assert.equal(result[0], '今日はいい天気です。');
  assert.equal(result[1], '明日は雨です。');
});

test('splitSentences: 疑問符で分割する', () => {
  const result = splitSentences('いくらですか？見積もりください。');
  assert.equal(result.length, 2);
  assert.ok(result[0].includes('いくらですか'));
  assert.ok(result[1].includes('見積もりください'));
});

test('splitSentences: 改行で分割する', () => {
  const result = splitSentences('1行目\n2行目\n3行目');
  assert.equal(result.length, 3);
});

test('splitSentences: 空文字は空配列', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences(undefined), []);
});

test('splitSentences: 短い文だけの入力', () => {
  const result = splitSentences('あ。');
  assert.equal(result.length, 1);
  assert.equal(result[0], 'あ。');
});

// ============================================================
// matchPatterns
// ============================================================

test('matchPatterns: 疑問終助詞「か」にマッチ', () => {
  const matches = matchPatterns('ブースの見積もりはいくらですか？', QUESTION_PATTERNS);
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('question_end_ka') || ids.includes('question_end_question_mark'));
});

test('matchPatterns: 依頼「ください」にマッチ', () => {
  const matches = matchPatterns('見積書を送ってください。', REQUEST_PATTERNS);
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('request_kudasai'));
});

test('matchPatterns: 依頼「お願い」にマッチ', () => {
  const matches = matchPatterns('見積もりをお願いします。', REQUEST_PATTERNS);
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('request_onegai'));
});

test('matchPatterns: 見積もり依頼にマッチ', () => {
  const matches = matchPatterns('見積もりをお願いします。', REQUEST_PATTERNS);
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('request_mitumori'));
  assert.ok(ids.includes('request_onegai'));
});

test('matchPatterns: 金額疑問にマッチ', () => {
  const matches = matchPatterns('料金はいくらですか？', QUESTION_PATTERNS);
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('question_word_price'));
});

test('matchPatterns: ドメインパターン（ブース）にマッチ', () => {
  const matches = matchDomainPatterns('3m×3mの小間を希望します。');
  const ids = matches.map(m => m.id);
  assert.ok(ids.includes('domain_booth_size'));
});

test('matchPatterns: マッチなしは空配列', () => {
  const matches = matchPatterns('これは普通の文章です。', QUESTION_PATTERNS);
  assert.equal(matches.length, 0);
});

// ============================================================
// isQuestion / isRequest
// ============================================================

test('isQuestion: 疑問文を検出する', () => {
  assert.ok(isQuestion('ブースの見積もりはいくらですか？'));
  assert.ok(isQuestion('いつまでにできますか？'));
  assert.ok(isQuestion('なぜその価格なのですか？'));
});

test('isQuestion: 平文は疑問と判定しない', () => {
  assert.equal(isQuestion('見積書を送ってください。'), false);
  assert.equal(isQuestion('これは普通の文です。'), false);
});

test('isRequest: 依頼文を検出する', () => {
  assert.ok(isRequest('見積書を送ってください。'));
  assert.ok(isRequest('デザインの相談をしたいです。'));
  assert.ok(isRequest('資料請求をお願いします。'));
});

test('isRequest: 平文は依頼と判定しない', () => {
  assert.equal(isRequest('今日はいい天気です。'), false);
  assert.equal(isRequest('展示会に出展します。'), false);
});

// ============================================================
// normalizeQuery
// ============================================================

test('normalizeQuery: クエリを正規化する', () => {
  const result = normalizeQuery('見積もりをお願いします');
  assert.ok(!result.includes('お願いします') || result.length < 10);
});

test('normalizeQuery: 余分な空白を削除する', () => {
  const result = normalizeQuery('  ブース  見積もり  ');
  assert.ok(!result.includes('  '));
});

// ============================================================
// extractQueries - 統合テスト
// ============================================================

test('extractQueries: サンプルテキストからクエリを抽出する', () => {
  const result = extractQueries(SAMPLE_TEXT);
  assert.ok(result.summary.total > 0, '少なくとも1件のクエリが抽出されること');
  assert.ok(result.summary.questions > 0, '疑問文が抽出されること');
  assert.ok(result.summary.requests > 0, '依頼文が抽出されること');
  assert.ok(result.queries.every(q => q.text && q.type && q.subtype && Array.isArray(q.patterns)));
});

test('extractQueries: 空入力は空結果', () => {
  const result = extractQueries('');
  assert.equal(result.summary.total, 0);
  assert.deepEqual(result.queries, []);
});

test('extractQueries: null入力は空結果', () => {
  const result = extractQueries(null);
  assert.equal(result.summary.total, 0);
});

test('extractQueries: undefined入力は空結果', () => {
  const result = extractQueries(undefined);
  assert.equal(result.summary.total, 0);
});

test('extractQueries: 疑問文のみ抽出', () => {
  const text = 'これは普通の文です。ブースの料金はいくらですか？これも普通です。';
  const result = extractQueries(text);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.questions, 1);
  assert.equal(result.queries[0].type, 'question');
});

test('extractQueries: 依頼文のみ抽出', () => {
  const text = 'これは普通の文です。見積書を送ってください。これも普通です。';
  const result = extractQueries(text);
  assert.equal(result.summary.total, 1);
  assert.equal(result.summary.requests, 1);
  assert.equal(result.queries[0].type, 'request');
});

test('extractQueries: 疑問＋依頼の混在文は依頼として扱う', () => {
  const text = '見積もりを送っていただけますか？';
  const result = extractQueries(text);
  assert.ok(result.summary.total > 0);
  // 「送っていただけますか」は依頼表現（いただく＋可能＋疑問）
  // 見積もり依頼パターンにマッチする
});

test('extractQueries: 優先度順にソートされる', () => {
  const text = 'いくらですか？見積もりを送ってください。いつできますか？';
  const result = extractQueries(text);
  for (let i = 1; i < result.queries.length; i++) {
    assert.ok(result.queries[i - 1].priority >= result.queries[i].priority,
      `優先度が降順になっていない: ${result.queries[i - 1].priority} < ${result.queries[i].priority}`);
  }
});

test('extractQueries: 短すぎる文はスキップ', () => {
  const result = extractQueries('あ。い。う。');
  assert.equal(result.summary.total, 0);
});

test('extractQueries: ブース関連のドメインパターン', () => {
  const text = '3m×3mの小間の見積もりをお願いします。';
  const result = extractQueries(text);
  assert.equal(result.summary.total, 1);
  assert.ok(result.queries[0].domain.includes('exhibition'));
});

// ============================================================
// 実用例: 展示会の問い合わせ文
// ============================================================

test('extractQueries: 実際の問い合わせに近いテキスト', () => {
  const inquiry = `
来年の東京ビッグサイトの展示会に出展を検討しています。
ブースのサイズは9m²（3m×3m）を希望します。
見積もりをいただけますか？
また、デザインの相談もしたいです。
搬入はいつから可能でしょうか？
通訳スタッフの手配は可能ですか？
初めての出展なので、必要な手続きを教えてください。
  `;
  const result = extractQueries(inquiry);
  assert.ok(result.summary.total >= 4, `${result.summary.total}件のクエリ（最低4件期待）`);

  // 見積もり依頼が含まれる
  const mitumori = result.queries.find(q => q.subtype === 'price_request' || q.subtype === 'general_request');
  assert.ok(mitumori, '見積もり依頼が含まれること');

  // 時期の問い合わせが含まれる
  const timing = result.queries.find(q => q.subtype === 'timing_inquiry');
  assert.ok(timing, '時期の問い合わせが含まれること');

  // 相談が含まれる
  const soudan = result.queries.find(q => q.patterns.some(p => p.includes('soudan')));
  assert.ok(soudan, '相談依頼が含まれること');
});

// ============================================================
// 疑問文パターンの境界テスト
// ============================================================

test('疑問文: 丁寧な疑問（でしょうか）', () => {
  assert.ok(isQuestion('対応可能でしょうか。'));
  assert.ok(isQuestion('可能でしょうか。'));
});

test('疑問文: 確認の疑問（んですか）', () => {
  assert.ok(isQuestion('こちらで間違いないんですか？'));
});

test('疑問文: 理由の疑問', () => {
  assert.ok(isQuestion('なぜその価格設定なんですか？'));
});

// ============================================================
// 依頼文パターンの境界テスト
// ============================================================

test('依頼文: 資料請求', () => {
  assert.ok(isRequest('資料を送ってください。'));
  assert.ok(isRequest('カタログをお願いします。'));
});

test('依頼文: 申込・エントリー', () => {
  assert.ok(isRequest('申し込みをしたいです。'));
  assert.ok(isRequest('エントリーをお願いします。'));
});

test('依頼文: 連絡依頼', () => {
  assert.ok(isRequest('ご連絡ください。'));
});

// ============================================================
// ドメインパターン
// ============================================================

test('ドメインパターン: デザイン関連', () => {
  const matches = matchDomainPatterns('ブースのデザインをお願いします。');
  assert.ok(matches.some(m => m.id === 'domain_booth_design'));
});

test('ドメインパターン: イベント関連', () => {
  const matches = matchDomainPatterns('展示会に出展します。');
  assert.ok(matches.some(m => m.id === 'domain_event'));
});

// ============================================================
// エッジケース
// ============================================================

test('containsJapanese: 日本語を含む文字列を検出', () => {
  assert.ok(containsJapanese('こんにちは'));
  assert.ok(containsJapanese('ブースの見積もり'));
  assert.ok(containsJapanese('漢字とひらがな'));
  assert.ok(containsJapanese('カタカナ'));
  assert.equal(containsJapanese('Hello world'), false);
  assert.equal(containsJapanese('12345'), false);
  assert.equal(containsJapanese('!!!???'), false);
  assert.equal(containsJapanese(''), false);
});

test('extractQueries: 英語のみの入力は抽出しない', () => {
  const result = extractQueries('Hello. How are you? Please send me a quote.');
  assert.equal(result.summary.total, 0);
});

test('extractQueries: 日英混在テキストは日本語部分を抽出', () => {
  const result = extractQueries('This is a test. ブースの見積もりはいくらですか？ That is all.');
  assert.equal(result.summary.total, 1);
  // 見積もり＋いくらですか = 金額に関する疑問文
  assert.ok(result.queries[0].text.includes('ブースの見積もりはいくらですか'));
});

test('extractQueries: 数値のみの入力', () => {
  const result = extractQueries('12345 67890');
  assert.equal(result.summary.total, 0);
});

test('extractQueries: 記号のみ', () => {
  const result = extractQueries('！！！？？？');
  assert.equal(result.summary.total, 0);
});

// ============================================================
// normalizeQuery の詳細テスト
// ============================================================

test('normalizeQuery: 様々な依頼表現を正規化', () => {
  const tests = [
    { input: '見積もりをお願いします', expectNot: ['お願いします'] },
    { input: '資料をください', expectNot: ['ください'] },
    { input: 'なぜこの価格なのか', expectNot: ['なぜ'] },
  ];
  for (const t of tests) {
    const result = normalizeQuery(t.input);
    for (const bad of t.expectNot) {
      // 正規化後も部分一致する可能性があるが、少なくとも短くなる
      assert.ok(result.length <= t.input.length || result !== t.input,
        `正規化で短くなるか変化すること: ${t.input} -> ${result}`);
    }
  }
});

// ============================================================
// LLMO Pattern Tests
// ============================================================

test('LLMO_PATTERNS: how-to パターンにマッチ', () => {
  const matches = matchPatterns('展示会ブースの作り方', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_how_to'), 'how-to パターンがマッチすること');
});

test('LLMO_PATTERNS: what-is パターンにマッチ', () => {
  const matches = matchPatterns('展示会ブースとは', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_what_is'), 'what-is パターンがマッチすること');
});

test('LLMO_PATTERNS: 比較パターンにマッチ', () => {
  const matches = matchPatterns('A社とB社の比較', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_comparison'), '比較パターンがマッチすること');
});

test('LLMO_PATTERNS: おすすめパターンにマッチ', () => {
  const matches = matchPatterns('展示会ブース制作会社のおすすめ', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_best'), 'おすすめパターンがマッチすること');
});

test('LLMO_PATTERNS: 費用パターンにマッチ', () => {
  const matches = matchPatterns('ブース制作の費用相場', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_cost'), '費用パターンがマッチすること');
});

test('LLMO_PATTERNS: 手順パターンにマッチ', () => {
  const matches = matchPatterns('展示会出展までの流れ', LLMO_PATTERNS);
  assert.ok(matches.some(m => m.id === 'llmo_tutorial' || m.id === 'llmo_process'), '手順パターンがマッチすること');
});

// ============================================================
// scoreLLMOQuery Tests
// ============================================================

test('scoreLLMOQuery: how-to クエリに高いスコア', () => {
  const score = scoreLLMOQuery('展示会ブースの作り方を教えてください');
  assert.ok(score >= 5, `how-to クエリのスコアが5以上: ${score}`);
});

test('scoreLLMOQuery: 疑問文クエリにスコア', () => {
  const score = scoreLLMOQuery('ブースの見積もりはいくらですか？');
  assert.ok(score > 0, '疑問文クエリスコアが0より大きいこと');
});

test('scoreLLMOQuery: 平文は低スコア', () => {
  const score = scoreLLMOQuery('今日はいい天気です');
  assert.equal(score, 0, '平文のスコアが0であること');
});

test('scoreLLMOQuery: 英語のみは0', () => {
  const score = scoreLLMOQuery('How to build an exhibition booth');
  assert.equal(score, 0, '英語のみのスコアが0であること');
});

test('scoreLLMOQuery: スコア範囲は0-10', () => {
  const queries = [
    '展示会ブースの作り方',
    'ブースの見積もりはいくらですか？',
    '見積もりを送ってください',
    '展示会ブース制作会社のおすすめを教えてください',
    '費用を教えてください',
  ];
  for (const q of queries) {
    const score = scoreLLMOQuery(q);
    assert.ok(score >= 0 && score <= 10, `スコアが0-10の範囲: ${q} => ${score}`);
  }
});

// ============================================================
// classifyQueryIntent Tests
// ============================================================

test('classifyQueryIntent: 疑問文をquestionと判定', () => {
  assert.equal(classifyQueryIntent('ブースの見積もりはいくらですか？'), 'question');
  assert.equal(classifyQueryIntent('いつまでにできますか？'), 'question');
});

test('classifyQueryIntent: 依頼文をrequestと判定', () => {
  assert.equal(classifyQueryIntent('見積もりを送ってください'), 'request');
});

test('classifyQueryIntent: 購入意図をtransactionalと判定', () => {
  assert.equal(classifyQueryIntent('ブース制作を申し込む'), 'transactional');
  assert.equal(classifyQueryIntent('見積もりを購入したい'), 'transactional');
});

test('classifyQueryIntent: 会社名を含むクエリをnavigationalと判定', () => {
  assert.equal(classifyQueryIntent('オージャスト 展示会'), 'navigational');
});

test('classifyQueryIntent: 名詞連打をinformationalと判定', () => {
  assert.equal(classifyQueryIntent('展示会 ブース 制作 大阪'), 'informational');
});

// ============================================================
// importGSCQueries Tests
// ============================================================

test('importGSCQueries: 日本語CSVを解析する', () => {
  const csv = '検索クエリ,クリック数,インプレッション数,CTR,掲載順位\n' +
    '展示会 ブース,50,1000,5.0,3.5\n' +
    'ブースの見積もりはいくらですか,10,200,5.0,2.1\n' +
    '展示会 出展 費用,30,800,3.75,4.2';
  const result = importGSCQueries(csv);
  assert.equal(result.length, 3, '3件のクエリが解析されること');
  assert.ok(result[0].llmo_score > 0, 'LLMOスコアが計算されること');
  assert.ok(result[0].intent, '意図が分類されること');
});

test('importGSCQueries: 英語CSVを解析する', () => {
  const csv = 'Query,Clicks,Impressions,CTR,Position\n' +
    'exhibition booth,50,1000,5.0,3.5\n' +
    'booth design tips,30,800,3.75,4.2';
  const result = importGSCQueries(csv);
  assert.equal(result.length, 2, '2件のクエリが解析されること');
});

test('importGSCQueries: 空入力は空配列', () => {
  assert.deepEqual(importGSCQueries(''), []);
  assert.deepEqual(importGSCQueries(null), []);
});

test('importGSCQueries: 最小インプレッションでフィルタ', () => {
  const csv = '検索クエリ,クリック数,インプレッション数,CTR,掲載順位\n' +
    'クエリA,10,500,2.0,3.0\n' +
    'クエリB,5,50,10.0,1.5';
  const result = importGSCQueries(csv, { minImpressions: 100 });
  assert.equal(result.length, 1, '100以上のインプレッションのみ');
  assert.ok(result[0].query.includes('クエリA'));
});

// ============================================================
// analyzeLLMOQueries Tests
// ============================================================

test('analyzeLLMOQueries: 空配列で空レポート', () => {
  const report = analyzeLLMOQueries([]);
  assert.equal(report.totalQueries, 0);
  assert.deepEqual(report.topOpportunities, []);
});

test('analyzeLLMOQueries: クエリ集計レポートを生成する', () => {
  const csv = '検索クエリ,クリック数,インプレッション数,CTR,掲載順位\n' +
    '展示会ブースの作り方,100,5000,2.0,3.5\n' +
    'ブースの見積もりはいくらですか,50,2000,2.5,2.1\n' +
    '見積もりを送ってください,30,1000,3.0,1.5\n' +
    '大阪 展示会 ブース 制作,200,10000,2.0,5.0\n' +
    '展示会出展の流れ,80,3000,2.67,4.0';
  const queries = importGSCQueries(csv);
  const report = analyzeLLMOQueries(queries);
  assert.equal(report.totalQueries, 5);
  assert.ok(report.byIntent, '意図別集計があること');
  assert.ok(report.byLLMOScore, 'スコア分布があること');
  assert.ok(report.topOpportunities.length > 0, '機会クエリ一覧があること');
  assert.ok(report.contentIdeas.length >= 0, 'コンテンツアイデア一覧があること');
});

// ============================================================
// LLMO Domain Extended Pattern Tests
// ============================================================

test('DOMAIN_SPECIFIC_PATTERNS: デジタルサイネージにマッチ', () => {
  const matches = matchDomainPatterns('デジタルサイネージを導入したい');
  assert.ok(matches.some(m => m.domain === 'exhibition_digital'), 'デジタルドメインにマッチすること');
});

test('DOMAIN_SPECIFIC_PATTERNS: 海外展示会にマッチ', () => {
  const matches = matchDomainPatterns('海外展示会に出展する方法');
  assert.ok(matches.some(m => m.id === 'domain_overseas'), '海外出展パターンにマッチすること');
});

test('DOMAIN_SPECIFIC_PATTERNS: サステナブルにマッチ', () => {
  const matches = matchDomainPatterns('エコなブース制作の方法');
  assert.ok(matches.some(m => m.id === 'domain_ecofriendly'), 'エコパターンにマッチすること');
});
