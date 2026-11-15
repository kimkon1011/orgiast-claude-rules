#!/usr/bin/env node
/**
 * AI Query Extractor — X-0005
 *
 * 正規表現で日本語テキストから疑問文系・依頼文系を抽出し、
 * LLMO（Large Language Model Optimization）向けの明確なAIクエリを生成する。
 *
 * 用途:
 * - サイトや問い合わせ文からブース見積・デザイン相談などの疑問・依頼を抽出
 * - 抽出したクエリを優先度順に並べ、AIに正しく取り上げられるコンテンツ優先度付けに使う
 *
 * Usage:
 *   node tools/ai-query-extract.mjs --file <path>
 *   node tools/ai-query-extract.mjs --text "ブースの見積もりはいくらですか？"
 *   cat <file> | node tools/ai-query-extract.mjs
 *   node tools/ai-query-extract.mjs --sample
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// 正規表現パターン定義
// ============================================================

/**
 * 疑問文系パターン（question patterns）
 * 疑問詞・疑問終助詞・疑問形式で文を検出する
 */
const QUESTION_PATTERNS = [
  // --- 終端パターン（文末で判定） ---
  {
    id: 'question_end_ka',
    label: '疑問終助詞「か」',
    regex: /(ですか|ますか|でしょうか|んですか|のか|ですかね|ますかね)[。\.\s]*$/mu,
    priority: 9,
  },
  {
    id: 'question_end_question_mark',
    label: '疑問符「？」',
    regex: /[？?][」'']*\s*$/mu,
    priority: 9,
  },
  {
    id: 'question_end_kana',
    label: '疑問終助詞「かな/かしら」',
    regex: /(かな|かしら|っけ|のかな)[。\.\s]*$/mu,
    priority: 7,
  },
  // --- 疑問詞パターン（文中に疑問詞を含む） ---
  {
    id: 'question_word_price',
    label: '金額・料金の疑問',
    regex: /(いくら|おいくら|料金|費用|価格|コスト|予算|お見積もり|見積もり|見積金額)(ですか|ですかね|か[？?]|を教えて|を知りたい|は[？?])/mu,
    priority: 8,
  },
  {
    id: 'question_word_how_many',
    label: '数量・程度の疑問',
    regex: /(いくつ|どのくらい|どれくらい|どの程度|何[名人個社]|何人|何個)/mu,
    priority: 7,
  },
  {
    id: 'question_word_which',
    label: '選択・特定の疑問',
    regex: /(どの|どちら|どっち|どれ|どんな|何の)/mu,
    priority: 7,
  },
  {
    id: 'question_word_why',
    label: '理由・原因の疑問',
    regex: /(なぜ|なんで|どうして|何故)/mu,
    priority: 6,
  },
  {
    id: 'question_word_how',
    label: '方法・手段の疑問',
    regex: /(どうやって|どのように|どうすれば|どうやったら|方法を|手順を)/mu,
    priority: 7,
  },
  {
    id: 'question_word_when',
    label: '時期・期限の疑問',
    regex: /(いつ|何月|何日|いつまで|いつから|いつ頃|納期|納品|締切|期限|日程|スケジュール)(か[？?]|ですか|ますか|でしょうか|を教えて|を知りたい|は[？?]|まで|から|を教え|はいつ)/mu,
    priority: 8,
  },
  {
    id: 'question_word_where',
    label: '場所・所在の疑問',
    regex: /(どこ|どちら|どこで|どこに|所在地|住所)(ですか|ですかね|か[？?]|を教えて|を知りたい|が知りたい|はどこ|はどちら)/mu,
    priority: 6,
  },
  {
    id: 'question_word_what',
    label: '内容・対象の疑問',
    regex: /(何[がをとにへでより]|何を|何が|何か|何ですか|何でしょう|何だ|とは|って何)/mu,
    priority: 7,
  },
  {
    id: 'question_word_who',
    label: '人物の疑問',
    regex: /(誰|どなた|担当者|ご担当|連絡先|窓口)(ですか|ですかね|か[？?]|を教えて|を知りたい|は誰|はどなた|が知りたい)/mu,
    priority: 7,
  },
];

/**
 * 依頼文系パターン（request patterns）
 * 依頼・要望・依頼・申込などの意思を検出する
 */
