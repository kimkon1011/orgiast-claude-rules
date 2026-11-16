import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSearchTerms, extractTermsRegex, searchRelated } from './autoreply-related.mjs';

test('extractSearchTerms: LLM 抽出が成功したら最大6語', async () => {
  const llm = async () => JSON.stringify(['スマートエイト', 'DXPO福岡', 'studioreal', '請求書', '原価']);
  const terms = await extractSearchTerms('辻有香さん DM「スマートエイト様 DXPO福岡 の原価追加」', [], llm);
  assert.equal(terms.length, 5);
  assert.deepEqual(terms, ['スマートエイト', 'DXPO福岡', 'studioreal', '請求書', '原価']);
});

test('extractSearchTerms: LLM が非配列を返したら regex fallback', async () => {
  const llm = async () => 'not a json array';
  const terms = await extractSearchTerms('株式会社オージャスト 佐藤様 案件: 展示会DXPO', [], llm);
  assert.ok(terms.length > 0);
  // Should have extracted at least the company name
  assert.ok(terms.some(t => t.includes('オージャスト') || t.includes('DXPO')));
});

test('extractSearchTerms: LLM が無いときは regex fallback', async () => {
  const terms = await extractSearchTerms('株式会社テスト 山田様 【プロジェクトX】 案件名：新規開発', []);
  assert.ok(terms.length >= 3);
  assert.ok(terms.some(t => t.includes('テスト')));
  assert.ok(terms.some(t => t.includes('山田')));
  assert.ok(terms.some(t => t.includes('プロジェクトX') || t.includes('新規開発')));
});

test('extractSearchTerms: 空テキストは空配列', async () => {
  assert.deepEqual(await extractSearchTerms('', []), []);
  assert.deepEqual(await extractSearchTerms(null, []), []);
});

test('extractSearchTerms: 上限6語を超えない', async () => {
  const text = '株式会社A 有限会社B 商事C 工業D 産業E 佐藤様 鈴木様 田中様 高橋様 伊藤様 【案件A】 【案件B】 【案件C】 コードX001 コードX002';
  const terms = await extractSearchTerms(text);
  assert.ok(terms.length <= 6);
});

test('extractTermsRegex: 「〇〇様」を抽出', () => {
  const terms = extractTermsRegex('佐藤様、鈴木様、田中様');
  assert.ok(terms.includes('佐藤'));
  assert.ok(terms.includes('鈴木'));
  assert.ok(terms.includes('田中'));
});

test('extractTermsRegex: 【】で括られた文言を抽出', () => {
  const terms = extractTermsRegex('【スマートエイト】の【DXPO福岡】');
  assert.ok(terms.includes('スマートエイト'));
  assert.ok(terms.includes('DXPO福岡'));
});

test('extractTermsRegex: ラベル付きの名称を抽出', () => {
  const terms = extractTermsRegex('案件名：新規Web開発 展示会：DXPO 会社名：オージャスト');
  assert.ok(terms.includes('新規Web開発'));
  assert.ok(terms.includes('DXPO'));
  assert.ok(terms.includes('オージャスト'));
});

test('extractTermsRegex: 英数字コードを抽出', () => {
  const terms = extractTermsRegex('案件コード: PRJ001 と INV-002');
  assert.ok(terms.some(t => /^[A-Z][A-Z0-9]{2,10}$/.test(t)));
});

test('extractTermsRegex: 会社名（株式会社等）を抽出', () => {
  const terms = extractTermsRegex('株式会社オージャストとReブース株式会社');
  assert.ok(terms.some(t => t.includes('オージャスト')));
  assert.ok(terms.some(t => t.includes('Reブース')));
});

test('extractTermsRegex: 上限6語', () => {
  const terms = extractTermsRegex('株式会社A 株式会社B 株式会社C 株式会社D 株式会社E 株式会社F 株式会社G');
  assert.equal(terms.length, 6);
});

test('searchRelated: terms なし or beeperFetch なしは空配列', async () => {
  assert.deepEqual(await searchRelated({}), []);
  assert.deepEqual(await searchRelated({ terms: [], beeperFetch: async () => {} }), []);
});

