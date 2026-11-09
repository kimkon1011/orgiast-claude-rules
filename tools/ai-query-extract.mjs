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
 * 業種特化パターン（展示会ブース・イベント業界向け）
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
  const result = { text: null, file: null, json: false, sample: false, format: 'text' };
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
    }
  }
  return result;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

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
};
