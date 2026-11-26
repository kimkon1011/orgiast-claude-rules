#!/usr/bin/env node

/**
 * ai-citation-content.mjs — AI引用最適化ツール（X-0056）
 *
 * MarkdownファイルのAI引用されやすさを分析・スコアリングする。
 * ブース事例ページの前倒しコンテンツ構造（front-loaded content）を評価する。
 *
 * 使い方:
 *   node tools/ai-citation-content.mjs analyze <file-path>
 *   node tools/ai-citation-content.mjs score <file-path>
 *   node tools/ai-citation-content.mjs restructure <file-path> [--in-place]
 *   node tools/ai-citation-content.mjs check <file-path>
 *   node tools/ai-citation-content.mjs --help
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 定数 ────────────────────────────────────────────────────────

const TARGET_NOUN_DENSITY = 20.6; // 目標固有名詞密度(%)
const DENSITY_TOLERANCE = 5; // 許容範囲(±%)
const EXIT_OK = 0;
const EXIT_NG = 1;

// ─── ヘルパー関数 ───────────────────────────────────────────────

/** ファイルを読み込む（存在確認含む） */
function readFile(filePath) {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const text = readFileSync(resolved, 'utf-8');
  if (text.trim().length === 0) {
    throw new Error(`File is empty: ${resolved}`);
  }
  return text;
}

/** テキストを段落に分割 */
function splitParagraphs(text) {
  return text.split(/\n\n+/).filter(p => p.trim().length > 0);
}

/** H2見出し（## で始まる行）を抽出 */
function extractH2Headings(text) {
  const re = /^##\s+(.+)$/gm;
  const headings = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    headings.push(m[1].trim());
  }
  return headings;
}

/** テキストの最初の1/3を取得 */
function getFirstThird(text) {
  const third = Math.ceil(text.length / 3);
  return text.slice(0, third);
}

/** 固有名詞を検出して配列で返す */
function extractProperNouns(text) {
  const tokens = tokenize(text);
  const nouns = new Set();

  for (const token of tokens) {
    // カタカナ語（2文字以上、ひらがな・漢字を含まない）
    if (/^[゠-ヿー・]{2,}$/.test(token) && !/^[぀-ゟ]/.test(token)) {
      // 一般的なカタカナ語（固有名詞でない可能性が高いもの）を除外
      if (!isCommonKatakana(token)) {
        nouns.add(token);
      }
      continue;
    }

    // 英単語（大文字始まりの2文字以上）
    if (/^[A-Z][a-zA-Z]{1,}(\.[A-Z][a-zA-Z]{1,})?$/.test(token)) {
      nouns.add(token);
      continue;
    }

    // 大文字の略語（2文字以上）
    if (/^[A-Z]{2,}$/.test(token)) {
      nouns.add(token);
      continue;
    }

    // 組織名パターンを含む
    if (/株式会社/.test(token) || /[（(]株[）)]/.test(token)) {
      nouns.add(token);
      continue;
    }

    // 「〜市」「〜区」「〜町」「〜村」「〜県」「〜大学」等の地名・組織
    if (/^.{2,}[市区町村県大学高校中学校]$/.test(token)) {
      nouns.add(token);
      continue;
    }

    // 英数字混合の固有名詞っぽいもの（B-1グランプリ 等）
    if (/^[A-Za-z0-9゠-ヿ]{2,}[-][゠-ヿ一-鿿]{2,}$/.test(token)) {
      nouns.add(token);
      continue;
    }
  }

  return [...nouns].sort();
}