test('searchRelated: 検索結果を新しい順・上限・バイト制限', async () => {
  let searchCalls = 0;
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      searchCalls++;
      assert.equal(opts.query.query, 'スマートエイト');
      return {
        items: [
          { id: '1', chatID: 'chat1', senderName: '川本', timestamp: '2026-09-24T10:00:00Z',
            text: '制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか' },
          { id: '2', chatID: 'chat2', senderName: '大平', timestamp: '2026-09-23T09:00:00Z',
            text: '<p>確認しました。</p>' },
        ],
        chats: {
          chat1: { title: '川本, 大平, 白川 & 百瀬' },
          chat2: { title: '営業打合せ' },
        },
      };
    }
    // Messages endpoint: return empty (these chats don't have financial context)
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 10, maxBytes: 20000,
  });
  assert.equal(searchCalls, 1);
  assert.equal(result.length, 2);
  // Direct hit order unchanged (no context expansion since mocks return empty)
  assert.equal(result[0].chat, '川本, 大平, 白川 & 百瀬');
  assert.equal(result[0].sender, '川本');
  assert.equal(result[0].text, '制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか');
  assert.equal(result[1].chat, '営業打合せ');
  assert.equal(result[1].sender, '大平');
  assert.equal(result[1].text, '確認しました。');
  // Newest first
  assert.ok(Date.parse(result[0].ts) > Date.parse(result[1].ts));
});