const REQUEST_PATTERNS = [
  {
    id: 'request_kudasai',
    label: '依頼「ください」',
    regex: /(ください|下さい|して下さい|頂戴)[。\.\s]*$/mu,
    priority: 9,
  },
  {
    id: 'request_onegai',
    label: '依頼「お願い」',
    regex: /(お願い|お願いします|お願い致します|お願いできますか)/mu,
    priority: 9,
  },
  {
    id: 'request_hoshii',
    label: '希望「ほしい」',
    regex: /(してほしい|していただきたい|して頂きたい|してもらいたい|して戴きたい)/mu,
    priority: 8,
  },
  {
    id: 'request_irai',
    label: '依頼名詞',
    regex: /(依頼|依頼事項|ご依頼|依頼内容)/mu,
    priority: 8,
  },
  {
    id: 'request_moushikomi',
    label: '申込・申込み',
    regex: /(申込|申し込み|申し込む|お申込|エントリー|応募|申請)/mu,
    priority: 9,
  },
  {
    id: 'request_yoyaku',
    label: '予約',
    regex: /(予約|ご予約|予約する|予約したい|空き状況|空き[をが])/mu,
    priority: 8,
  },
  {
    id: 'request_soudan',
    label: '相談',
    regex: /(相談|ご相談|相談する|相談したい|相談内容|打ち合わせ|ヒアリング)/mu,
    priority: 8,
  },
  {
    id: 'request_toiawase',
    label: '問い合わせ',
    regex: /(問い合わせ|お問い合わせ|問合せ|照会|お尋ね|質問|ご質問)/mu,
    priority: 7,
  },
  {
    id: 'request_mitumori',
    label: '見積もり依頼',
    regex: /(見積もり|見積り|お見積もり|お見積り)[をのはがと]?(ください|お願い|依頼|希望|して|送っ|請求|ほしい|いただ)/mu,
    priority: 9,
  },
  {
    id: 'request_shiritai',
    label: '知りたい・教えて',
    regex: /(知りたい|教えて|お教え|ご教示|ご教授|お聞きしたい|伺いたい|確認したい)/mu,
    priority: 8,
  },
  {
    id: 'request_tai',
    label: '意志「したい」',
    regex: /(したい|希望|を希望|ご希望|要望|ご要望|希望する|希望します|を考えて|を検討)/mu,
    priority: 7,
  },
  {
    id: 'request_contact',
    label: '連絡依頼',
    regex: /(連絡|ご連絡|連絡ください|連絡して|ご連絡ください|ご連絡します|ご連絡差し上げ)/mu,
    priority: 8,
  },
  {
    id: 'request_souhin',
    label: '送付依頼',
    regex: /(送付|送って|お送り|資料請求|資料を|カタログ|パンフレット|DM[をが])/mu,
    priority: 8,
  },
];

/**
 * LLMO（Large Language Model Optimization）向けパターン
 * AIが回答として引用しやすいクエリパターン
 */
const LLMO_PATTERNS = [
  {
    id: 'llmo_how_to',
    label: 'How-to（方法・やり方）',
    regex: /(方法|やり方|How to|how to|how-to|コツ|テクニック|ノウハウ|手順|フロー|進め方|作成方法|設定方法|使い方|始め方|考え方|対処法|解決方法|修正方法|直し方|組み立て方|申し込み方|申請方法|依頼方法|作り方|制作方法|導入手順|導入方法)/mu,
    priority: 9,
    llmo_type: 'tutorial',
  },
  {
    id: 'llmo_what_is',
    label: '定義・説明（とは・って何）',
    regex: /(とは|って何|ってどんな|ってどういう|って何ですか|とは何か|定義|意味|概要|説明|について|って|の基礎知識)/mu,
    priority: 9,
    llmo_type: 'definition',
  },
  {
    id: 'llmo_comparison',
    label: '比較（vs・違い・比較）',
    regex: /(比較|違い|vs|対|と[は]?どっち|[どちら|どっち]が[良い|安い|早い]|と[の]?違い|[より]?おすすめ|[どちら]?が[良い|適している]|比較表|比較一覧|メリット|デメリット|向き|不向き)/mu,
    priority: 8,
    llmo_type: 'comparison',
  },
  {
    id: 'llmo_best',
    label: 'おすすめ・ランキング',
    regex: /(おすすめ|ランキング|ベスト|お勧め|人気|選び方|選ぶ|厳選|おすすめ[の]?|イチオシ|おすすめ[を教えて|は|ランキング])/mu,
    priority: 9,
    llmo_type: 'recommendation',
  },
  {
    id: 'llmo_cost',
    label: '費用・価格（相場・料金）',
    regex: /(費用|価格|料金|相場|予算|コスト|金額|いくら|価格帯|価格帯|料金体系|価格設定|費用感|予算感|費用相場|価格相場)/mu,
    priority: 8,
    llmo_type: 'pricing',
  },
  {
    id: 'llmo_tutorial',
    label: '手順・流れ（ステップ）',
    regex: /(手順|流れ|ステップ|工程|プロセス|step|Step|STEP|ガイド|マニュアル|チュートリアル|チェックリスト|準備|進め方|必要なもの|期限|スケジュール|日程|段取り|段階)/mu,
    priority: 8,
    llmo_type: 'process',
  },
  {
    id: 'llmo_reason',
    label: '理由・原因説明',
    regex: /(なぜ|理由|原因|どうして|何故|なぜなら|理由は|要因|背景|わけ|所以|根拠|目的|意図|狙い)/mu,
    priority: 7,
    llmo_type: 'explanation',
  },
  {
    id: 'llmo_example',
    label: '事例・実例',
    regex: /(事例|例|実例|サンプル|ケーススタディ|成功事例|失敗例|参考|具体例|導入事例|活用例)/mu,
    priority: 7,
    llmo_type: 'example',
  },
  {
    id: 'llmo_timing',
    label: '時期・タイミング',
    regex: /(いつ|時期|タイミング|ベストタイミング|最適期|適切な[時期|タイミング]|おすすめの[時期|季節|月]|何月|何日|いつまで|いつから|いつ頃)/mu,
    priority: 6,
    llmo_type: 'timing',
  },
  {
    id: 'llmo_condition',
    label: '条件・要件',
    regex: /(条件|要件|必要な[もの|スキル]|資格|前提|必須|対象|適して|向いて|必要な準備|用意するもの)/mu,
    priority: 6,
    llmo_type: 'requirement',
  },
];

