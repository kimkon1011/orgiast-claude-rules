import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAiSource, fmtMonth, sortMonthsDesc, calcDateRange, renderMarkdown } from './ai-referral-report.mjs';

// --- isAiSource ----------------------------------------------------------------

test('isAiSource: chatgpt.com を AI と判定する', () => {
  assert.equal(isAiSource('chatgpt.com'), true);
});

test('isAiSource: perplexity.ai を AI と判定する', () => {
  assert.equal(isAiSource('perplexity.ai'), true);
});

test('isAiSource: google を AI と判定しない（検索エンジン）', () => {
  assert.equal(isAiSource('google'), false);
});

test('isAiSource: 大文字小文字を区別しない', () => {
  assert.equal(isAiSource('ChatGPT.Com'), true);
  assert.equal(isAiSource('PERPLEXITY'), true);
});

test('isAiSource: 主要 AI ソースを網羅する', () => {
  const aiSources = [
    'chatgpt.com',
    'chat.openai.com',
    'openai',
    'perplexity',
    'gemini.google.com',
    'bard.google.com',
    'copilot.microsoft.com',
    'claude.ai',
    'anthropic',
    'you.com',
    'phind',
    'poe.com',
    'grok.com',
    'x.ai',
    'deepseek',
    'felo',
    'genspark',
    'manus',
  ];
  for (const src of aiSources) {
    assert.equal(isAiSource(src), true, `${src} should be AI`);
  }
});

test('isAiSource: 非 AI ソースを正しく除外する', () => {
  const nonAiSources = [
    'google',
    'bing',
    'yahoo',
    'duckduckgo',
    'ecosia',
    'baidu',
    'yandex',
    'direct',
    '(direct)',
    'm.facebook.com',
    't.co',
    'instagram.com',
  ];
  for (const src of nonAiSources) {
    assert.equal(isAiSource(src), false, `${src} should NOT be AI`);
  }
});

// --- fmtMonth ------------------------------------------------------------------

test('fmtMonth: 202611 → 2026年11月', () => {
  assert.equal(fmtMonth('202611'), '2026年11月');
});

test('fmtMonth: 202501 → 2025年1月（ゼロパディング除去）', () => {
  assert.equal(fmtMonth('202501'), '2025年1月');
});

test('fmtMonth: 202512 → 2025年12月', () => {
  assert.equal(fmtMonth('202512'), '2025年12月');
});

// --- sortMonthsDesc -----------------------------------------------------------

test('sortMonthsDesc: 降順に並べる', () => {
  assert.deepEqual(sortMonthsDesc(['202601', '202612', '202502', '202611']), [
    '202612',
    '202611',
    '202601',
    '202502',
  ]);
});

test('sortMonthsDesc: 元配列を破壊しない', () => {
  const src = ['202611', '202610'];
  const out = sortMonthsDesc(src);
  assert.deepEqual(out, ['202611', '202610']);
  assert.deepEqual(src, ['202611', '202610']);
});

// --- calcDateRange ------------------------------------------------------------

test('calcDateRange: months=1 は当月1日～今日', () => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const r = calcDateRange(1);
  assert.equal(r.startDate, `${y}-${m}-01`);
  assert.equal(r.endDate, `${y}-${m}-${d}`);
});

test('calcDateRange: months=13 は約1年前の月初から', () => {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 12, 1);
  const sy = start.getFullYear();
  const sm = String(start.getMonth() + 1).padStart(2, '0');
  const r = calcDateRange(13);
  assert.equal(r.startDate, `${sy}-${sm}-01`);
});

// --- renderMarkdown -----------------------------------------------------------

test('renderMarkdown: AI流入表に全月の行がある', () => {
  const aiData = {
    months: [
      {
        yearMonth: '202611',
        totalSessions: 1000,
        aiSessions: 50,
        aiSources: { 'chatgpt.com': 30, 'perplexity.ai': 20 },
        totalKeyEvents: 200,
        aiKeyEvents: 10,
      },
      {
        yearMonth: '202610',
        totalSessions: 1200,
        aiSessions: 30,
        aiSources: { 'chatgpt.com': 20, 'claude.ai': 10 },
        totalKeyEvents: 250,
        aiKeyEvents: 5,
      },
    ],
    keyEventMetric: 'keyEvents',
  };
  const channelData = [
    {
      yearMonth: '202611',
      channels: { 'Organic Search': 500, Direct: 300, Referral: 100, '(other)': 100 },
    },
    {
      yearMonth: '202610',
      channels: { 'Organic Search': 600, Direct: 350, Referral: 80, '(other)': 170 },
    },
  ];

  const md = renderMarkdown(aiData, channelData, 2);

  // AI流入表（セクション1）のデータ行: 月ごとに1行
  const aiSectionMatch = md.match(/## 1\. AI流入の月次推移/);
  assert.ok(aiSectionMatch);
  const section1End = md.indexOf('## 2.', aiSectionMatch.index);
  const section1 = md.slice(aiSectionMatch.index, section1End);
  const dataRowsInSection1 = section1.match(/^\| 2026/gm);
  assert.equal(dataRowsInSection1?.length ?? 0, 2, 'AI流入表に2行のデータ行がある');

  // 2つのセクションが含まれる
  assert.match(md, /## 1\. AI流入の月次推移/);
  assert.match(md, /## 2\. チャネル別セッション月次推移/);
  assert.match(md, /## 3\. AIソース別合計/);
  assert.match(md, /## 4\. 直近3か月 vs 前年同期3か月/);

  // AI割合が計算されている
  assert.match(md, /5\.00%/); // 50/1000
  assert.match(md, /2\.50%/); // 30/1200

  // チャネル表に Organic Search の値が出る
  assert.match(md, /\| 500 \|/);
  assert.match(md, /\| 600 \|/);
});

test('renderMarkdown: AI流入0件の月を扱える', () => {
  const aiData = {
    months: [
      {
        yearMonth: '202611',
        totalSessions: 500,
        aiSessions: 0,
        aiSources: {},
        totalKeyEvents: 100,
        aiKeyEvents: 0,
      },
    ],
    keyEventMetric: 'keyEvents',
  };
  const channelData = [
    {
      yearMonth: '202611',
      channels: { 'Organic Search': 300, Direct: 200 },
    },
  ];

  const md = renderMarkdown(aiData, channelData, 1);
  assert.match(md, /\| 0 \|/); // AI流入0
  assert.match(md, /-/); // 内訳が -（なし）
});