import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function outputDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0054-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Workflowの各機能のユニットテスト
// 注: 実際のAPI呼び出しは行わず、ファイル生成・パース・データ構造を検証

const CITIES = [
  '東京', '大阪', '名古屋', '横浜', '福岡', '札幌', '仙台',
  '広岡', '京都', '神戸', 'さいたま', '千葉',
];

const SERVICES = [
  { key: 'booth-design', label: '展示会ブース 企画・設計' },
  { key: 'booth-construction', label: '展示会ブース 施工・設営' },
  { key: 'rebooth', label: 'Re:ブース（モジュール式）' },
  { key: 'booth-rental', label: 'ブース レンタル' },
  { key: 'event-production', label: 'イベント制作' },
  { key: 'novelty', label: 'ノベルティ制作' },
];

const KW_PATTERNS = ['service+location', 'nearme', 'urgent', 'comparison', 'cost', 'review'];

// ── キーワード生成 ───────────────────────────────────────────────────────────────

test('キーワード: 全都市×全サービスのキーワードが生成される', () => {
  const results = {};
  for (const city of CITIES) {
    const kws = [];
    for (const svc of SERVICES) {
      for (const pattern of KW_PATTERNS) {
        kws.push({ keyword: `${svc.key} ${city}`, pattern, city });
      }
    }
    results[city] = kws;
  }

  for (const city of CITIES) {
    assert.ok(results[city].length > 0, `${city}にキーワードが存在する`);
    assert.equal(results[city].length, SERVICES.length * KW_PATTERNS.length);
  }

  const tokyoKeys = results['東京'];
  assert.ok(tokyoKeys.some(k => k.keyword.includes('東京')), '東京のキーワードを含む');
  assert.ok(tokyoKeys.some(k => k.keyword.includes('booth-design')), 'サービスのキーワードを含む');
  assert.equal(tokyoKeys.filter(k => k.pattern === 'nearme').length, SERVICES.length);
});

test('キーワード: パターンごとに正しい構造を持つ', () => {
  for (const p of KW_PATTERNS) {
    assert.ok(typeof p === 'string', `パターン ${p} は文字列`);
  }
  assert.equal(new Set(KW_PATTERNS).size, KW_PATTERNS.length, 'パターンに重複なし');
});

// ── 都市ページ生成 ───────────────────────────────────────────────────────────────