/**
 * LLMOスコアリングの重み定義
 */
const LLMO_WEIGHTS = {
  tutorial: 1.0,
  definition: 1.0,
  comparison: 0.9,
  recommendation: 0.95,
  pricing: 0.85,
  process: 0.8,
  explanation: 0.75,
  example: 0.7,
  timing: 0.65,
  requirement: 0.6,
};

/**
 * GSC（Google Search Console）CSVの解析結果の型定義（JSDoc）
 * @typedef {Object} GSCQuery
 * @property {string} query - 検索クエリ
 * @property {number} clicks - クリック数
 * @property {number} impressions - インプレッション数
 * @property {number} ctr - CTR（0-100）
 * @property {number} position - 平均掲載順位
 * @property {string|null} intent - クエリ意図（question/request/informational/transactional）
 * @property {number} llmo_score - LLM回答適性スコア（0-10）
 * @property {Array} patterns - マッチしたパターンID一覧
 */

/**
 * 業種特化パターン（展示会ブース・イベント業界向け）
 * 拡張版：LLMO分析用に追加パターンを含む
 */
const DOMAIN_SPECIFIC_PATTERNS = [
  {
    id: 'domain_booth_size',
    label: 'ブースサイズ',
    regex: /(小間|ブース[のを]?サイズ|ブースの広さ|出展規模|ブースサイズ|何小間|[0-9]+[mｍ]²|[0-9]+[mｍ]2)/mu,
    priority: 7,
    domain: 'exhibition',
  },
  {
    id: 'domain_booth_design',
    label: 'ブースデザイン',
    regex: /(デザイン|設計|図面|レイアウト|プラン|デザイン案|意匠|装飾|施工|設計施工)/mu,
    priority: 7,
    domain: 'exhibition',
  },
  {
    id: 'domain_equipment',
    label: '備品・機材',
    regex: /(備品|機材|レンタル|備品レンタル|家具|什器|照明|音響|モニター|展示台|パネル)/mu,
    priority: 6,
    domain: 'exhibition',
  },
  {
    id: 'domain_event',
    label: 'イベント企画',
    regex: /(イベント|催事|展示会|見本市|フェア|博覧会|プロモーション|キャンペーン|式典|コンベンション)/mu,
    priority: 7,
    domain: 'exhibition',
  },
  {
    id: 'domain_logistics',
    label: '運営・物流',
    regex: /(運営|設営|撤去|搬入|搬出|運搬|配送|設置|施工|工事|準備|片付け)/mu,
    priority: 6,
    domain: 'exhibition',
  },
  {
    id: 'domain_interpretation',
    label: '通訳・案内',
    regex: /(通訳|アテンダント|受付|案内|誘導|スタッフ|人材|オペレーター)/mu,
    priority: 6,
    domain: 'exhibition',
  },
  // --- LLMO分析用・拡張ドメインパターン ---
  {
    id: 'domain_al_media',
    label: 'AI生成・デジタルメディア',
    regex: /(AI生成|デジタルサイネージ|LED[モニタービジョン]|プロジェクション|デジタル[サイネージコンテンツ]|[VR|AR|MR]|没入型|インタラクティブ|タッチパネル)/mu,
    priority: 7,
    domain: 'exhibition_digital',
  },
  {
    id: 'domain_ecofriendly',
    label: 'サステナブル・エコ',
    regex: /(サステナブル|エコ|環境配慮|リサイクル|再利用|SDGs|カーボンニュートラル|グリーン|エコ素材|再生可能)/mu,
    priority: 6,
    domain: 'exhibition_eco',
  },
  {
    id: 'domain_layout',
    label: 'レイアウト・動線',
    regex: /(動線|レイアウト|ゾーニング|導線|間取り|配置|通路|入口|待機|誘導計画|ブース配置)/mu,
    priority: 6,
    domain: 'exhibition',
  },
  {
    id: 'domain_overseas',
    label: '海外出展・遠隔地',
    regex: /(海外出展|海外展示会|国際展示場|遠隔地|海外[輸送進出出展]|現地[施工設営]|越境|グローバル|インターナショナル)/mu,
    priority: 7,
    domain: 'exhibition_overseas',
  },
  {
    id: 'domain_online',
    label: 'オンライン展示会・ハイブリッド',
    regex: /(オンライン展示会|ハイブリッド|バーチャル|Web展示会|オンライン[イベント展示会]|リモート[展示会イベント]|デジタル展示)/mu,
    priority: 7,
    domain: 'exhibition_online',
  },
  {
    id: 'domain_industry',
    label: '業種特化展示会',
    regex: /(製造業|医療|ヘルスケア|介護|食品|[I|i]oT|ロボット|自動車|航空宇宙|エネルギー|環境|教育|農業|[F|f]in[テック|T]|観光|スポーツ|[B|b]eauty|コスメ|ファッション)[の]?(展示会|展|見本市|フェア|ショー)/mu,
    priority: 6,
    domain: 'exhibition_industry',
  },
];