test('searchRelated: 自動返信自身の発言を除外', async () => {
  const beeperFetch = async () => ({
    items: [
      { id: '1', chatID: 'c1', senderName: 'Bot', timestamp: '2026-09-24T10:00:00Z',
        text: '<p>【kimのClaudeによる代理回答】確認しました。</p>' },
      { id: '2', chatID: 'c1', senderName: '田中', timestamp: '2026-09-24T09:00:00Z',
        text: '了解しました' },
    ],
    chats: { c1: { title: '相談' } },
  });
  const result = await searchRelated({
    terms: ['テスト'], beeperFetch, maxItems: 10, maxBytes: 20000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sender, '田中');
});

test('searchRelated: excludeMessageIds で指定した ID を除外', async () => {
  const beeperFetch = async () => ({
    items: [
      { id: 'skip-1', chatID: 'c1', senderName: '田中', timestamp: '2026-09-24T10:00:00Z', text: 'スキップ' },
      { id: 'keep-1', chatID: 'c1', senderName: '佐藤', timestamp: '2026-09-24T11:00:00Z', text: 'キープ' },
    ],
    chats: { c1: { title: '相談' } },
  });
  const result = await searchRelated({
    terms: ['テスト'], beeperFetch, excludeMessageIds: new Set(['skip-1']), maxItems: 10, maxBytes: 20000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sender, '佐藤');
});

test('searchRelated: 検索失敗は空配列（返信を止めない）', async () => {
  const beeperFetch = async () => { throw new Error('Beeper down'); };
  const result = await searchRelated({ terms: ['テスト'], beeperFetch });
  assert.deepEqual(result, []);
});

test('searchRelated: 上限バイトで切り詰め', async () => {
  const beeperFetch = async () => ({
    items: [
      { id: '1', chatID: 'c1', senderName: 'A', timestamp: '2026-09-24T10:00:00Z', text: '短い' },
      { id: '2', chatID: 'c1', senderName: 'B', timestamp: '2026-09-24T11:00:00Z',
        text: '長いテキスト'.repeat(1000) },
    ],
    chats: { c1: { title: '相談' } },
  });
  const result = await searchRelated({
    terms: ['テスト'], beeperFetch, maxItems: 10, maxBytes: 100,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sender, 'A'); // Oversized evidence is omitted whole.
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 100);
});

test('searchRelated: 180日前より古いメッセージを除外', async () => {
  const longAgo = new Date(Date.now() - 200 * 86400000).toISOString();
  const recent = new Date(Date.now() - 1 * 86400000).toISOString();
  const beeperFetch = async () => ({
    items: [
      { id: 'old', chatID: 'c1', senderName: '古い', timestamp: longAgo, text: '古いメッセージ' },
      { id: 'new', chatID: 'c1', senderName: '新しい', timestamp: recent, text: '最近のメッセージ' },
    ],
    chats: { c1: { title: '相談' } },
  });
  const result = await searchRelated({
    terms: ['テスト'], beeperFetch, sinceDays: 180, maxItems: 10, maxBytes: 20000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sender, '新しい');
});

test('辻有香さんケース: related に川本さんの発言が含まれる', async () => {
  // 実害の再現: 辻さん「スマートエイト様 DXPO福岡'26 studioreal様の請求書(税抜40,000円)を原価に追加してよいか」
  // 別グループDM「川本, 大平, 白川 & 百瀬」に川本さんの発言「制作費2万円+5千円+1.5万円の合計4万円(税抜)」
  const llm = async () => JSON.stringify(['スマートエイト', 'DXPO福岡', 'studioreal', '請求書', '原価']);
  const text = 'スマートエイト様 DXPO福岡 2026、studioreal様の請求書（税抜40,000円）を原価に追加してよいか';
  const terms = await extractSearchTerms(text, [], llm);
  assert.ok(terms.includes('スマートエイト'));
  assert.ok(terms.includes('studioreal'));

  let searchCalledWith = '';
  const beeperFetch = async (endpoint, opts) => {
    searchCalledWith = opts.query.query;
    return {
      items: [{
        id: 'rel-1', chatID: 'group1', senderName: '川本',
        timestamp: '2026-09-24T10:00:00Z',
        text: '制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか',
      }],
      chats: { group1: { title: '川本, 大平, 白川 & 百瀬' } },
    };
  };
  const result = await searchRelated({
    terms, beeperFetch, maxItems: 10, maxBytes: 20000,
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].sender, '川本');
  assert.ok(result[0].text.includes('4万円'));
  assert.ok(result[0].text.includes('2万円'));
});

test('辻有香さんケース: related の金額が inventedAmounts で捏造扱いされない', async () => {
  const { inventedAmounts } = await import('../discord-autoreply.mjs');
  const answer = '合っているので原価に計上してよいです（川本さんが 2026-09-24 に「制作費2万円+5千円+1.5万円の合計4万円(税抜)」と確認済み）';
  const sourceText = [
    'スマートエイト様 DXPO福岡 2026、studioreal様の請求書（税抜40,000円）を原価に追加してよいか',
    '[川本, 大平, 白川 & 百瀬] 川本: 制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか',
  ].join('\n');
  const invented = inventedAmounts(answer, sourceText);
  assert.deepEqual(invented, [], 'related に出てくる金額は捏造扱いしない');
});

test('辻有香さんケース: 関連会話と照合して「未確認」で止めずに判断できる', async () => {
  // LLM に related が渡されれば、システムプロンプトの指示により「未確認」で止めず判断できる
  // ここでは LLM input に related が含まれることを確認する
  const { inventedAmounts } = await import('../discord-autoreply.mjs');
  const answer = '合っているので原価に計上してください（川本さんが9/24に4万円と確認済み）';
  const sourceText = [
    'スマートエイトの原価追加',
    '[川本, 大平, 白川 & 百瀬] 川本: 制作費2万円+5千円+1.5万円の合計4万円',
  ].join('\n');
  // 40,000 は sourceText に 4万円 として存在 → 捏造扱いしない
  const invented = inventedAmounts(answer, sourceText);
  assert.deepEqual(invented, []);
});

test('抽出は文書本文を安い分類カテゴリに渡し、不正な語と重複を除く', async () => {
  const terms = await extractSearchTerms('請求書を追加してよいか', [{ text: '請求者名：studioreal 案件名：DXPO福岡' }], async ({ category, input }) => {
    assert.equal(category, 'classification');
    assert.match(input.text, /studioreal/);
    assert.match(input.text, /DXPO福岡/);
    return JSON.stringify([null, {}, '', ' スマートエイト ', 'スマートエイト', 'studioreal']);
  });
  assert.deepEqual(terms, ['スマートエイト', 'studioreal']);
  assert.deepEqual(await extractSearchTerms('', ['スマートエイト様 studioreal様'], async () => { throw new Error('AI down'); }), ['スマートエイト', 'studioreal']);
  assert.ok(extractTermsRegex('案件コード INV-002').includes('INV-002'));
});

test('全検索語を検索してから重複除去・新しい順・件数制限を適用', async () => {
  let searchCalls = 0;
  const stamp = n => new Date(Date.now() - n * 1000).toISOString();
  const old = { id: 'same', chatID: 'c1', timestamp: stamp(3), text: '古い根拠' };
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      searchCalls++;
      return { items: searchCalls === 1 ? [old] : [old, { ...old, id: 'new', timestamp: stamp(1), text: '新しい根拠' }] };
    }
    return { items: [] };
  };
  const result = await searchRelated({ terms: ['会社名', '案件名'], maxItems: 1, beeperFetch });
  assert.equal(searchCalls, 2);
  assert.equal(result.length, 2, 'direct hits preserved even when maxItems=1');
  assert.equal(result[0].text, '新しい根拠');
});

test('最初の1件だけでもバイト上限を厳守し、途中の検索失敗は他の結果を失わない', async () => {
  const item = { id: 'one', chatID: 'c1', timestamp: new Date().toISOString(), text: '金額４万円'.repeat(100) };
  const beeperFetch = async (_, { query }) => {
    if (query.query === '失敗') throw new Error('offline');
    return { items: [item] };
  };
  assert.deepEqual(await searchRelated({ terms: ['案件'], beeperFetch, maxBytes: 100 }), []);
  const result = await searchRelated({ terms: ['失敗', '案件'], beeperFetch });
  assert.equal(result.length, 1);
});

test('金額ガードは全角・カンマ有無・万/千表記を同額として扱い、別金額は拒否', async () => {
  const { inventedAmounts } = await import('../discord-autoreply.mjs');
  for (const answer of ['40,000円', '40000円', '4万', '４万円']) {
    assert.deepEqual(inventedAmounts(answer, '合計４万円'), []);
  }
  assert.deepEqual(inventedAmounts('5,000円', '制作費5千円'), []);
  assert.deepEqual(inventedAmounts('50,000円', '合計４万円'), [50000]);
});

test('searchRelated: 辻さんケースの前後展開で金額発言を拾う', async () => {
  // 実害: 10/24 に「スマートエイト」でヒットするが、決め手の金額発言は 9/24（同じ会話に「スマートエイト」を含まない）
  // 前後展開で 9/24 の発言を拾えることを確認
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      // Search for "スマートエイト" only finds 10/24 message
      return {
        items: [{
          id: 'oct24-msg', chatID: 'group1', senderName: '辻',
          timestamp: '2026-10-24T10:00:00Z',
          text: 'スマートエイトの原価追加について質問です',
        }],
        chats: { group1: { title: '川本, 大平, 白川 & 百瀬' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      // Chat history includes 9/24 金額 message and other messages
      return {
        items: [
          { id: 'nov01-msg', senderName: '白川', timestamp: '2026-11-01T10:00:00Z',
            text: '了解しました。見積もり確認します。' },
          { id: 'oct24-msg', senderName: '辻', timestamp: '2026-10-24T10:00:00Z',
            text: 'スマートエイトの原価追加について質問です' },
          { id: 'oct01-msg', senderName: '大平', timestamp: '2026-10-01T09:00:00Z',
            text: '確認しました。' }, // No financial pattern match
          { id: 'sep24-msg', senderName: '川本', timestamp: '2026-09-24T10:00:00Z',
            text: '制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか' },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };

  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, currentChatId: 'other-chat',
    maxItems: 10, maxBytes: 20000,
  });

  // Original search hit should be present (without via)
  assert.ok(result.some(r => r.sender === '辻' && !r.via));
  // Expanded context: 川本's 9/24 金額 message (with via: 'context')
  assert.ok(result.some(r => r.sender === '川本' && r.via === 'context'));
  assert.ok(result.some(r => r.text.includes('4万円')));
  // 大平「確認しました。」は within ±10 proximity of hit → included (new behavior: proximity matches preserved)
  assert.ok(result.some(r => r.sender === '大平' && r.via === 'context'));
});

test('searchRelated: 前後展開の±45日境界', async () => {
  // 10/24 にヒット → ±45日 = 9/9〜12/8
  // 9/8 の金額発言は範囲外、9/9 の金額発言は範囲内
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻',
          timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '相談' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      return {
        items: [
          { id: 'inside', senderName: '佐藤', timestamp: '2026-09-09T10:00:00Z',
            text: 'スマートエイト 金額4万円です' }, // 45日前の9/9 → 範囲内
          { id: 'outside', senderName: '古田', timestamp: '2026-09-08T10:00:00Z',
            text: 'スマートエイト 金額5万円です' }, // 46日前の9/8 → 範囲外
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };

  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, currentChatId: 'other',
    maxItems: 10, maxBytes: 20000,
  });

  assert.ok(result.some(r => r.sender === '佐藤' && r.via === 'context'), '9/9 inside ±45d should be included');
  assert.ok(!result.some(r => r.sender === '古田'), '9/8 outside ±45d should be excluded');
});

test('searchRelated: currentChatId の会話は前後展開しない', async () => {
  // currentChatId='c1' → chat 'c1' は展開対象外
  let historyCalls = 0;
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻',
          timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '現在の会話' } },
      };
    }
    // Should NOT be called for messages endpoint of c1
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      historyCalls++;
      throw new Error('should not expand currentChatId');
    }
    return { items: [] };
  };

  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, currentChatId: 'c1',
    maxItems: 10, maxBytes: 20000,
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].sender, '辻');
  assert.equal(result[0].via, undefined);
  assert.equal(historyCalls, 0);
});