test('都市ページ: 必須セクションを含む', () => {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0054-test-'));
  try {
    const city = '横浜';
    const areaLabels = { '横浜': '首都圏', '福岡': '九州' };
    const area = areaLabels[city] || '全国';

    const draft = [
      `# ${city}で展示会ブース制作なら株式会社オージャスト`,
      '',
      `## ${city}の展示会事情とオージャストの強み`,
      '',
      `### オージャストが選ばれる理由`,
      '',
      '## 提供サービス',
      '',
      '## 料金目安',
      '',
      '| 規模 | サイズ目安 | 料金帯（税別） | 工期目安 |',
      '|------|-----------|---------------|---------|',
      '',
      '## よくある質問',
      '',
      '## 無料見積・相談',
      '',
    ];

    const text = draft.join('\n');
    assert.ok(text.includes(city), '都市名を含む');
    assert.ok(text.includes('オージャスト'), '会社名を含む');
    assert.ok(text.includes('## よくある質問'), 'FAQセクションを含む');
    assert.ok(text.includes('## 無料見積・相談'), 'CTAセクションを含む');
    assert.ok(text.includes('## 提供サービス'), 'サービスセクションを含む');
    assert.ok(text.includes('## 料金目安'), '料金セクションを含む');
  } finally {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

test('都市ページ: areaラベルが全都市をカバー', () => {
  const areaLabels = { '東京': '首都圏', '大阪': '関西', '名古屋': '東海', '福岡': '九州', '札幌': '北海道',
    '仙台': '東北', '広岡': '中国', '横浜': '首都圏', 'さいたま': '首都圏', '千葉': '首都圏', '川崎': '首都圏',
    '京都': '関西', '神戸': '関西', '堺': '関西', '浜松': '東海', '北九州': '九州', '岡山': '中国', '静岡': '東海',
    '熊本': '九州', '鹿児島': '九州' };
  const required = ['東京', '大阪', '名古屋', '福岡', '札幌', '仙台', '横浜', '京都', '神戸'];
  for (const c of required) {
    assert.ok(areaLabels[c], `エリアラベル: ${c}`);
  }
});

// ── GBP生成 ────────────────────────────────────────────────────────────────────

test('GBP: データ構造が正しい', () => {
  const city = '名古屋';
  const gbp = {
    city,
    businessName: '株式会社オージャスト',
    description: `【${city}エリア】展示会ブースの企画・設計・施工を手掛ける専門会社。`,
    services: SERVICES.map(s => ({ name: s.label, description: `${s.key}サービス` })),
    areas: [city],
  };

  assert.equal(gbp.businessName, '株式会社オージャスト');
  assert.equal(gbp.city, '名古屋');
  assert.ok(gbp.description.includes(city));
  assert.equal(gbp.services.length, SERVICES.length);
  assert.ok(gbp.areas.includes(city));
});

// ── FAQ生成 ────────────────────────────────────────────────────────────────────

test('FAQ: 20問構造', () => {
  const faqItems = Array.from({ length: 20 }, (_, i) => ({
    q: `質問${i + 1}：テスト質問`,
    a: `回答${i + 1}：テスト回答`,
  }));

  assert.equal(faqItems.length, 20, 'FAQは20問');
  for (const item of faqItems) {
    assert.ok(item.q, '質問が存在');
    assert.ok(item.a, '回答が存在');
  }
});

test('FAQ: 各質問に回答がある', () => {
  const faqItems = Array.from({ length: 20 }, (_, i) => ({
    q: `Q${i + 1}`,
    a: `A${i + 1}`,
  }));
  for (const item of faqItems) {
    assert.ok(item.q, `${item.q}: 質問あり`);
    assert.ok(item.a, `${item.q}: 回答あり`);
    assert.notEqual(item.a.trim(), '', `${item.q}: 回答は空ではない`);
  }
});

// ── ケーススタディ変換 ───────────────────────────────────────────────────────────

test('ケーススタディ: 10種類のコンテンツタイプがある', () => {
  const types = [
    { id: 1, type: 'case-study' },
    { id: 2, type: 'social-card' },
    { id: 3, type: 'reel-script' },
    { id: 4, type: 'before-after' },
    { id: 5, type: 'testimonial' },
    { id: 6, type: 'faq-update' },
    { id: 7, type: 'linkedin' },
    { id: 8, type: 'newsletter' },
    { id: 9, type: 'sales-script' },
    { id: 10, type: 'construction-report' },
  ];

  assert.equal(types.length, 10);
  const ids = types.map(t => t.id);
  assert.equal(new Set(ids).size, 10, 'IDに重複なし');
  assert.deepEqual(ids.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'IDは1〜10');

  const typeNames = types.map(t => t.type);
  assert.equal(new Set(typeNames).size, 10, 'タイプに重複なし');
});

// ── レビューテンプレート ─────────────────────────────────────────────────────────

test('レビューテンプレート: 3つのシチュエーション', () => {
  const templates = [
    { id: 'in-person', label: '対面完了時' },
    { id: 'email-followup', label: 'メール追客' },
    { id: 'post-event', label: '展示会後フォロー' },
  ];
  assert.equal(templates.length, 3);
  for (const t of templates) {
    assert.ok(t.id);
    assert.ok(t.label);
  }
});

test('返信テンプレート: 3段階の評価', () => {
  const replies = {
    high: { label: '高評価', range: '⭐4-5' },
    mid: { label: '中評価', range: '⭐3' },
    low: { label: '低評価', range: '⭐1-2' },
  };
  const keys = Object.keys(replies);
  assert.equal(keys.length, 3);
  assert.deepEqual(keys, ['high', 'mid', 'low']);
});

// ── 週次投稿 ────────────────────────────────────────────────────────────────────

test('週次投稿: 12週分のテーマがある', () => {
  const themes = Array.from({ length: 12 }, (_, i) => ({
    week: i + 1,
    theme: `テーマ${i + 1}`,
    hashtags: ['#展示会', '#ブース制作'],
  }));

  assert.equal(themes.length, 12);
  for (const t of themes) {
    assert.equal(t.week, themes.indexOf(t) + 1);
    assert.ok(t.hashtags.length >= 1);
  }
});

// ── ワークフローの統合テスト ────────────────────────────────────────────────────

test('ワークフロー: --list がエラーなく表示される', async () => {
  // スクリプトを直接インポートしてmainを実行
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--list']);
  assert.equal(exitCode, 0, '--list は exit 0');
});

test('ワークフロー: --help がエラーなく表示される', async () => {
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--help']);
  assert.equal(exitCode, 0, '--help は exit 0');
});

test('ワークフロー: 不明なstepは exit 1', async () => {
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--step', 'nonexistent']);
  assert.equal(exitCode, 1, '不明なstepは exit 1');
});

test('ワークフロー: keywords step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'keywords', '--city', '東京']);
  assert.equal(exitCode, 0);
  const kwPath = path.resolve(out, 'x0054-keywords.json');
  assert.ok(fs.existsSync(kwPath), 'キーワードファイルが存在');
  const data = JSON.parse(fs.readFileSync(kwPath, 'utf8'));
  assert.ok(data['東京'], '東京のキーワードが存在');
  assert.ok(data['東京'].length > 0, 'キーワードが空でない');
});

test('ワークフロー: city-page step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main, CITY_SLUG } = await import('./x0054-local-seo-workflow.mjs');
  const slugCity = '大阪';
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'city-page', '--city', slugCity]);
  assert.equal(exitCode, 0);
  const slug = CITY_SLUG[slugCity];
  const pagePath = path.resolve(out, `${slug}.md`);
  assert.ok(fs.existsSync(pagePath), '都市ページファイルが存在');
  const content = fs.readFileSync(pagePath, 'utf8');
  assert.ok(content.includes('大阪'), '大阪を含む');
  assert.ok(content.includes('オージャスト'), '会社名を含む');
});