// ============================================================
// 正規化マッピング
// ============================================================

/**
 * 抽出したクエリをAIが理解しやすい形に正規化する
 */
const NORMALIZATION_RULES = [
  { match: /(お見積もり|見積もり|見積り|お見積り)/, replacement: '見積もり' },
  { match: /(おいくら|いくら)/, replacement: '金額' },
  { match: /(いつ|いつまで|いつ頃)/, replacement: '時期' },
  { match: /(どこ|どちら|どちら様)/, replacement: '場所' },
  { match: /(どのくらい|どれくらい)/, replacement: '程度' },
  { match: /(どのように|どうやって|どうすれば)/, replacement: '方法' },
  { match: /(なぜ|なんで|どうして)/, replacement: '理由' },
  { match: /(ください|下さい)/, replacement: '' },
  { match: /(お願いします|お願い致します|お願い)/, replacement: '' },
  { match: /(して頂きたい|していただきたい|してほしい)/, replacement: '希望' },
  { match: /\s+/g, replacement: ' ' },
];

// ============================================================
// 日本語判定
// ============================================================

/**
 * テキストに日本語文字（ひらがな・カタカナ・漢字）が含まれているか判定
 * 英語のみの入力を除外するためのガード
 */
export function containsJapanese(text) {
  if (!text || typeof text !== 'string') return false;
  // ひらがな（3040-309F）、カタカナ（30A0-30FF）、CJK統合漢字（4E00-9FFF）
  return /[぀-ゟ゠-ヿ一-鿿]/.test(text);
}

// ============================================================
// 文分割とマッチング
// ============================================================

/**
 * 日本語テキストを文単位に分割する
 * 句点（。）・疑問符（？）・感嘆符（！）・改行で分割
 */
export function splitSentences(text) {
  if (!text || typeof text !== 'string') return [];
  // 句点・疑問符・感嘆符＋任意の閉じ引用符＋任意の空白で分割（空文を除去）
  const raw = text
    .replace(/\r\n?/g, '\n')
    .split(/(?<=[。．！？!?\n])\s*/u)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  // さらに改行を含む長文を「。」で再分割
  const result = [];
  for (const s of raw) {
    if (s.includes('\n') && s.length > 80) {
      result.push(...s.split('\n').map(t => t.trim()).filter(t => t.length > 0));
    } else {
      result.push(s);
    }
  }
  return result;
}

/**
 * 1つの文に対してマッチするパターンをすべて返す
 */
export function matchPatterns(sentence, patterns) {
  const matches = [];
  for (const pattern of patterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(sentence)) {
      matches.push({ id: pattern.id, label: pattern.label, priority: pattern.priority, ...(pattern.domain ? { domain: pattern.domain } : {}) });
    }
  }
  return matches;
}

/**
 * 疑問文系かどうかを判定
 */
export function isQuestion(sentence) {
  return matchPatterns(sentence, QUESTION_PATTERNS).length > 0;
}

/**
 * 依頼文系かどうかを判定
 */
export function isRequest(sentence) {
  return matchPatterns(sentence, REQUEST_PATTERNS).length > 0;
}

/**
 * ドメイン特化パターンにマッチするか
 */
export function matchDomainPatterns(sentence) {
  return matchPatterns(sentence, DOMAIN_SPECIFIC_PATTERNS);
}

/**
 * 抽出したクエリを正規化する
 */
export function normalizeQuery(text) {
  let result = text;
  for (const rule of NORMALIZATION_RULES) {
    result = result.replace(rule.match, rule.replacement);
  }
  return result.trim();
}

/**
 * === LLMO分析関連関数 ===
 */

/**
 * GSC（Google Search Console）のCSVエクスポートを解析する
 * 想定フォーマット（日本語エクスポート）:
 *   検索クエリ, クリック数, インプレッション数, CTR, 掲載順位
 * 英語エクスポート:
 *   Query, Clicks, Impressions, CTR, Position
 *
 * @param {string} csvText - CSVテキスト全体
 * @param {object} [options]
 * @param {number} [options.minImpressions=0] - 最小インプレッション数フィルタ
 * @param {number} [options.maxQueries=0] - 最大処理クエリ数（0=無制限）
 * @returns {Array<GSCQuery>}
 */