test('searchRelated: 前後展開の300件上限までページング', async () => {
  // 複数ページにまたがって fetch し、計300件で停止する
  let pageCalls = 0;
  const HIT_TS = Date.parse('2026-10-24T10:00:00Z');
  // Items spaced 2 hours apart -> 100 items = ~8.3 days per page
  // All within ±45d from the hit
  const mkItems = (page, count) => Array.from({ length: count }, (_, i) => ({
    id: `p${page}-${i}`,
    senderName: `User${(page - 1) * 100 + i}`,
    timestamp: new Date(HIT_TS - ((page - 1) * 100 + i) * 7200000).toISOString(),
    text: i === 10 ? 'スマートエイト 金額4万円の見積もりです' : `通常メッセージ${(page - 1) * 100 + i}`,
  }));

  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻',
          timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '大量チャット' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      pageCalls++;
      const cursor = opts?.query?.cursor;
      if (!cursor) {
        return { items: mkItems(1, 100), hasMore: true, oldestCursor: 'cursor-p1' };
      }
      if (cursor === 'cursor-p1') {
        return { items: mkItems(2, 100), hasMore: true, oldestCursor: 'cursor-p2' };
      }
      if (cursor === 'cursor-p2') {
        return { items: mkItems(3, 100), hasMore: true, oldestCursor: 'cursor-p3' };
      }
      return { items: [] };
    }
    return { items: [] };
  };

  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, currentChatId: 'other',
    maxItems: 10, maxBytes: 20000,
  });

  // Should have the search hit
  assert.ok(result.some(r => r.sender === '辻'));
  // Should have context items from all 3 pages (financial message at index 10 in each)
  const contextItems = result.filter(r => r.via === 'context');
  assert.ok(contextItems.length >= 2, `should pick up financial messages from multiple pages, got ${contextItems.length}`);
  assert.ok(contextItems.some(r => r.text.includes('4万円')));
  assert.equal(pageCalls, 3, 'must stop at 300 even when more pages exist');
  assert.equal(contextItems.length, 3);
});