/** 一般的なカタカナ語（固有名詞ではない）を除外 */
function isCommonKatakana(word) {
  const common = new Set([
    'システム', 'サービス', 'プロジェクト', 'デザイン', 'ソリューション',
    'イベント', 'スペース', 'マーケット', 'カンパニー', 'ビジネス',
    'パートナー', 'プラットフォーム', 'テクノロジー', 'ソフトウェア',
    'ハードウェア', 'ネットワーク', 'コミュニケーション', 'マーケティング',
    'プロモーション', 'オペレーション', 'マネジメント', 'コンサルティング',
    'インフラ', 'メンテナンス', 'インストール', 'シミュレーション',
    'サポート', 'コスト', 'タイム', 'スケジュール', 'ボリューム',
    'クオリティ', 'コントロール', 'プロセス', 'ファシリティ',
    'コンテンツ', 'バーチャル', 'ハイブリッド', 'オンライン', 'オフライン',
    'デジタル', 'アナログ', 'インタラクティブ', 'エクスペリエンス',
    'イノベーション', 'アプローチ', 'コンセプト', 'テーマ', 'イメージ',
    'ブランディング', 'ロゴ', 'カラー', 'マテリアル', 'ファブリック',
    'パネル', 'モジュール', 'コンポーネント', 'アクセサリー', 'オプション',
    'バリエーション', 'カスタマイズ', 'スタンダード', 'プレミアム', 'エコノミー',
    'ベーシック', 'アドバンスト', 'プロフェッショナル', 'エキスパート',
    'スペシャリスト', 'マネージャー', 'ディレクター', 'プランナー',
    'スタッフ', 'メンバー', 'リーダー', 'チーム', 'グループ',
    'インダストリー', 'セクター', 'フィールド', 'エリア', 'ゾーン',
    'セクション', 'カテゴリー', 'タイプ', 'フォーマット', 'バージョン',
    'フェーズ', 'ステップ', 'レベル', 'ステージ', 'ランク',
    'アワード', 'グランプリ', 'コンテスト', 'エントリー',
    'ボリューム', 'キャパシティ', 'サイズ', 'エリア', 'レイアウト',
    'ツール', 'アプリケーション', 'エンジン', 'フレームワーク',
    'プロトコル', 'インターフェース', 'データベース', 'アルゴリズム',
    'アーキテクチャ', 'インフラストラクチャ', 'プラットフォーム',
    'インサイト', 'アナリティクス', 'メトリクス', 'ベンチマーク',
    'スコア', 'レーティング', 'ランキング', 'ポジション',
    'プレゼンス', 'エンゲージメント', 'コンバージョン', 'リテンション',
    'アクイジション', 'モネタイゼーション', 'ユーティリティ',
    'ドキュメント', 'テンプレート', 'ガイドライン', 'マニュアル',
    'チュートリアル', 'ワークショップ', 'セミナー', 'ウェビナー',
    'カンファレンス', 'サミット', 'フォーラム', 'エキスポ', 'フェア',
    'オープニング', 'クロージング', 'セレモニー', 'レセプション',
    'ショーケース', 'デモンストレーション', 'プレゼンテーション',
    'インストール', 'セットアップ', 'コンフィギュレーション',
    'オーガナイズ', 'コーディネート', 'ファシリテート', 'オペレート',
    'ベンダー', 'サプライヤー', 'ディストリビューター', 'ディーラー',
    'エージェンシー', 'ファーム', 'オフィス', 'デスク',
    'アポイントメント', 'ミーティング', 'ブリーフィング', 'レビュー',
    'リサーチ', 'サーベイ', 'スタディ', 'アセスメント',
    'エバリュエーション', 'モニタリング', 'レポーティング',
    'フィードバック', 'フォローアップ', 'エスカレーション',
    'ドラフト', 'プルーフ', 'リビジョン', 'エディション',
    'インタビュー', 'ダイアログ', 'ディスカッション', 'ディベート',
    'コラボレーション', 'パートナーシップ', 'アライアンス',
    'コンソーシアム', 'ネットワーキング', 'アウトリーチ',
    'プロダクション', 'ポストプロダクション', 'プリプロダクション',
    'ストーリーボード', 'モックアップ', 'プロトタイプ',
    'インスペクション', 'テスト', 'バリデーション', 'ベリフィケーション',
    'コンプライアンス', 'ガバナンス', 'スタンダード',
    'パンフレット', 'カタログ', 'フライヤー', 'チラシ', 'ポスター',
    'バナー', 'サイネージ', 'ディスプレイ', 'モニター', 'スクリーン',
    'スピーカー', 'マイク', 'カメラ', 'プロジェクター',
    'オーディオ', 'ビジュアル', 'マルチメディア',
    'オフィシャル', 'プライベート', 'パブリック', 'エクスクルーシブ',
    'リミテッド', 'エディション', 'コレクション', 'シリーズ',
    'ギャラリー', 'ミュージアム', 'ライブラリー', 'アーカイブ',
    'テラス', 'バルコニー', 'ロビー', 'エントランス', 'ホワイエ',
    'ブレインストーミング', 'アイデアソン', 'ハッカソン',
    'メンタリング', 'コーチング', 'トレーニング', 'エデュケーション',
    'シナジー', 'バリューチェーン', 'サプライチェーン',
    'ステークホルダー', 'コンセンサス', 'イニシアチブ',
    'ミッション', 'ビジョン', 'バリュー', 'ゴール', 'ターゲット',
    'ベネフィット', 'アドバンテージ', 'ストレングス',
    'オポチュニティ', 'チャレンジ', 'リスク', 'インパクト',
    'アウトカム', 'アウトプット', 'インプット', 'スループット',
    'バジェット', 'ファンディング', 'インセンティブ',
    'モチベーション', 'イニシアチブ', 'エンゲージメント',
  ]);
  return common.has(word);
}