function importGSCQueries(csvText, options = {}) {
  const { minImpressions = 0, maxQueries = 0 } = options;
  if (!csvText || typeof csvText !== 'string') return [];

  const lines = csvText.trim().split('\n');
  if (lines.length < 2) return [];

  // ヘッダー行を解析し、カラム位置を特定
  const header = lines[0];
  const isJapanese = header.includes('検索クエリ') || header.includes('クリック数');

  // カラムマッピング（日本語/英語両対応）
  const queryIdx = isJapanese
    ? header.split(',').findIndex(c => c.includes('検索クエリ') || c.includes('クエリ'))
    : header.split(',').findIndex(c => /query/i.test(c));
  const clicksIdx = isJapanese
    ? header.split(',').findIndex(c => c.includes('クリック'))
    : header.split(',').findIndex(c => /click/i.test(c));
  const imprIdx = isJapanese
    ? header.split(',').findIndex(c => c.includes('インプレッション'))
    : header.split(',').findIndex(c => /impression/i.test(c));
  const ctrIdx = isJapanese
    ? header.split(',').findIndex(c => /CTR|クリック率/i.test(c))
    : header.split(',').findIndex(c => /ctr|CTR/);
  const posIdx = isJapanese
    ? header.split(',').findIndex(c => c.includes('掲載順位') || c.includes('順位'))
    : header.split(',').findIndex(c => /position/i.test(c));

  const results = [];
  const dataLines = lines.slice(1);

  for (let i = 0; i < dataLines.length; i++) {
    if (maxQueries > 0 && results.length >= maxQueries) break;

    // 簡易CSVパース（カンマ分割、引用符で囲まれたカンマは無視）
    const cols = parseCSVLine(dataLines[i]);

    const query = queryIdx >= 0 && queryIdx < cols.length ? cols[queryIdx].trim().replace(/^["']|["']$/g, '') : '';
    if (!query) continue;

    const clicks = clicksIdx >= 0 ? parseFloat(cols[clicksIdx].replace(/[^0-9.-]/g, '')) || 0 : 0;
    const impressions = imprIdx >= 0 ? parseFloat(cols[imprIdx].replace(/[^0-9.-]/g, '')) || 0 : 0;
    if (impressions < minImpressions) continue;

    const ctr = ctrIdx >= 0 ? parseFloat(cols[ctrIdx].replace(/[^0-9.]/g, '')) || 0 : (impressions > 0 ? (clicks / impressions * 100) : 0);
    const position = posIdx >= 0 ? parseFloat(cols[posIdx].replace(/[^0-9.]/g, '')) || 0 : 0;

    // クエリを意図分類
    const intent = classifyQueryIntent(query);
    const llmoScore = scoreLLMOQuery(query);

    results.push({
      query,
      clicks,
      impressions,
      ctr,
      position,
      intent,
      llmo_score: llmoScore,
      patterns: [],
    });
  }

  // LLMOスコア降順でソート
  results.sort((a, b) => b.llmo_score - a.llmo_score);
  return results;
}

/**
 * CSVの1行を簡易パース（引用符内のカンマを考慮）
 */
function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * 1つの検索クエリの意図を分類する
 * @param {string} query - 検索クエリ
 * @returns {string} intent - question / request / informational / transactional / navigational
 */
function classifyQueryIntent(query) {
  if (!query || typeof query !== 'string') return 'informational';
  if (!containsJapanese(query)) return 'informational';

  // 取引行動意図（transactional）を最初にチェック
  // 「買う」「注文」「申込」「予約」など購入・契約行動を示す語
  if (/(買う|購入|注文|オーダー|発注|カート|購入したい|注文したい|予約する|申し込む|エントリーする)/mu.test(query)) return 'transactional';

  // 疑問文として抽出可能なら question
  if (isQuestion(query)) return 'question';
  // 依頼文として抽出可能なら request
  if (isRequest(query)) return 'request';

  // 申込・応募・登録（accept/apply型）
  if (/(申込|応募|エントリー|登録|サインアップ|申し込み)/mu.test(query)) return 'transactional';

  // 会社名・サイト名を含むものは navigational
  if (/(サイト|公式|ホームページ|会社|企業|株式会社|オージャスト|orgiast|rebooth)/iu.test(query)) return 'navigational';

  return 'informational';
}

/**
 * クエリのLLM回答適性スコアを計算（0-10）
 * AI（ChatGPT/Gemini/Perplexity）が回答を生成しやすいクエリか
 * @param {string} query - 評価するクエリ
 * @returns {number} 0-10 のスコア（高いほどAI回答に適する）
 */
function scoreLLMOQuery(query) {
  if (!query || typeof query !== 'string') return 0;
  if (!containsJapanese(query)) return 0;

  let score = 0;
  let matchedTypes = [];

  // LLMOパターンにマッチ
  for (const pattern of LLMO_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(query)) {
      const weight = LLMO_WEIGHTS[pattern.llmo_type] || 0.5;
      score += pattern.priority * weight;
      matchedTypes.push(pattern.llmo_type);
    }
  }

  // 疑問文ボーナス（疑問文はLLM回答に非常に適する）
  if (isQuestion(query)) {
    score += 5;
    matchedTypes.push('question');
  }

  // 依頼文ボーナス
  if (isRequest(query)) {
    score += 3;
    matchedTypes.push('request');
  }

  // クエリ長に応じたボーナス（長文ほど具体的で回答しやすい傾向）
  if (query.length >= 15) score += 1;
  if (query.length >= 30) score += 1;

  // 0-10 にクランプ
  return Math.max(0, Math.min(10, score));
}

/**
 * GSCクエリのLLMO分析結果を生成する
 * @param {Array<GSCQuery>} gscQueries - importGSCQueries() の出力
 * @returns {object} 分析レポート
 */
function analyzeLLMOQueries(gscQueries) {
  if (!gscQueries || gscQueries.length === 0) {
    return {
      totalQueries: 0,
      byIntent: {},
      byLLMOScore: { high: 0, medium: 0, low: 0 },
      topOpportunities: [],
      contentIdeas: [],
      llmoDistribution: {},
    };
  }

  // 意図別集計
  const byIntent = {};
  // LLMO種別集計
  const byLLMOType = {};
  // スコア分布
  let high = 0, medium = 0, low = 0;

  for (const q of gscQueries) {
    byIntent[q.intent] = (byIntent[q.intent] || 0) + 1;
    if (q.llmo_score >= 7) high++;
    else if (q.llmo_score >= 4) medium++;
    else low++;

    // クエリのLLMOタイプも集計（LLMO_PATTERNSでマッチ）
    for (const pattern of LLMO_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(q.query)) {
        byLLMOType[pattern.llmo_type] = (byLLMOType[pattern.llmo_type] || 0) + 1;
      }
    }
  }

  // 上位の機会クエリ（LLMOスコア高＋インプレッション高＋ポジション低）
  const scored = gscQueries.map(q => ({
    ...q,
    opportunity_score: q.llmo_score * (q.impressions > 0 ? Math.min(3, 10 / Math.max(1, q.position)) : 0.5),
  }));
  scored.sort((a, b) => b.opportunity_score - a.opportunity_score);
  const topOpportunities = scored.slice(0, 20).map(q => ({
    query: q.query,
    llmo_score: q.llmo_score,
    intent: q.intent,
    clicks: q.clicks,
    impressions: q.impressions,
    position: q.position,
    opportunity_score: q.opportunity_score,
  }));

  // コンテンツアイデア生成
  const contentIdeas = generateContentIdeas(topOpportunities);

  return {
    totalQueries: gscQueries.length,
    byIntent,
    byLLMOScore: { high, medium, low },
    topOpportunities,
    contentIdeas,
    llmoDistribution: byLLMOType,
  };
}