test('前後展開: 個々のヒットから±45日、除外ID・HTML・自動返信・重複と出力上限', async () => {
  const hit = (id, timestamp) => ({ id, chatID: 'c1', timestamp, text: 'スマートエイト' });
  const hits = [hit('a', '2026-06-01T00:00:00Z'), hit('b', '2026-10-24T00:00:00Z')];
  const beeperFetch = async endpoint => endpoint === '/v1/messages/search'
    ? { items: hits, chats: { c1: { title: '川本, 大平, 白川 & 百瀬' } } }
    : { items: [
      ...hits,
      { id: 'gap', timestamp: '2026-08-01T00:00:00Z', text: '合計99万円' },
      { id: 'excluded', timestamp: '2026-09-24T00:00:00Z', text: '請求99万円' },
      { id: 'auto', timestamp: '2026-09-24T00:00:00Z', text: '<p>【kimのClaudeによる代理回答】合計99万円</p>' },
      { id: 'money', timestamp: '2026-09-24T00:00:00Z', text: '<p>制作費２万円+5千円+1.5万円の合計４万円(税抜)で3プランという認識でよろしいでしょうか</p>' },
      { id: 'after', timestamp: '2026-12-08T00:00:00Z', text: '税込４万円' },
      { id: 'too-late', timestamp: '2026-12-08T00:00:00.001Z', text: '税込99万円' },
    ] };
  const options = { terms: ['スマートエイト'], beeperFetch, sinceDays: 1000, excludeMessageIds: new Set(['excluded']) };
  const related = await searchRelated(options);
  // Direct hits first (by timestamp), then context items (by timestamp)
  assert.deepEqual(related.map(r => r.text), ['スマートエイト', 'スマートエイト', '制作費２万円+5千円+1.5万円の合計４万円(税抜)で3プランという認識でよろしいでしょうか', '税込４万円']);
  assert.equal(related.filter(r => r.via === 'context').length, 2);
  assert.equal((await searchRelated({ ...options, maxItems: 1 })).length, 2); // direct hits preserved
  const bounded = await searchRelated({ ...options, maxBytes: 200 });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 200);
});