/** テキストをトークンに分割 */
function tokenize(text) {
  const tokens = [];
  // まず空白で分割
  const parts = text.split(/[\s　]+/);
  for (const part of parts) {
    if (!part) continue;
    // 句読点・記号で分割
    const sub = part.split(/[、。，．！？（）「」【】『』［］｛｝""''・:：;；,.\!?\(\)\[\]\{\}\<\>\/\\\|]/);
    for (const s of sub) {
      const t = s.trim();
      if (t.length === 0) continue;
      // さらに文字種の境界（カタカナ→ひらがな、カタカナ→漢字、英字→非英字等）で分割
      const charTypeTokens = splitByCharType(t);
      for (const ct of charTypeTokens) {
        const trimmed = ct.trim();
        if (trimmed.length > 0) tokens.push(trimmed);
      }
    }
  }
  return tokens;
}

/** 文字種の境界で分割（カタカナ・ひらがな・漢字・英字の境界） */
function splitByCharType(str) {
  const result = [];
  let current = '';
  let lastType = '';

  for (const ch of str) {
    let type = 'other';
    if (/[゠-ヿー]/.test(ch)) type = 'katakana'; // カタカナ・長音
    else if (/[぀-ゟ]/.test(ch)) type = 'hiragana'; // ひらがな
    else if (/[㐀-鿿豈-﫿]/.test(ch) || /[一-鿿]/.test(ch)) type = 'kanji'; // 漢字
    else if (/[a-zA-Z]/.test(ch)) type = 'alpha';
    else if (/[0-9]/.test(ch)) type = 'digit';

    if (current && type !== lastType && lastType !== '') {
      if (current.length > 0) result.push(current);
      current = ch;
    } else {
      current += ch;
    }
    lastType = type;
  }
  if (current.length > 0) result.push(current);
  return result;
}

/** 数値を検出して配列で返す */
function extractNumbers(text) {
  const numbers = [];
  // 数字+単位のパターン（万円、㎡、小間、週間、日、ヶ月、年、人、社、件、ページ、時間、分、秒、%等）
  const unitRe = /(\d+(?:[万億]?)(?:円|㎡|m2|小間|週間|週|日間|日|ヶ月|ヵ月|年|人|社|件|ページ|時間|分|秒|％|%|階|台|棟|室|席|脚|枚|個|本|冊|点|種|店|社|名|様))/g;
  let m;
  while ((m = unitRe.exec(text)) !== null) {
    numbers.push(m[1]);
  }
  // 単体の数字（3桁以上の数字、または金額っぽいもの）
  const digitRe = /(\d{3,}(?:万|億)?|(?:\d+万|\d+億|\d+千))/g;
  while ((m = digitRe.exec(text)) !== null) {
    const val = m[1];
    if (!numbers.includes(val)) {
      numbers.push(val);
    }
  }
  return [...new Set(numbers)];
}

/** 質問形式のH2見出しか判定 */
function isQuestionHeading(heading) {
  const questionWords = [
    '何', 'なぜ', 'どのよう', 'いくら', '誰', 'いつ', 'どこ',
    'どうして', 'どうやっ', '何故', 'どんな', 'どれ', 'どの',
    '何が', '何を', '何で',
  ];
  // 末尾が「？」または「?」
  if (/[？?]$/.test(heading)) return true;
  // 疑問詞を含む
  for (const qw of questionWords) {
    if (heading.includes(qw)) return true;
  }
  return false;
}