/**
 * 上位機会クエリからコンテンツアイデアを生成
 * @param {Array} opportunities - 上位機会クエリ
 * @returns {Array<object>}
 */
function generateContentIdeas(opportunities) {
  const ideas = [];
  const seen = new Set();

  for (const opp of opportunities.slice(0, 10)) {
    // LLMOパターンにマッチしてアイデア生成
    let llmoType = null;
    for (const pattern of LLMO_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(opp.query)) {
        llmoType = pattern.llmo_type;
        break;
      }
    }
    if (!llmoType) continue;

    const contentType = {
      tutorial: '手順記事（How-to）',
      definition: '解説ページ（What-is）',
      comparison: '比較記事',
      recommendation: 'おすすめ記事',
      pricing: '料金・価格ページ',
      process: '手順ガイド',
      explanation: '理由解説記事',
      example: '事例ページ',
      timing: '時期ガイド',
      requirement: '条件・必要事項ページ',
    }[llmoType] || '情報ページ';

    const key = `${contentType}:${opp.query}`;
    if (seen.has(key)) continue;
    seen.add(key);

    ideas.push({
      query: opp.query,
      contentType,
      llmoType,
      priority: opp.llmo_score >= 7 ? 'high' : opp.llmo_score >= 4 ? 'medium' : 'low',
      estimatedValue: opp.llmo_score * Math.log10(Math.max(1, opp.impressions + opp.clicks)),
    });
  }

  return ideas;
}

/**
 * クエリタイプに応じた優先度係数を返す
 * 依頼文系（actionable） > 疑問文系（informational）
 */
function getTypePriority(type, patterns) {
  const maxPatternPrio = patterns.length > 0 ? Math.max(...patterns.map(p => p.priority)) : 0;
  if (type === 'request') return 10 + maxPatternPrio; // 依頼は基本10 + パターン優先度
  if (type === 'question') return maxPatternPrio; // 疑問はパターン優先度のみ
  return 0;
}

/**
 * サブタイプを判定する
 */
function determineSubtype(sentence, patterns, type) {
  const ids = patterns.map(p => p.id);

  // 依頼系サブタイプ
  if (type === 'request') {
    if (ids.some(id => id.includes('mitumori') || id.includes('price'))) return 'price_request';
    if (ids.some(id => id.includes('moushikomi') || id.includes('yoyaku'))) return 'application';
    if (ids.some(id => id.includes('soudan') || id.includes('toiawase'))) return 'consultation';
    if (ids.some(id => id.includes('kudasai') || id.includes('onegai'))) return 'general_request';
    if (ids.some(id => id.includes('souhin') || id.includes('contact'))) return 'contact_request';
    if (ids.some(id => id.includes('shiritai') || id.includes('tai'))) return 'desire';
    return 'request';
  }

  // 疑問系サブタイプ
  if (type === 'question') {
    if (ids.some(id => id.includes('price') || id.includes('how_many'))) return 'price_inquiry';
    if (ids.some(id => id.includes('when'))) return 'timing_inquiry';
    if (ids.some(id => id.includes('where'))) return 'location_inquiry';
    if (ids.some(id => id.includes('which'))) return 'selection_inquiry';
    if (ids.some(id => id.includes('why'))) return 'reason_inquiry';
    if (ids.some(id => id.includes('how'))) return 'method_inquiry';
    if (ids.some(id => id.includes('what'))) return 'definition_inquiry';
    if (ids.some(id => id.includes('who'))) return 'contact_inquiry';
    return 'question';
  }

  return 'unknown';
}