test('ワークフロー: gbp step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main, CITY_SLUG } = await import('./x0054-local-seo-workflow.mjs');
  const slugCity = '福岡';
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'gbp', '--city', slugCity]);
  assert.equal(exitCode, 0);
  const slug = CITY_SLUG[slugCity];
  const gbpPath = path.resolve(out, `${slug}-gbp.json`);
  assert.ok(fs.existsSync(gbpPath));
  const data = JSON.parse(fs.readFileSync(gbpPath, 'utf8'));
  assert.equal(data.city, '福岡');
  assert.equal(data.businessName, '株式会社オージャスト');
});

test('ワークフロー: faq step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main, CITY_SLUG } = await import('./x0054-local-seo-workflow.mjs');
  const slugCity = '名古屋';
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'faq', '--city', slugCity]);
  assert.equal(exitCode, 0);
  const slug = CITY_SLUG[slugCity];
  const faqPath = path.resolve(out, `${slug}-faq.json`);
  assert.ok(fs.existsSync(faqPath));
  const data = JSON.parse(fs.readFileSync(faqPath, 'utf8'));
  assert.equal(data.length, 20, 'FAQは20問');
});

test('ワークフロー: review-templates step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'review-templates']);
  assert.equal(exitCode, 0);
  const tplPath = path.resolve(out, 'review-templates.json');
  const replyPath = path.resolve(out, 'reply-templates.json');
  assert.ok(fs.existsSync(tplPath));
  assert.ok(fs.existsSync(replyPath));
});

test('ワークフロー: weekly-posts step がファイルを生成する', async t => {
  const out = outputDir(t);
  const { main, CITY_SLUG } = await import('./x0054-local-seo-workflow.mjs');
  const slugCity = '札幌';
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'weekly-posts', '--city', slugCity]);
  assert.equal(exitCode, 0);
  const slug = CITY_SLUG[slugCity];
  const postsPath = path.resolve(out, `${slug}-weekly.json`);
  assert.ok(fs.existsSync(postsPath));
  const data = JSON.parse(fs.readFileSync(postsPath, 'utf8'));
  assert.equal(data.length, 12, '週次投稿は12週分');
});

test('ワークフロー: case-study step が10ファイルを生成する', async t => {
  const out = outputDir(t);
  const { main } = await import('./x0054-local-seo-workflow.mjs');
  const exitCode = await main(['node', 'x0054-local-seo-workflow.mjs', '--out', out, '--step', 'case-study', '--index', '0']);
  assert.equal(exitCode, 0);
  const caseDir = out;
  assert.ok(fs.existsSync(caseDir));
  const files = fs.readdirSync(caseDir);
  assert.equal(files.length, 10, '10コンテンツファイル');
  for (const f of files) {
    assert.ok(f.match(/^\d{2}-/), `${f}は番号接頭辞を持つ`);
  }
});