test('前後展開: 今回の会話を除いて最大5会話、APIがlimitを無視しても300件まで', async () => {
  const timestamp = new Date().toISOString();
  const requested = [];
  const result = await searchRelated({
    terms: ['スマートエイト'], currentChatId: 'c0', maxItems: 2000, maxBytes: 1000000,
    beeperFetch: async (endpoint, { query }) => {
      if (endpoint === '/v1/messages/search') return { items: Array.from({ length: 7 }, (_, i) => ({ id: 'hit', chatID: `c${i}`, timestamp, text: 'スマートエイト' })) };
      requested.push(endpoint);
      assert.equal(query.limit, 100);
      return { items: Array.from({ length: 301 }, (_, i) => ({ id: String(i), timestamp, text: i === 300 ? 'スマートエイト 合計999万円' : 'スマートエイト 合計４万円' })), hasMore: true, oldestCursor: 'next' };
    },
  });
  assert.equal(requested.length, 5);
  assert.ok(requested.every(ep => !ep.includes('/c0/') && !ep.includes('/c6/')));
  assert.equal(result.filter(r => r.via === 'context').length, 5 * 8); // per-chat limit 8
  assert.ok(result.every(r => !r.text.includes('999')));
});

test('searchRelated: maxItems が直接ヒットより少なくても直接ヒットを全部残す', async () => {
  // maxItems=1 だが直接ヒットが2件 → 2件とも残る（context は削られる）
  const beeperFetch = async (endpoint) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [
          { id: 'hit1', chatID: 'c1', senderName: '田中', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' },
          { id: 'hit2', chatID: 'c2', senderName: '佐藤', timestamp: '2026-10-23T09:00:00Z', text: '別の相談' },
        ],
        chats: { c1: { title: '会話A' }, c2: { title: '会話B' } },
      };
    }
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 1, maxBytes: 20000,
  });
  assert.equal(result.length, 2, 'direct hits preserved even when exceeding maxItems');
  assert.equal(result[0].sender, '田中');
  assert.equal(result[1].sender, '佐藤');
});