/**
 * 日本語テキストから疑問文・依頼文を抽出し、AIクエリとして構造化する
 */
export function extractQueries(text, options = {}) {
  const {
    includeDomainPatterns = true,
    minSentenceLength = 3,
    maxSentenceLength = 500,
  } = options;

  if (!text || typeof text !== 'string') {
    return { queries: [], summary: { total: 0, questions: 0, requests: 0, top_query: null } };
  }

  const sentences = splitSentences(text);
  const queries = [];

  for (const sentence of sentences) {
    if (sentence.length < minSentenceLength || sentence.length > maxSentenceLength) continue;
    // 日本語を含まない文（英語のみ等）はスキップ
    if (!containsJapanese(sentence)) continue;

    const questionPatterns = matchPatterns(sentence, QUESTION_PATTERNS);
    const requestPatterns = matchPatterns(sentence, REQUEST_PATTERNS);
    const domainPatterns = includeDomainPatterns ? matchDomainPatterns(sentence) : [];

    const isQ = questionPatterns.length > 0;
    const isR = requestPatterns.length > 0;

    // どちらにもマッチしない文はスキップ
    if (!isQ && !isR) continue;

    // 疑問と依頼の両方にマッチする場合は依頼として扱う（実用優先）
    const type = isR ? 'request' : 'question';
    const patterns = type === 'request' ? requestPatterns : questionPatterns;
    const allPatterns = [...patterns, ...domainPatterns];

    const query = {
      text: sentence,
      type,
      subtype: determineSubtype(sentence, allPatterns, type),
      patterns: allPatterns.map(p => p.id),
      domain: [...new Set(allPatterns.filter(p => p.domain).map(p => p.domain))],
      priority: getTypePriority(type, allPatterns),
      normalized: normalizeQuery(sentence),
    };

    queries.push(query);
  }

  // 優先度順にソート（降順）
  queries.sort((a, b) => b.priority - a.priority);

  const questions = queries.filter(q => q.type === 'question');
  const requests = queries.filter(q => q.type === 'request');

  return {
    queries,
    summary: {
      total: queries.length,
      questions: questions.length,
      requests: requests.length,
      top_query: queries.length > 0 ? queries[0].text : null,
    },
  };
}

// ============================================================
// サンプルテキスト（テスト・デモ用）
// ============================================================

export const SAMPLE_TEXT = `
展示会の出展を検討しています。ブースの見積もりはいくらですか？
3m×3mの小間を希望します。デザインの相談もしたいです。
搬入はいつから可能ですか？会場は東京ビッグサイトです。
通訳スタッフの手配は可能でしょうか。また、備品レンタルの料金表を送ってください。
初めての出展なので、何から始めればいいか教えてください。
予算は50万円程度です。追加オプションの価格も知りたいです。
`;

// ============================================================
// CLI エントリポイント
// ============================================================