/** 控えめ表現のカウント */
function countHedgingExpressions(text) {
  const patterns = [
    /〜?と考えられます/g,
    /〜?の場合があります/g,
    /〜?かもしれません/g,
    /〜?と思われます/g,
    /〜?の可能性があります/g,
    /〜?と考えられる/g,
    /〜?と言えるかもしれません/g,
    /〜?かもしれませんが/g,
    /〜?の場合も/g,
    /〜?のケースが/g,
    /〜?と推測されます/g,
    /〜?と見られます/g,
    /〜?の恐れがあります/g,
    /〜?のおそれがあります/g,
  ];
  let count = 0;
  for (const re of patterns) {
    const matches = text.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

/** 断定的表現（です・ます・ました・である）のカウント */
function countAssertiveExpressions(text) {
  // まず控えめ表現を含む領域をマスクする（false positive防止）
  const hedgingRe = /〜?と考えられます|〜?の場合があります|〜?かもしれません|〜?と思われます|〜?の可能性があります|〜?と考えられる|〜?と言えるかもしれません|〜?かもしれませんが|〜?の場合も|〜?のケースが|〜?と推測されます|〜?と見られます|〜?の恐れがあります|〜?のおそれがあります/g;
  const masked = text.replace(hedgingRe, (m) => '■'.repeat(m.length));

  const patterns = [
    /です[。．\s]/g,
    /ます[。．\s]/g,
    /ました[。．\s]/g,
    /である[。．\s]/g,
    /です$/gm,
    /ます$/gm,
    /ました$/gm,
    /である$/gm,
  ];
  let count = 0;
  for (const re of patterns) {
    const matches = masked.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

// ─── スコアリング ────────────────────────────────────────────────

/**
 * 分析を実行しスコアを返す
 * @param {string} text - 分析対象のMarkdownテキスト
 * @returns {object} スコアと詳細情報
 */
function analyzeText(text) {
  const firstThird = getFirstThird(text);
  const properNouns = extractProperNouns(text);
  const firstThirdNouns = extractProperNouns(firstThird);
  const numbers = extractNumbers(text);
  const firstThirdNumbers = extractNumbers(firstThird);
  const headings = extractH2Headings(text);
  const questionHeadings = headings.filter(h => isQuestionHeading(h));
  const tokens = tokenize(text);
  const nounTypes = new Set(properNouns);
  // 密度は異なる語の数ではなく、固有名詞トークンの全出現数で計算する。
  const nounTokenCount = tokens.filter(token => nounTypes.has(token)).length;
  const nounDensity = tokens.length > 0
    ? (nounTokenCount / tokens.length) * 100
    : 0;

  // 1. front-loading (30点)
  let frontLoadScore = 0;
  const hasEnoughNouns = firstThirdNouns.length >= 3;
  const hasEnoughNumbers = firstThirdNumbers.length >= 2;
  if (hasEnoughNouns && hasEnoughNumbers) {
    frontLoadScore = 30;
  } else if (hasEnoughNouns || hasEnoughNumbers) {
    frontLoadScore = 15; // 片方だけ
  }

  // 2. question-headings (25点)
  let questionHeadingScore = 0;
  if (headings.length > 0) {
    questionHeadingScore = (questionHeadings.length / headings.length) * 25;
  } else {
    // H2がない場合は0点（ただし減点対象にはしない）
    questionHeadingScore = 0;
  }

  // 3. proper-noun-density (25点)
  let densityScore = 0;
  const diff = Math.abs(nounDensity - TARGET_NOUN_DENSITY);
  if (diff <= DENSITY_TOLERANCE) {
    densityScore = 25; // 満点
  } else {
    // 許容範囲外は比例減点（最大25点減）
    densityScore = Math.max(0, 25 - (diff - DENSITY_TOLERANCE) * 2);
  }

  // 4. assertive-language (20点)
  let assertiveScore = 0;
  const assertiveCount = countAssertiveExpressions(text);
  const hedgingCount = countHedgingExpressions(text);
  const totalMarkers = assertiveCount + hedgingCount;
  if (totalMarkers > 0) {
    const assertiveRatio = assertiveCount / totalMarkers;
    if (assertiveRatio >= 0.8) {
      assertiveScore = 20;
    } else if (assertiveRatio >= 0.6) {
      assertiveScore = 15;
    } else if (assertiveRatio >= 0.4) {
      assertiveScore = 10;
    } else if (assertiveRatio >= 0.2) {
      assertiveScore = 5;
    }
  } else {
    // どちらの表現もない場合は中間の10点
    assertiveScore = 10;
  }

  const total = Math.round(frontLoadScore + questionHeadingScore + densityScore + assertiveScore);

  // 冒頭1/3のテキスト（表示用）
  const frontLoadText = firstThird.slice(0, 150) + (firstThird.length > 150 ? '…' : '');

  return {
    scores: {
      'front-loading': Math.round(frontLoadScore),
      'question-headings': Math.round(questionHeadingScore),
      'proper-noun-density': Math.round(densityScore),
      'assertive-language': Math.round(assertiveScore),
      total: Math.min(100, Math.max(0, total)),
    },
    details: {
      properNouns,
      properNounCount: nounTokenCount,
      properNounDensity: Math.round(nounDensity * 10) / 10,
      questionHeadings,
      questionHeadingCount: questionHeadings.length,
      totalHeadings: headings.length,
      numbersFound: numbers,
      numbersFoundCount: numbers.length,
      firstThirdNouns: firstThirdNouns.length,
      firstThirdNumbers: firstThirdNumbers.length,
      frontLoadFirstThird: frontLoadText,
      assertiveCount,
      hedgingCount,
    },
  };
}

/**
 * ファイルが前倒し構造の要件を満たしているかチェック
 * @param {string} text - チェック対象のテキスト
 * @returns {object} チェック結果
 */
function checkFrontLoaded(text) {
  const result = analyzeText(text);
  const d = result.details;
  const s = result.scores;

  const checks = {
    '最初の1/3に固有名詞3つ以上': d.firstThirdNouns >= 3,
    '最初の1/3に数値2つ以上': d.firstThirdNumbers >= 2,
    'H2見出しが全て質問形式': d.totalHeadings > 0 && d.questionHeadingCount === d.totalHeadings,
    '固有名詞密度15%以上': d.properNounDensity >= 15,
    '断定的表現が控えめ表現より多い': d.assertiveCount > d.hedgingCount,
  };

  const allPassed = Object.values(checks).every(v => v === true);

  return {
    passed: allPassed,
    checks,
    score: s.total,
  };
}

// ─── リストラクチャリング ──────────────────────────────────────────

/** H2見出しを質問形式に変換（ルールベース） */
function convertHeadingToQuestion(heading) {
  if (isQuestionHeading(heading)) return heading;

  const rules = [
    { pattern: /^概要$/i, replace: 'この案件の概要は？' },
    { pattern: /^背景$/i, replace: 'この案件の背景と目的は？' },
    { pattern: /^目的$/i, replace: 'この案件の目的は？' },
    { pattern: /^課題$/i, replace: 'どのような課題があったのか？' },
    { pattern: /^提案内容$/i, replace: 'どのような提案をしたのか？' },
    { pattern: /^提案$/i, replace: 'どのような提案をしたのか？' },
    { pattern: /^デザイン$/i, replace: 'どのようなデザインを採用したのか？' },
    { pattern: /^ブースデザイン$/i, replace: 'どのようなブースを提案したのか？' },
    { pattern: /^ブース$/i, replace: 'どのようなブースを提案したのか？' },
    { pattern: /^施工$/i, replace: 'どのように施工したのか？' },
    { pattern: /^技術.?構成$/i, replace: '使用した技術・構成は？' },
    { pattern: /^使用技術$/i, replace: '使用した技術・素材は？' },
    { pattern: /^素材$/i, replace: '使用した技術・素材は？' },
    { pattern: /^使用.?素材$/i, replace: '使用した素材は？' },
    { pattern: /^スケジュール$/i, replace: '工期とスケジュールは？' },
    { pattern: /^工期$/i, replace: '工期と予算は？' },
    { pattern: /^予算$/i, replace: '工期と予算は？' },
    { pattern: /^費用$/i, replace: '工期と予算は？' },
    { pattern: /^コスト$/i, replace: 'コスト削減の施策は？' },
    { pattern: /^成果$/i, replace: 'この展示会の成果は？' },
    { pattern: /^結果$/i, replace: 'この展示会の成果は？' },
    { pattern: /^効果$/i, replace: 'どのような効果があったのか？' },
    { pattern: /^実績$/i, replace: '関連実績は？' },
    { pattern: /^関連実績$/i, replace: '関連実績は？' },
    { pattern: /^お問い合わせ$/i, replace: 'お問い合わせ・資料請求は？' },
    { pattern: /^まとめ$/i, replace: 'この案件のまとめは？' },
    { pattern: /^今後の展望$/i, replace: '今後の展望は？' },
    { pattern: /^展望$/i, replace: '今後の展望は？' },
    { pattern: /^問い合わせ$/i, replace: 'お問い合わせ・資料請求は？' },
    { pattern: /^クライアント.?情報$/i, replace: 'クライアント情報は？' },
    { pattern: /^会社情報$/i, replace: '会社情報は？' },
    { pattern: /^プロフィール$/i, replace: 'プロフィールは？' },
    { pattern: /^担当$/i, replace: '誰が担当したのか？' },
    { pattern: /^メンバー$/i, replace: 'プロジェクトメンバーは？' },
    { pattern: /^チーム$/i, replace: 'プロジェクトチームは？' },
    { pattern: /^協力会社$/i, replace: '協力会社は？' },
    { pattern: /^写真.?ギャラリー$|^ギャラリー$/i, replace: 'ブース写真ギャラリーは？' },
    { pattern: /^動画$/i, replace: '関連動画は？' },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(heading.trim())) {
      return `## ${rule.replace}`;
    }
  }

  // ルールにマッチしない場合は汎用変換
  return `## ${heading.trim()}とは何か？`;
}

/** 控えめ表現を断定的表現に置換 */
function replaceHedging(text) {
  const replacements = [
    [/と考えられます/g, 'です'],
    [/の場合があります/g, 'です'],
    [/かもしれません/g, 'ます'],
    [/と思われます/g, 'ます'],
    [/の可能性があります/g, 'です'],
    [/と考えられる/g, 'です'],
    [/と言えるかもしれません/g, 'です'],
    [/かもしれませんが/g, 'ますが'],
    [/の場合も/g, 'の場合も（実績あり）'],
    [/のケースが/g, 'の事例が'],
    [/と推測されます/g, 'です'],
    [/と見られます/g, 'です'],
    [/の恐れがあります/g, 'は避けられます'],
    [/のおそれがあります/g, 'は避けられます'],
  ];
  let result = text;
  for (const [pattern, replacement] of replacements) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** 最初の段落を要約段落に変換（簡易版） */
function restructureFirstParagraph(text, properNouns, numbers) {
  const paragraphs = splitParagraphs(text);
  if (paragraphs.length === 0) return text;

  const firstPara = paragraphs[0];
  // 既に引用ブロックで始まっている場合はスキップ
  if (/^>/.test(firstPara.trim())) return text;

  // 最初のH2を探す
  const h2Match = text.match(/^##\s+/m);
  const beforeH2 = h2Match ? text.slice(0, h2Match.index) : text;

  // 最初の段落（H2より前の最初の空行区切り）を特定
  const beforeParts = beforeH2.split(/\n\n+/);
  if (beforeParts.length === 0) return text;

  const leadText = beforeParts[0].trim();
  // マークダウンタイトル（# で始まる）の次の段落が対象
  const lines = text.split('\n');
  let firstContentParaIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#') && !line.startsWith('---') && !line.startsWith('>')) {
      firstContentParaIdx = i;
      break;
    }
  }

  if (firstContentParaIdx < 0) return text;

  // 既存の内容段落をベースに要約を作る
  const paraLines = [];
  let j = firstContentParaIdx;
  while (j < lines.length && lines[j].trim() !== '' && !lines[j].startsWith('#')) {
    paraLines.push(lines[j]);
    j++;
  }
  const originalPara = paraLines.join(' ').trim();

  // 要約段落を生成（固有名詞と数値を先頭に集める）
  const nounsUsed = properNouns.slice(0, 3).join('・');
  const numsUsed = numbers.slice(0, 3).join('、');
  let summary = originalPara;

  // 既に固有名詞と数値が含まれているかを確認
  const hasNouns = properNouns.slice(0, 3).every(n => originalPara.includes(n));
  const hasNums = numbers.slice(0, 2).every(n => originalPara.includes(n));

  if (!hasNouns || !hasNums) {
    // 補強
    const prefix = [];
    if (!hasNouns && nounsUsed) prefix.push(nounsUsed);
    if (!hasNums && numsUsed) prefix.push(numsUsed);
    if (prefix.length > 0) {
      summary = `${prefix.join('は')}。${originalPara}`;
    }
  }

  // 元のテキストを置き換え
  const before = lines.slice(0, firstContentParaIdx).join('\n');
  const after = lines.slice(j).join('\n');
  return `${before}\n${summary}\n${after}`;
}

/**
 * リストラクチャリングを実行
 * @param {string} text - 変換元テキスト
 * @returns {string} 変換後テキスト
 */
function restructureText(text) {
  let result = text;

  // 1. 固有名詞と数値を抽出
  const properNouns = extractProperNouns(text);
  const numbers = extractNumbers(text);

  // 2. H2見出しを質問形式に変換
  result = result.replace(/^##\s+(.+)$/gm, (match, heading) => {
    return convertHeadingToQuestion(heading);
  });

  // 3. 控えめ表現を置換
  result = replaceHedging(result);

  // 4. 最初の段落を要約段落に（簡易版）
  result = restructureFirstParagraph(result, properNouns, numbers);

  return result;
}

// ─── CLI ─────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
ai-citation-content.mjs — AI引用最適化ツール（X-0056）

使い方:
  node tools/ai-citation-content.mjs <サブコマンド> <file-path> [オプション]

サブコマンド:
  analyze <file-path>      MarkdownファイルのAI引用最適化スコアを分析
  score <file-path>        数値スコアのみを出力（CI連携用）
  restructure <file-path>  前倒しコンテンツ構造に再構成（--in-placeで上書き保存）
  check <file-path>        前倒し構造の要件を満たしているかチェック（終了コード0/1）
  --help                   このヘルプを表示

オプション:
  --in-place                restructure でファイルを直接上書き保存（デフォルトは標準出力）

例:
  node tools/ai-citation-content.mjs analyze booth-case.md
  node tools/ai-citation-content.mjs score booth-case.md
  node tools/ai-citation-content.mjs restructure booth-case.md
  node tools/ai-citation-content.mjs restructure booth-case.md --in-place
  node tools/ai-citation-content.mjs check booth-case.md
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    process.exit(EXIT_OK);
  }

  const subcommand = args[0];
  const filePath = args[1];
  const inPlace = args.includes('--in-place');

  if (!filePath && subcommand !== '--help') {
    console.error('Error: file path is required');
    process.exit(EXIT_NG);
  }

  try {
    switch (subcommand) {
      case 'analyze': {
        const text = readFile(filePath);
        const result = analyzeText(text);
        console.log(JSON.stringify({ file: filePath, ...result }, null, 2));
        break;
      }

      case 'score': {
        const text = readFile(filePath);
        const result = analyzeText(text);
        console.log(result.scores.total);
        break;
      }

      case 'restructure': {
        const text = readFile(filePath);
        const result = restructureText(text);
        if (inPlace) {
          writeFileSync(resolve(filePath), result, 'utf-8');
          console.log(`Updated: ${resolve(filePath)}`);
        } else {
          process.stdout.write(result);
        }
        break;
      }

      case 'check': {
        const text = readFile(filePath);
        const result = checkFrontLoaded(text);
        if (result.passed) {
          console.log(`PASS (score: ${result.score})`);
          process.exit(EXIT_OK);
        } else {
          console.log(`FAIL (score: ${result.score})`);
          for (const [check, passed] of Object.entries(result.checks)) {
            console.log(`  ${passed ? '✓' : '✗'} ${check}`);
          }
          process.exit(EXIT_NG);
        }
        break;
      }

      default:
        console.error(`Unknown subcommand: ${subcommand}`);
        showHelp();
        process.exit(EXIT_NG);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(EXIT_NG);
  }
}

// ─── エクスポート（テスト用） ──────────────────────────────────

export {
  analyzeText,
  checkFrontLoaded,
  restructureText,
  extractProperNouns,
  extractNumbers,
  isQuestionHeading,
  convertHeadingToQuestion,
  replaceHedging,
  countHedgingExpressions,
  countAssertiveExpressions,
  tokenize,
  extractH2Headings,
  getFirstThird,
};

// ─── エントリーポイント ──────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('ai-citation-content.mjs') || process.argv[1].endsWith('ai-citation-content'))) {
  main();
}