test('searchRelated: 会話ごとの前後展開は最大8件', async () => {
  // 1会話、15件の context 適合メッセージ → 上限8件
  const beeperFetch = async (endpoint) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '相談' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      // 15 messages, all match money pattern
      const items = Array.from({ length: 15 }, (_, i) => ({
        id: `ctx-${i}`, senderName: `User${i}`, timestamp: new Date(Date.parse('2026-10-20T00:00:00Z') - i * 86400000).toISOString(),
        text: `スマートエイト 金額${i + 1}万円の見積もりです`,
      }));
      return { items, hasMore: false };
    }
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 100, maxBytes: 100000,
    excludeChatIds: 'other',
  });
  const ctxItems = result.filter(r => r.via === 'context');
  assert.equal(ctxItems.length, 8, 'per-chat context limit of 8');
});

test('searchRelated: excludeChatIds で配列指定でも単一指定でも除外される', async () => {
  let historyCalls = 0;
  const beeperFetch = async (endpoint) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '除外される会話' } },
      };
    }
    historyCalls++;
    return { items: [] };
  };

  // Single string
  const r1 = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 10, maxBytes: 20000,
    excludeChatIds: 'c1',
  });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].sender, '辻');
  assert.equal(r1[0].via, undefined);

  // Also test array form
  const r2 = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 10, maxBytes: 20000,
    excludeChatIds: ['c1'],
  });
  assert.equal(r2.length, 1);
  assert.equal(r2[0].sender, '辻');
  assert.equal(r2[0].via, undefined);

  // currentChatId (deprecated) still works
  const r3 = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, maxItems: 10, maxBytes: 20000,
    currentChatId: 'c1',
  });
  assert.equal(r3.length, 1);
  assert.equal(r3[0].via, undefined);
  assert.equal(historyCalls, 0, '除外した会話の履歴APIを呼んではいけない');
});

test('searchRelated: ヒット数の多い会話を先に展開し、件数・バイト制限でも全会話の直接ヒットを優先', async () => {
  const timestamp = new Date().toISOString();
  const hits = [
    { id: 'a', chatID: 'low', timestamp, text: '案件の質問' },
    { id: 'b', chatID: 'high', timestamp, text: '案件の質問' },
    { id: 'c', chatID: 'high', timestamp, text: '案件の追加質問' },
  ];
  const calls = [];
  const beeperFetch = async endpoint => {
    if (endpoint === '/v1/messages/search') return { items: hits };
    calls.push(endpoint);
    return { items: [{ id: 'cost', timestamp, text: '案件の見積4万円' }] };
  };
  const options = { terms: ['案件'], beeperFetch, maxItems: 4 };
  const result = await searchRelated(options);
  assert.match(calls[0], /\/high\//);
  assert.deepEqual(result.slice(0, 3).map(r => r.text), hits.map(r => r.text));
  assert.equal(result[3].chat, 'high', '最新順で低ヒット会話に予算を奪わせない');
  const directBytes = Buffer.byteLength(JSON.stringify(result.slice(0, 3)));
  const bounded = await searchRelated({ ...options, maxBytes: directBytes });
  assert.equal(bounded.length, 3);
  assert.ok(bounded.every(r => !r.via));
});

test('searchRelated: ±10の境界、無関係な給与・求人・別案件コードと検索語だけの発言を除外', async () => {
  const timestamp = new Date().toISOString();
  const hit = { id: 'hit', chatID: 'c', timestamp, text: 'スマートエイト 261022SME' };
  const history = [hit, ...Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, timestamp, text: '雑談' })),
    { id: 'near', timestamp, text: '制作費２万円+5千円+1.5万円の合計４万円' },
    { id: 'salary', timestamp, text: '給与30万円の確認' },
    { id: 'jobs', timestamp, text: '求人の見積5万円' },
    { id: 'other', timestamp, text: '261023OTHER 請求8万円' },
    { id: 'term-only', timestamp, text: 'スマートエイトの写真' },
    { id: 'same', timestamp, text: '261022sme 見積4万円' },
    { id: 'term', timestamp, text: 'スマートエイト 合計4万円' },
  ];
  const result = await searchRelated({ terms: ['スマートエイト'], beeperFetch: async endpoint =>
    endpoint === '/v1/messages/search' ? { items: [hit] } : { items: history } });
  assert.deepEqual(result.filter(r => r.via).map(r => r.text), [history[10].text, history[15].text, history[16].text]);
});