function parseCliArgs(args) {
  const result = {
    text: null, file: null, json: false, sample: false, format: 'text',
    gsc: null, llmo: false, opportunity: false, minImp: 0, maxQ: 0,
  };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--text':
      case '-t':
        result.text = args[++i];
        break;
      case '--file':
      case '-f':
        result.file = args[++i];
        break;
      case '--json':
      case '-j':
        result.json = true;
        break;
      case '--sample':
      case '-s':
        result.sample = true;
        break;
      case '--format':
        result.format = args[++i];
        break;
      case '--gsc':
        result.gsc = args[++i];
        break;
      case '--llmo':
        result.llmo = true;
        break;
      case '--opportunity':
      case '-o':
        result.opportunity = true;
        break;
      case '--min-imp':
        result.minImp = parseInt(args[++i], 10) || 0;
        break;
      case '--max-q':
        result.maxQ = parseInt(args[++i], 10) || 0;
        break;
    }
  }
  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  // --- GSC CSV analysis mode ---
  if (args.gsc) {
    const csvText = fs.readFileSync(path.resolve(args.gsc), 'utf8');
    const queries = importGSCQueries(csvText, { minImpressions: args.minImp, maxQueries: args.maxQ });

    if (args.llmo || args.opportunity) {
      const analysis = analyzeLLMOQueries(queries);
      if (args.json) {
        console.log(JSON.stringify(analysis, null, 2));
      } else {
        console.log(`=== GSC LLMO Analysis ===`);
        console.log(`Total queries analyzed: ${analysis.totalQueries}`);
        console.log(`\n--- By Intent ---`);
        for (const [intent, count] of Object.entries(analysis.byIntent).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${intent}: ${count}`);
        }
        console.log(`\n--- LLMO Score Distribution ---`);
        console.log(`  High (7-10): ${analysis.byLLMOScore.high}`);
        console.log(`  Medium (4-6): ${analysis.byLLMOScore.medium}`);
        console.log(`  Low (0-3): ${analysis.byLLMOScore.low}`);

        if (analysis.topOpportunities.length > 0) {
          console.log(`\n--- Top AI Content Opportunities (LLMO score × Position) ---`);
          for (const opp of analysis.topOpportunities.slice(0, 10)) {
            console.log(`  [${opp.llmo_score.toFixed(1)}] ${opp.query}`);
            console.log(`     Intent: ${opp.intent} | Impr: ${opp.impressions} | Pos: ${opp.position.toFixed(1)}`);
          }
        }
        if (analysis.contentIdeas.length > 0) {
          console.log(`\n--- Recommended Content Types ---`);
          const byType = {};
          for (const idea of analysis.contentIdeas) {
            byType[idea.contentType] = (byType[idea.contentType] || 0) + 1;
          }
          for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
            console.log(`  ${type}: ${count}`);
          }
        }
      }
    } else {
      // GSC basic classification
      if (args.json) {
        console.log(JSON.stringify(queries.slice(0, args.maxQ || 100), null, 2));
      } else {
        console.log(`=== GSC Query Classification ===`);
        console.log(`Total: ${queries.length} queries (sorted by LLMO score)`);
        console.log('');
        for (const q of queries.slice(0, 20)) {
          console.log(`[${q.llmo_score.toFixed(1)}][${q.intent}] ${q.query}`);
          console.log(`   Clicks: ${q.clicks} | Impr: ${q.impressions} | Pos: ${q.position.toFixed(1)}`);
        }
      }
    }
    return;
  }

  // --- LLMO analysis of text input ---
  let text;

  if (args.sample) {
    text = SAMPLE_TEXT;
  } else if (args.file) {
    text = fs.readFileSync(path.resolve(args.file), 'utf8');
  } else if (args.text) {
    text = args.text;
  } else if (!process.stdin.isTTY) {
    // stdin from pipe
    text = await new Promise((resolve) => {
      let data = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { data += chunk; });
      process.stdin.on('end', () => resolve(data));
    });
  } else {
    // No input — show sample
    text = SAMPLE_TEXT;
  }

  if (args.llmo) {
    // LLMO analysis mode: score each extracted query for AI answerability
    const baseResult = extractQueries(text);
    const queriesWithLLMO = baseResult.queries.map(q => ({
      ...q,
      llmo_score: scoreLLMOQuery(q.text),
      llmo_patterns: matchPatterns(q.text, LLMO_PATTERNS).map(p => p.id),
    }));

    if (args.json) {
      console.log(JSON.stringify({ ...baseResult, queries: queriesWithLLMO }, null, 2));
    } else {
      console.log(`=== LLMO Analysis ===`);
      console.log(`Total: ${baseResult.summary.total} queries`);
      console.log('');
      for (const q of queriesWithLLMO) {
        const scoreBar = '█'.repeat(Math.round(q.llmo_score)) + '░'.repeat(10 - Math.round(q.llmo_score));
        console.log(`[${q.llmo_score.toFixed(1)}] ${scoreBar} ${q.text}`);
        console.log(`   Type: ${q.type}/${q.subtype} | LLMO patterns: ${q.llmo_patterns.join(', ') || '(none)'}`);
        console.log('');
      }
    }
    return;
  }

  const result = extractQueries(text);

  if (args.json || args.format === 'json') {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`=== AI Query Extraction Result ===`);
    console.log(`Total: ${result.summary.total} queries (${result.summary.questions} questions, ${result.summary.requests} requests)`);
    console.log(`Top query: ${result.summary.top_query}`);
    console.log('');

    if (result.queries.length === 0) {
      console.log('No queries extracted.');
      return;
    }

    for (const q of result.queries) {
      const typeIcon = q.type === 'request' ? '📋' : '❓';
      console.log(`${typeIcon} [${q.priority}] ${q.text}`);
      console.log(`   Type: ${q.type} / ${q.subtype}`);
      console.log(`   Normalized: ${q.normalized}`);
      if (q.domain.length > 0) console.log(`   Domain: ${q.domain.join(', ')}`);
      console.log('');
    }

    // カテゴリ別集計
    const byType = {};
    for (const q of result.queries) {
      const key = `${q.type}:${q.subtype}`;
      byType[key] = (byType[key] || 0) + 1;
    }
    console.log('=== By Category ===');
    for (const [key, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${key}: ${count}`);
    }
  }
}

// Allow both import and direct execution
if (process.argv[1] && (process.argv[1].endsWith('ai-query-extract.mjs') || process.argv[1].endsWith('ai-query-extract'))) {
  main().catch(e => {
    console.error('Error:', e.message);
    process.exit(1);
  });
}

export {
  QUESTION_PATTERNS,
  REQUEST_PATTERNS,
  DOMAIN_SPECIFIC_PATTERNS,
  LLMO_PATTERNS,
  importGSCQueries,
  classifyQueryIntent,
  scoreLLMOQuery,
  analyzeLLMOQueries,
};
