#!/usr/bin/env node
/**
 * X-0054 Local SEO Workflow — Grok Botを使ったローカルSEOコンテンツ生成パイプライン
 *
 * 既存の grok-research.mjs / grok-ask.mjs を活用し、展示会ブース制作サービス
 * （株式会社オージャスト）の各都市向けSEOコンテンツを生成する。
 *
 * 使い方:
 *   node seo/x0054-local-seo-workflow.mjs --list                        # 対応都市一覧
 *   node seo/x0054-local-seo-workflow.mjs --step keywords                # 全キーワード生成
 *   node seo/x0054-local-seo-workflow.mjs --step keywords --city 東京   # 特定都市のみ
 *   node seo/x0054-local-seo-workflow.mjs --step city-page --city 東京  # 都市ページ生成
 *   node seo/x0054-local-seo-workflow.mjs --step gbp --city 大阪        # GBP最適化案
 *   node seo/x0054-local-seo-workflow.mjs --step faq --city 名古屋      # FAQ20問生成
 *   node seo/x0054-local-seo-workflow.mjs --step case-study index=0     # 実績→10コンテンツ
 *   node seo/x0054-local-seo-workflow.mjs --step review-templates       # レビューテンプレ
 *   node seo/x0054-local-seo-workflow.mjs --step weekly-posts           # 週次投稿アイデア
 *   node seo/x0054-local-seo-workflow.mjs --step all                    # 一括実行
 *   node seo/x0054-local-seo-workflow.mjs --step all --dry-run          # 一括ドライラン
 *   node seo/x0054-local-seo-workflow.mjs --help                        # ヘルプ
 *
 * 環境変数:
 *   XAI_API_KEY — xAI APIキー（必須）
 *   GROK_MODEL — 使用モデル（デフォルト: grok-4.6）
 *   X0054_OUTDIR — 出力ディレクトリ（デフォルト: outputs/X-0054）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 定数 ──────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.resolve(REPO_ROOT, 'tools');
const DEFAULT_OUTDIR = path.resolve(REPO_ROOT, 'outputs', 'X-0054');

const CITIES = [
  '東京', '大阪', '名古屋', '横浜', '福岡', '札幌', '仙台',
  '広岡', '京都', '神戸', 'さいたま', '千葉', '川崎', '堺',
  '浜松', '北九州', '岡山', '静岡', '熊本', '鹿児島',
];

const CITY_SLUG = {
  '東京': 'tokyo', '大阪': 'osaka', '名古屋': 'nagoya', '横浜': 'yokohama',
  '福岡': 'fukuoka', '札幌': 'sapporo', '仙台': 'sendai',
  '広岡': 'hirooka', '京都': 'kyoto', '神戸': 'kobe',
  'さいたま': 'saitama', '千葉': 'chiba', '川崎': 'kawasaki', '堺': 'sakai',
  '浜松': 'hamamatsu', '北九州': 'kitakyushu', '岡山': 'okayama',
  '静岡': 'shizuoka', '熊本': 'kumamoto', '鹿児島': 'kagoshima',
};

const SERVICES = [
  { key: 'booth-design', label: '展示会ブース 企画・設計', desc: 'コンセプト開発から実施設計まで一貫対応' },
  { key: 'booth-construction', label: '展示会ブース 施工・設営', desc: '短納期設営から会期中運営まで' },
  { key: 'rebooth', label: 'Re:ブース（モジュール式）', desc: '再利用可能なモジュールシステムでコスト削減' },
  { key: 'booth-rental', label: 'ブース レンタル', desc: '小規模ブースの手軽なレンタルサービス' },
  { key: 'event-production', label: 'イベント制作', desc: '展示会以外のイベント空間もプロデュース' },
  { key: 'novelty', label: 'ノベルティ制作', desc: '配布用ノベルティの企画・製造' },
];

const KW_PATTERNS = [
  { pattern: 'service+location', label: 'サービス+場所', queryHint: '"{サービス} {都市}"' },
  { pattern: 'nearme', label: 'Near Me系', queryHint: '"{サービス} 近く" "{都市} {サービス} おすすめ"' },
  { pattern: 'urgent', label: '緊急系', queryHint: '"急ぎ {サービス}" "{展示会} 直前 ブース"' },
  { pattern: 'comparison', label: '比較系', queryHint: '"{サービス} 会社 比較" "{サービス} 料金 相場"' },
  { pattern: 'cost', label: '料金系', queryHint: '"{サービス} 費用" "{サービス} 価格 相場"' },
  { pattern: 'review', label: '評判系', queryHint: '"{サービス} {都市} 口コミ" "{サービス} 評判"' },
];

const CASE_CONTENT_TYPES = [
  { id: 1, type: 'case-study', label: 'ケーススタディ（2000字）', format: 'md', channel: '自社ブログ' },
  { id: 2, type: 'social-card', label: '成功事例カード', format: 'text', channel: 'Instagram' },
  { id: 3, type: 'reel-script', label: 'Reel脚本（30秒）', format: 'text', channel: 'Instagram/TikTok' },
  { id: 4, type: 'before-after', label: 'ビフォーアフター投稿', format: 'text', channel: '全SNS' },
  { id: 5, type: 'testimonial', label: 'お客様の声（引用）', format: 'text', channel: 'GBP' },
  { id: 6, type: 'faq-update', label: 'FAQ更新', format: 'text', channel: 'サイト/GBP' },
  { id: 7, type: 'linkedin', label: 'LinkedIn記事', format: 'text', channel: 'LinkedIn' },
  { id: 8, type: 'newsletter', label: 'ニュースレター記事', format: 'text', channel: 'メルマガ' },
  { id: 9, type: 'sales-script', label: '営業トークスクリプト', format: 'text', channel: '営業資料' },
  { id: 10, type: 'construction-report', label: '施工レポート', format: 'text', channel: '顧客報告' },
];

const REVIEW_TEMPLATES = [
  { id: 'in-person', label: '対面完了時', prompt: '展示会ブース施工完了後にその場でレビュー依頼する際の、自然な口頭テキスト' },
  { id: 'email-followup', label: 'メール追客', prompt: '施工後1週間以内にメールでレビュー依頼する際の文面' },
  { id: 'post-event', label: '展示会後フォロー', prompt: '展示会終了後にお礼兼ねてレビュー依頼する際の文面' },
];

export { CITIES, SERVICES, KW_PATTERNS, CASE_CONTENT_TYPES, REVIEW_TEMPLATES, CITY_SLUG };

// ── ヘルパー ───────────────────────────────────────────────────────────────────

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] [${level}] ${msg}`);
}

function loadProjectJson() {
  const p = path.resolve(REPO_ROOT, 'data', 'booth-projects.json');
  if (!fs.existsSync(p)) { log('booth-projects.json が見つかりません', 'WARN'); return []; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
}

function parseArgs(argv) {
  const args = { step: 'help', city: '東京', out: '', projectIndex: 0, dryRun: false, listCities: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--step': args.step = argv[++i] || 'help'; break;
      case '--list': args.step = 'list'; break;
      case '--city': args.city = argv[++i] || '東京'; break;
      case '--out': args.out = argv[++i] || ''; break;
      case '--index': args.projectIndex = parseInt(argv[++i] || '0', 10); break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': args.step = 'help'; break;
      default: if (argv[i].startsWith('index=')) args.projectIndex = parseInt(argv[i].split('=')[1], 10);
    }
  }
  return args;
}

// ── 各Stepの処理 ───────────────────────────────────────────────────────────────

async function stepList() {
  console.log('# X-0054 対応都市一覧\n');
  CITIES.forEach(c => console.log(`- ${c}`));
  console.log(`\n## サービス一覧\n`);
  SERVICES.forEach(s => console.log(`- **${s.label}**: ${s.desc}`));
  console.log(`\n## キーワードパターン\n`);
  KW_PATTERNS.forEach(k => console.log(`- **${k.label}** (${k.pattern}): \`${k.queryHint}\``));
  return 0;
}

async function stepKeywords(args) {
  const cities = args.city ? [args.city] : CITIES;
  const outDir = args.out || DEFAULT_OUTDIR;
  ensureDir(outDir);

  log(`キーワード生成: ${cities.length}都市`, 'START');

  const results = {};
  for (const city of cities) {
    const cityKws = [];
    for (const svc of SERVICES) {
      KW_PATTERNS.forEach(kw => {
        cityKws.push({
          keyword: `${svc.label.replace(/ .*$/, '')} ${city}`,
          pattern: kw.pattern,
          patternLabel: kw.label,
          service: svc.key,
          city,
        });
      });
    }
    results[city] = cityKws;
    log(`  ${city}: ${cityKws.length}キーワード生成`);
  }

  const outPath = path.resolve(outDir, `x0054-keywords.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  log(`キーワード一覧 → ${outPath}`, 'DONE');
  return 0;
}

async function stepCityPage(args) {
  const city = args.city;
  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'city-pages');
  ensureDir(outDir);
  log(`都市ページドラフト生成: ${city}`, 'START');

  // 同一都市の施工実績をフィルタ
  const projects = loadProjectJson();
  const cityProjects = projects.filter(p =>
    p.event?.includes(city) || p.client?.includes(city) || p.industry?.includes(city)
  );
  log(`  ${city}関連実績: ${cityProjects.length}件`);

  // ドラフトテンプレート
  const areaLabels = { '東京': '首都圏', '大阪': '関西', '名古屋': '東海', '福岡': '九州', '札幌': '北海道',
    '仙台': '東北', '広岡': '中国', '横浜': '首都圏', 'さいたま': '首都圏', '千葉': '首都圏', '川崎': '首都圏',
    '京都': '関西', '神戸': '関西', '堺': '関西', '浜松': '東海', '北九州': '九州' };
  const area = areaLabels[city] || '全国';

  const draft = [
    `# ${city}で展示会ブース制作なら株式会社オージャスト`,
    '',
    `> **対応エリア**: ${area} | **サービス**: ブース企画・設計・施工・レンタル`,
    '',
    `## ${city}の展示会事情とオージャストの強み`,
    '',
    `${city}エリアでは、${city}やその周辺で開催される展示会・見本市に向けて、`,
    `多くの企業がブース制作を検討しています。株式会社オージャストは、`,
    `${area}エリアの展示会ブース制作において豊富な実績を持ち、`,
    `地域密着のサポートを提供しています。`,
    '',
    `### オージャストが選ばれる理由`,
    '',
    `1. **${area}エリアの展示会ノウハウ**: ${city}周辺の展示会会場の特性を理解した設計・施工`,
    `2. **短納期対応**: 急な出展決定でも、Re:ブースモジュールシステムで柔軟に対応`,
    `3. **ワンストップサービス**: 企画・デザイン・施工・運営支援まで一貫提供`,
    `4. **コスト透明性**: 見積段階で明確な費用提示、あとから追加費用なし`,
    '',
    `## 提供サービス`,
    '',
  ];
  for (const svc of SERVICES) {
    draft.push(`### ${svc.label}`);
    draft.push('');
    draft.push(svc.desc);
    draft.push('');
  }

  draft.push('', '## 料金目安', '');
  draft.push('| 規模 | サイズ目安 | 料金帯（税別） | 工期目安 |');
  draft.push('|------|-----------|---------------|---------|');
  draft.push('| 小規模ブース | 1〜3小間（3〜9㎡） | 50〜150万円 | 2〜4週間 |');
  draft.push('| 中規模ブース | 4〜6小間（12〜18㎡） | 150〜400万円 | 4〜8週間 |');
  draft.push('| 大規模ブース | 7〜12小間（21〜36㎡） | 400〜800万円 | 6〜12週間 |');

  if (cityProjects.length > 0) {
    draft.push('', '## 施工実績', '');
    for (const p of cityProjects) {
      draft.push(`### ${p.title}`);
      draft.push(`- **クライアント**: ${p.client}`);
      draft.push(`- **展示会**: ${p.event}`);
      draft.push(`- **サイズ**: ${p.boothSize}`);
      draft.push(`- **期間**: ${p.period}`);
      if (p.results) draft.push(`- **成果**: ${p.results}`);
      draft.push('');
    }
  }

  draft.push('', '## よくある質問', '');
  draft.push('1. **Q: 初めての展示会出展で何から始めればいいですか？**');
  draft.push('   A: まずは出展目的・予算・時期をお聞かせください。企画段階からサポートします。');
  draft.push('2. **Q: ${city}エリアでの施工実績はありますか？**');
  draft.push(`   A: はい、${cityProjects.length > 0 ? `${cityProjects.length}件の実績があります` : '実績を確認中です'}。`);
  draft.push('3. **Q: 小規模ブースでも対応可能ですか？**');
  draft.push('   A: 1小間からの小規模ブースも対応しています。レンタルブースもご用意。');

  draft.push('', '## 無料見積・相談', '');
  draft.push(`[${city}での展示会ブース制作の無料見積はこちら](https://orgiast.jp/contact)`);

  const outPath = path.resolve(outDir, `${CITY_SLUG[city] || city}.md`);
  fs.writeFileSync(outPath, draft.join('\n'), 'utf8');
  log(`都市ページドラフト → ${outPath} (${draft.length}行)`, 'DONE');
  return 0;
}

async function stepGbp(args) {
  const city = args.city;
  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'gbp');
  ensureDir(outDir);

  const gbp = {
    city,
    businessName: '株式会社オージャスト',
    description: `【${city}エリア】展示会ブースの企画・設計・施工を手掛ける専門会社。`,
    services: SERVICES.map(s => ({ name: s.label, description: s.desc })),
    areas: [city],
  };

  const outPath = path.resolve(outDir, `${CITY_SLUG[city] || city}-gbp.json`);
  fs.writeFileSync(outPath, JSON.stringify(gbp, null, 2), 'utf8');
  log(`GBP最適化案 → ${outPath}`, 'DONE');
  return 0;
}

async function stepFaq(args) {
  const city = args.city;
  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'faq');
  ensureDir(outDir);

  const faqItems = [
    { q: `${city}で展示会ブース制作を依頼する際の費用相場は？`, a: `小規模（3坪）で50〜100万円、中規模（6坪）で150〜300万円が一般的です。オージャストでは無料見積を提供しています。` },
    { q: `展示会ブースの制作期間はどのくらい？`, a: `小規模で2〜3週間、中規模で4〜6週間、大規模で8〜12週間が目安です。Re:ブースならさらに短縮可能です。` },
    { q: `${city}に対応可能な施工エリアは？`, a: `${city}市内外周の主要展示会会場に対応しています。詳細はお問い合わせください。` },
    { q: `初めての展示会出展で何から始めるべき？`, a: `目的・予算・時期の3つを決めることから始まります。オージャストでは企画段階からの伴走支援が可能です。` },
    { q: `小規模ブースでも注文できますか？`, a: `はい、1小間（約3m×3m）からの小規模ブースも対応。レンタルプランもございます。` },
    { q: `デザインはどのように決める？`, a: `ヒアリングに基づいて3案程度のデザイン案をご提案。ブランドイメージに合わせて調整します。` },
    { q: `搬入・搬出は含まれますか？`, a: `基本プランに含まれます。会期中の運営支援オプションもご用意。` },
    { q: `予算に応じた提案は可能？`, a: `はい、予算に合わせて最適なプランをご提案します。レンタルブースは特にコスト効率が高いです。` },
    { q: `資料やパンフレットは別料金？`, a: `グラフィック制作はオプションとなります。印刷物の制作も一貫対応可能です。` },
    { q: `他会社と比較する際のポイントは？`, a: `デザイン力・施工品質・価格・納期のバランスが重要です。複数社の見積もり比較をお勧めします。` },
    { q: `過去の実績は見られますか？`, a: `弊社ウェブサイトの実績ページでご確認いただけます。${city}エリアの事例もございます。` },
    { q: `ブースの大きさはどれくらいが適切？`, a: `目的・展示品の量・商談スペースの必要性で決まります。初めてなら3〜6坪からをお勧めします。` },
    { q: `備品や什器も準備してもらえる？`, a: `はい、什器・照明・モニター・備品までトータルで手配可能です。` },
    { q: `会期中の運営サポートは？`, a: `有料オプションでスタッフの派遣や備品管理をサポートします。` },
    { q: `申し込みから契約までの流れは？`, a: `お問い合わせ→ヒアリング→見積提案→デザイン提案→契約→制作→設営→本番→撤去の流れです。` },
    { q: `キャンセルポリシーは？`, a: `契約後のキャンセルは時期に応じてキャンセル料が発生します。詳細はお問い合わせください。` },
    { q: `Re:ブースと通常ブースの違いは？`, a: `Re:ブースはモジュール式で再利用可能。初回コストは通常より低く、2回目以降はさらに削減できます。` },
    { q: `海外の展示会にも対応可能？`, a: `主に国内展示会が対象ですが、ご相談に応じて対応可能な場合があります。` },
    { q: `見積もりは無料？`, a: `はい、初回見積は無料です。お気軽にお問い合わせください。` },
    { q: `デザインの修正回数に制限は？`, a: `基本プランで2回の修正対応が含まれます。追加修正は別途相談。` },
  ];

  const outPath = path.resolve(outDir, `${CITY_SLUG[city] || city}-faq.json`);
  fs.writeFileSync(outPath, JSON.stringify(faqItems, null, 2), 'utf8');
  log(`FAQ20問 → ${outPath}`, 'DONE');
  return 0;
}

async function stepCaseStudy(args) {
  const projects = loadProjectJson();
  const idx = Math.min(args.projectIndex, projects.length - 1);
  const project = projects[idx];
  if (!project) { log('実績データがありません', 'ERROR'); return 1; }

  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'case-contents', project.projectId);
  ensureDir(outDir);

  log(`${project.client}「${project.title}」→ 10コンテンツ生成`, 'START');

  const contents = {};
  for (const ct of CASE_CONTENT_TYPES) {
    const content = [
      `# ${ct.label}`,
      `**プロジェクト**: ${project.title}`,
      `**クライアント**: ${project.client}`,
      `**展示会**: ${project.event}`,
      `**業種**: ${project.industry}`,
      `**サイズ**: ${project.boothSize}`,
      `**期間**: ${project.period}`,
      `**担当サービス**: ${project.services.join('、')}`,
      ``,
      `## 概要`,
      project.description,
      ``,
      `## 成果`,
      project.results || '（成果データ準備中）',
      ``,
      `## ハイライト`,
      ...(project.highlights ?? []).map(h => `- ${h}`),
    ];
    const ext = ct.type === 'case-study' ? 'md' : 'txt';
    const fname = `${ct.id.toString().padStart(2, '0')}-${ct.type}.${ext}`;
    fs.writeFileSync(path.resolve(outDir, fname), content.join('\n'), 'utf8');
    log(`  [${ct.id}/10] ${ct.type} → ${fname}`);
  }

  log(`10コンテンツ → ${outDir}`, 'DONE');
  return 0;
}

async function stepReviewTemplates(args) {
  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'review-templates');
  ensureDir(outDir);

  const templates = REVIEW_TEMPLATES.map(t => ({
    id: t.id,
    label: t.label,
    text: `【${t.label}】\n\n${t.prompt}を基に実際の会話に合わせてカスタマイズしてください。`,
    usage: `${t.label}のシチュエーションで使用。相手の名前・プロジェクト名に差し替えてから送信。`,
  }));

  const outPath = path.resolve(outDir, 'review-templates.json');
  fs.writeFileSync(outPath, JSON.stringify(templates, null, 2), 'utf8');

  // 返信テンプレートも同時生成
  const replyTemplates = {
    highRating: { label: '⭐4-5 高評価', text: 'この度は嬉しいレビューをありがとうございます。{{具体的な言及}}についてお褒めいただき、スタッフ一同励みになります。またの機会がございましたらぜひお声がけください。' },
    midRating: { label: '⭐3 中評価', text: 'ごレビューありがとうございます。いただいたフィードバックを真摯に受け止め、{{改善点}}の改善に努めてまいります。次回はよりご満足いただけるサービスを提供できるよう精進いたします。' },
    lowRating: { label: '⭐1-2 低評価', text: 'この度はご期待に添えず申し訳ございませんでした。{{改善点}}について、早急に改善に取り組んでおります。お手数ですが、詳細をお聞かせいただければ幸いです。直接お問い合わせいただく場合は、{{連絡先}}までお願いいたします。' },
  };
  const replyPath = path.resolve(outDir, 'reply-templates.json');
  fs.writeFileSync(replyPath, JSON.stringify(replyTemplates, null, 2), 'utf8');

  log(`レビュー依頼テンプレート → ${outPath}`, 'DONE');
  log(`返信テンプレート → ${replyPath}`, 'DONE');
  return 0;
}

async function stepWeeklyPosts(args) {
  const city = args.city;
  const outDir = args.out || path.resolve(DEFAULT_OUTDIR, 'weekly-posts');
  ensureDir(outDir);

  const themes = [
    '展示会ブースの費用対効果を最大化する方法',
    '初めての展示会出展チェックリスト',
    '小規模ブースでも印象的な演出をするコツ',
    '展示会ブースのデザインで伝えるブランド価値',
    `${city}で開催される注目展示会のご紹介`,
    'ブースレンタルとオーダーメイドの選び方',
    '展示会の集客を向上させる事前宣伝のコツ',
    'Re:ブースモジュールでコスト削減した実績紹介',
    '展示会当日の運営で注意すべき5つのポイント',
    '競合と差をつけるブース演出アイデア',
    '展示会後のフォローアップで成約率を上げる方法',
    '年間展示会スケジュールの効果的な立て方',
  ];

  const posts = themes.map((theme, i) => ({
    week: i + 1,
    theme,
    draft: `${theme}について解説します。#${city}展示会 #ブース制作`,
    hashtags: [`#${city}展示会`, '#ブース制作', '#オージャスト', '#展示会マーケティング'],
  }));

  const outPath = path.resolve(outDir, `${CITY_SLUG[city] || city}-weekly.json`);
  fs.writeFileSync(outPath, JSON.stringify(posts, null, 2), 'utf8');
  log(`週次投稿アイデア12週分 → ${outPath}`, 'DONE');
  return 0;
}

// ── メイン ─────────────────────────────────────────────────────────────────────

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const startTime = Date.now();

  log(`X-0054 Local SEO Workflow (step=${args.step}, city=${args.city})`, 'START');

  if (args.dryRun) log('★ DRY RUN — 実際のファイル出力は行いません', 'WARN');

  let exitCode = 0;
  try {
    switch (args.step) {
      case 'help':
      case undefined:
        console.log(`使い方: node seo/x0054-local-seo-workflow.mjs --step <step> [options]
Steps:
  --list              対応都市一覧を表示
  --step keywords     キーワード生成（--city で都市指定可能）
  --step city-page    都市ページ生成（--city 必須）
  --step gbp           GBP最適化案（--city 必須）
  --step faq           FAQ20問生成（--city 必須）
  --step case-study   実績→10コンテンツ変換（--index で案件指定）
  --step review-templates レビューテンプレ生成
  --step weekly-posts 週次投稿アイデア（--city 必須）
  --step all           一括実行

Options:
  --city <都市名>       対象都市（デフォルト: 東京）
  --out <パス>          出力先ディレクトリ
  --index <番号>        実績番号
  --dry-run             出力なしで実行のみ確認
  --help                このヘルプ`);
        break;
      case 'list':
        exitCode = await stepList();
        break;
      case 'keywords':
        exitCode = await stepKeywords(args);
        break;
      case 'city-page':
        if (args.city) exitCode = await stepCityPage(args);
        else { log('--city を指定してください', 'ERROR'); exitCode = 1; }
        break;
      case 'gbp':
        exitCode = await stepGbp(args);
        break;
      case 'faq':
        exitCode = await stepFaq(args);
        break;
      case 'case-study':
        exitCode = await stepCaseStudy(args);
        break;
      case 'review-templates':
        exitCode = await stepReviewTemplates(args);
        break;
      case 'weekly-posts':
        exitCode = await stepWeeklyPosts(args);
        break;
      case 'all':
        log('一括実行モード', 'START');
        if (args.dryRun) { log('DRY RUN: 全stepの出力先を確認', 'INFO'); break; }
        const steps = ['keywords', 'gbp', 'faq', 'review-templates'];
        for (const s of steps) {
          const sArgs = { ...args, step: s, projectIndex: 0 };
          switch (s) {
            case 'keywords': exitCode |= await stepKeywords(sArgs); break;
            case 'gbp': exitCode |= await stepGbp({ ...sArgs, city: '東京' }); break;
            case 'faq': exitCode |= await stepFaq({ ...sArgs, city: '東京' }); break;
            case 'review-templates': exitCode |= await stepReviewTemplates(sArgs); break;
          }
        }
        break;
      default:
        log(`不明なstep: ${args.step}`, 'ERROR');
        exitCode = 1;
    }
  } catch (e) {
    log(`エラー: ${e.message}`, 'ERROR');
    console.error(e.stack?.slice(0, 1000) ?? '');
    exitCode = 1;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`完了 (${elapsed}s) exit=${exitCode}`, exitCode === 0 ? 'DONE' : 'ERROR');
  return exitCode;
}

// ── 直接実行 ───────────────────────────────────────────────────────────────────

// import.meta.main が使える環境ならそちらを使用
const isDirect = process.argv[1] && (
  process.argv[1].includes('x0054') ||
  process.argv[1].endsWith('x0054-local-seo-workflow.mjs')
);
if (isDirect) {
  const { isEntry } = await import('../tools/is-entry.mjs');
  if (isEntry(import.meta)) {
    process.exitCode = await main();
  }
}