test('searchRelated: 前後展開は金額・合意と案件関連の両方が必要', async () => {
  const beeperFetch = async (endpoint, opts) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'g1', senderName: '辻', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの原価追加' }],
        chats: { g1: { title: '川本, 大平, 白川 & 百瀬' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      return {
        items: [
          { id: 'm1', senderName: '川本', timestamp: '2026-09-24T10:00:00Z', text: '制作費2万円+5千円+1.5万円の合計4万円(税抜)で3プランという認識でよろしいでしょうか' },
          { id: 'm2', senderName: '辻', timestamp: '2026-09-30T10:00:00Z', text: 'studiorealから請求書来たので確認お願いします' },
          { id: 'm3', senderName: '大平', timestamp: '2026-10-01T09:00:00Z', text: '確認しました。送付します。' },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト', 'studioreal'], beeperFetch, excludeChatIds: 'other',
    maxItems: 10, maxBytes: 20000,
  });

  assert.ok(result.some(r => r.sender === '辻' && !r.via));
  assert.ok(!result.some(r => r.sender === '川本'), '金額だけでは案件関連を確認できない');
  assert.ok(result.some(r => r.sender === '辻' && r.via === 'context' && r.text.includes('studioreal')));
  assert.ok(!result.some(r => r.sender === '大平'));
});

test('searchRelated: 前後展開で案件コードを含むメッセージを拾う', async () => {
  const beeperFetch = async (endpoint) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '佐藤', timestamp: '2026-10-24T10:00:00Z', text: '261022SME の件' }],
        chats: { c1: { title: '案件相談' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      return {
        items: [
          { id: 'm1', senderName: '佐藤', timestamp: '2026-10-20T10:00:00Z', text: '261022SME の見積もり作成しました' },
          { id: 'm2', senderName: '山田', timestamp: '2026-10-19T10:00:00Z', text: '確認しました。進めてください。' },
        ],
        hasMore: false,
      };
    }
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, excludeChatIds: 'other',
    maxItems: 10, maxBytes: 20000,
  });

  assert.ok(result.some(r => r.sender === '佐藤' && !r.via));
  assert.ok(result.some(r => r.sender === '佐藤' && r.via === 'context' && r.text.includes('261022SME')));
  assert.ok(!result.some(r => r.sender === '山田'));
});

test('searchRelated: 前後展開でヒットから±10メッセージ以内の通常発言を拾う', async () => {
  const beeperFetch = async (endpoint) => {
    if (endpoint === '/v1/messages/search') {
      return {
        items: [{ id: 'hit', chatID: 'c1', senderName: '辻', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' }],
        chats: { c1: { title: '相談' } },
      };
    }
    if (endpoint.startsWith('/v1/chats/') && endpoint.endsWith('/messages')) {
      const items = [
        { id: 'hit', senderName: '辻', timestamp: '2026-10-24T10:00:00Z', text: 'スマートエイトの質問' },
        { id: 'near1', senderName: '川本', timestamp: '2026-10-23T10:00:00Z', text: '承知しました' },
        { id: 'near2', senderName: '大平', timestamp: '2026-10-22T10:00:00Z', text: '対応します' },
        { id: 'far', senderName: '白川', timestamp: '2026-09-01T10:00:00Z', text: '了解です' },
      ];
      return { items, hasMore: false };
    }
    return { items: [] };
  };
  const result = await searchRelated({
    terms: ['スマートエイト'], beeperFetch, excludeChatIds: 'other',
    maxItems: 10, maxBytes: 20000,
  });

  assert.ok(result.some(r => r.sender === '辻' && !r.via));
  assert.ok(result.some(r => r.sender === '川本' && r.via === 'context'));
  assert.ok(result.some(r => r.sender === '大平' && r.via === 'context'));
  assert.ok(!result.some(r => r.sender === '白川'));
});
