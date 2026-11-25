#!/usr/bin/env node
/**
 * tools/screenshot-website-builder.mjs
 * X-0014: スクショからAIウェブサイト生成 — WorkBuddy 投入用プロンプト生成CLI
 *
 * Usage:
 *   node tools/screenshot-website-builder.mjs --help
 *   node tools/screenshot-website-builder.mjs --list-usecases
 *   node tools/screenshot-website-builder.mjs --usecase booth-lp
 *   node tools/screenshot-website-builder.mjs --usecase event-page --mode scaffold
 *   node tools/screenshot-website-builder.mjs --custom '{"structure":"header+2col+footer","brand":"blue"}' --mode full
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ── テンプレート定義 ─────────────────────────────────────── */

/**
 * @typedef {Object} UseCase
 * @property {string} id
 * @property {string} title
 * @property {string} description
 * @property {string} screenshotDesc  - スクショの説明（アップロード時の参考）
 * @property {string} structure
 * @property {string} brand
 * @property {string} layout
 * @property {string} interactive
 * @property {string[]} components
 * @property {string} techStack
 */

/** @type {UseCase[]} */
const USE_CASES = [
  {
    id: 'booth-lp',
    title: '標準ブース提案ランディングページ',
    description: '展示会ブースの写真やレイアウト図のスクショから提案先用LPを生成',
    screenshotDesc: 'ブース全景写真、レイアウト平面図、過去提案書のスクリーンショットをアップロード',
    structure: 'hero section（ブース写真）+ about（会社概要）+ gallery（施工実績ギャラリー 3×3グリッド）+ features（ブース特徴3カラム）+ cta（お問い合わせ導線）の単一縦積み',
    brand: 'オージャストブランド: メインカラー #1a3a5c（紺）・アクセント #e8a838（金）・ベース #f8f6f2（白）・フォント Noto Sans JP 見出し700/本文400',
    layout: 'デスクトップ: 1200pxセンター固定・タブレット: 1段組+マージン調整・モバイル: 全面1段組+ハンバーガーメニュー',
    interactive: 'hero: パララックス背景スクロール・gallery: ホバー拡大+クリックライトボックス・cta: スムーススクロールアンカー',
    components: [
      'ヘッダー（ロゴ＋ナビゲーション4項目＋CTAボタン）',
      'Heroセクション（フル幅背景画像＋キャッチコピー＋サブテキスト＋CTA）',
      'Aboutセクション（会社紹介＋数値実績カウンター）',
      'ギャラリーグリッド（3列、フィルタータブ付き）',
      '特徴3カラム（アイコン＋見出し＋説明文）',
      'CTAセクション（背景画像＋ボタン）',
      'フッター（会社情報＋リンク＋SNS）'
    ],
    techStack: 'HTML5 + Tailwind CSS v4 + Vanilla JS（ライトボックス自作）、Google Fonts Noto Sans JP、レスポンシブデザイン（CSS Grid + Flexbox）'
  },
  {
    id: 'event-page',
    title: 'イベント詳細ページ',
    description: '過去イベント名刺やフライヤーのスキャンから出展情報ページを生成',
    screenshotDesc: 'イベントフライヤー、名刺、過去の出展案内のスキャン/スクショをアップロード',
    structure: 'event-header（タイトル+日時+会場）+ overview（イベント概要）+ schedule（タイムテーブル）+ map（アクセスマップ）+ gallery（過去出展写真）+ register（参加申込フォーム）',
    brand: 'イベントごとのテーマカラー可変・デフォルト #2d5d8c（青）・#e8833a（橙）アクセント・本文 #333',
    layout: 'シングルカラム、タイムテーブルはデスクトップ横スクロール表・モバイル縦積み',
    interactive: 'タイムテーブル行ホバー色変・マップはGoogle Maps埋め込み・フォームはリアルタイムバリデーション',
    components: [
      'イベントヘッダー（日時/会場/タイトル、背景グラデーション）',
      '概要セクション（テキスト+キービジュアル）',
      'タイムテーブル（時間・セッション名・登壇者）',
      'アクセスマップ（埋め込みiframe）',
      'フォトギャラリー（Carouselスライダー）',
      '参加申込フォーム（会社名/氏名/メール/電話/備考）',
      'フッター（主催者情報+プライバシーリンク）'
    ],
    techStack: 'HTML5 + Tailwind CSS + Vanilla JS、Google Maps Embed API、フォームバリデーション自作'
  },
  {
    id: 'portfolio',
    title: '会社概要・実績紹介ギャラリー',
    description: 'パンフレットスキャンから施工実績一覧ページを生成',
    screenshotDesc: '会社パンフレット、施工事例カタログのスキャン/スクショをアップロード',
    structure: 'gallery-header（タイトル+絞り込み）+ grid（実績カードグリッド）+ detail（カードクリックでモーダル詳細）+ contact（お問い合わせ導線）',
    brand: '白ベース #fff・グレー #f5f5f5背景・アクセント #c41e3a（赤）・フォント strict ゴシック体',
    layout: 'デスクトップ: 4列グリッド・タブレット: 3列・モバイル: 2列',
    interactive: 'カード: ホバーで影・クリックでモーダル詳細表示・フィルター: タブ切り替え（すべて/展示会/イベント/その他）',
    components: [
      'ギャラリーヘッダー（タイトル＋フィルタータブ）',
      '実績カードグリッド（サムネイル+タイトル+日付+カテゴリタグ）',
      '詳細モーダル（画像+説明+納期+クライアント名）',
      'お問い合わせ導線（フローティングCTA or セクション）',
      'ページネーション（10件ごと）'
    ],
    techStack: 'HTML5 + Tailwind CSS + Vanilla JS、モーダル自作（アクセシブル）'
  },
  {
    id: 'contact-form',
    title: 'レスポンシブお問い合わせフォーム',
    description: '既存Webのフォームスクショを元にしたレスポンシブ問合せフォーム',
    screenshotDesc: '既存サイトのお問い合わせフォームのスクリーンショットをアップロード',
    structure: 'form-header（タイトル+案内）+ form-fields（入力欄）+ submit（送信ボタン+プライバシー同意）+ thank-you（送信後メッセージ）',
    brand: 'オージャスト標準: 紺 #1a3a5c ボーダー・エラー時赤・成功時緑',
    layout: 'デスクトップ: 2段組（氏名/会社/メール等）・モバイル: 1段組全幅',
    interactive: 'リアルタイムバリデーション・エラー表示インライン・送信中ローディングアニメーション・送信完了トースト',
    components: [
      'フォームヘッダー（タイトル＋必須説明）',
      '入力フィールド（会社名/氏名/メール/電話/件名/本文/資料請求チェック）',
      'プライバシーポリシー同意チェックボックス',
      '送信ボタン（ホバー色変＋押下ローディング）',
      'バリデーションエラー表示（各フィールド直下）',
      '送信完了ページ/トースト'
    ],
    techStack: 'HTML5 + Tailwind CSS + Vanilla JS、Fetch API（フォーム送信）、スパム対策 Honeypot + レート制限'
  },
  {
    id: 'comparison-table',
    title: '複数ブース比較表',
    description: 'Excel/PDFの比較表からソート・フィルター付きテーブルを生成',
    screenshotDesc: 'Excelの比較表、PDF見積比較のスクリーンショットをアップロード',
    structure: 'table-header（タイトル+フィルター）+ table（比較表）+ detail-row（行クリック展開詳細）',
    brand: 'クリーン: #fff背景・#333文字・#e5e7eb 縞々行・#2563eb ソート矢印',
    layout: 'デスクトップ: 全項目表示・タブレット: 横スクロールテーブル・モバイル: カード型表示切り替え',
    interactive: '列ヘッダークリックでソート・カテゴリドロップダウンフィルター・行クリックで詳細展開・「カード表示/表表示」切替',
    components: [
      '検索＋フィルターバー（キーワード＋カテゴリ絞り込み）',
      '比較テーブル（プラン名/サイズ/価格/特徴/備考列）',
      'ソートインジケーター（昇順/降順矢印）',
      '行展開詳細（クリックで追加情報表示）',
      'ビュー切替ボタン（表形式/カード形式）',
      'エクスポートボタン（CSVダウンロード）'
    ],
    techStack: 'HTML5 + Tailwind CSS + Vanilla JS（sortable table 自作）、ダウンロードは Blob + a.download'
  }
];

/* ── プロンプト生成 ─────────────────────────────────────────── */

/**
 * @param {UseCase} useCase
 * @param {'scaffold'|'full'} mode
 * @returns {string}
 */
function buildPrompt(useCase, mode = 'full') {
  const scaffoldSection = mode === 'scaffold' ? `
## 生成スコープ（スキャフォールドのみ）
- HTML 骨格構造のみ（header/main/footer）
- Tailwind CSS クラス未適用の素のマークアップ
- JavaScript は含めない
- コメントで各セクションの目的を記述
` : '';

  return `# WorkBuddy スクショ生成プロンプト

## スクリーンショット参照
${useCase.screenshotDesc}

## ユースケース
${useCase.title} — ${useCase.description}
${scaffoldSection}
## 構造指定
${useCase.structure}

## ブランド指定
${useCase.brand}

## レイアウト指定
${useCase.layout}

## インタラクティブ要素
${useCase.interactive}

## コンポーネント一覧
${useCase.components.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## 技術スタック
${useCase.techStack}

## 出力形式
- 1 HTML ファイル（インラインCSS+JS または 外部ファイル構成）
- レスポンシブ対応
- アクセシビリティ対応（ARIAラベル・alt属性・コントラスト比）
- 日本語テキストは実際のコンテンツで記入（プレースホルダー不可）
`;
}

/* ── CLI ─────────────────────────────────────────────────────── */

function showHelp() {
  console.log(`
X-0014: スクショからAIウェブサイト生成 — WorkBuddy プロンプト生成ツール

Usage:
  node tools/screenshot-website-builder.mjs <command> [options]

Commands:
  --list-usecases          利用可能なユースケース一覧を表示
  --usecase <id>           指定したユースケースのプロンプトを表示
  --custom '<json>'        カスタム設定でプロンプトを生成
  --mode <scaffold|full>   scaffold: 骨格のみ / full: 完全版（既定）
  --help                   このヘルプ

Use cases:
${USE_CASES.map(u => `  ${u.id.padEnd(20)} ${u.title}`).join('\n')}

Examples:
  node tools/screenshot-website-builder.mjs --usecase booth-lp
  node tools/screenshot-website-builder.mjs --usecase event-page --mode scaffold
  node tools/screenshot-website-builder.mjs --list-usecases
  `);
}

function listUseCases() {
  console.log(JSON.stringify(USE_CASES.map(u => ({
    id: u.id,
    title: u.title,
    description: u.description,
    components: u.components.length,
    techStack: u.techStack.split(',')[0].trim()
  })), null, 2));
}

function handleUseCase(id, mode) {
  const uc = USE_CASES.find(u => u.id === id);
  if (!uc) {
    console.error(`エラー: ユースケース "${id}" は見つかりません。--list-usecases で一覧を確認してください。`);
    process.exit(1);
  }
  console.log(buildPrompt(uc, mode));
}

function handleCustom(jsonStr, mode) {
  let custom;
  try {
    custom = JSON.parse(jsonStr);
  } catch {
    console.error('エラー: --custom には有効なJSONを指定してください。');
    process.exit(1);
  }

  /** @type {UseCase} */
  const uc = {
    id: 'custom',
    title: custom.title || 'カスタムページ',
    description: custom.description || '',
    screenshotDesc: custom.screenshotDesc || 'カスタムスクリーンショットをアップロード',
    structure: custom.structure || 'header + main + footer',
    brand: custom.brand || '未指定',
    layout: custom.layout || 'レスポンシブ',
    interactive: custom.interactive || '未指定',
    components: custom.components || ['コンポーネントを指定してください'],
    techStack: custom.techStack || 'HTML5 + CSS + JS'
  };
  console.log(buildPrompt(uc, mode));
}

/* ── エントリポイント ────────────────────────────────────── */

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    showHelp();
    return;
  }

  const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'full';
  const mode = (modeArg === 'scaffold') ? 'scaffold' : 'full';

  if (args.includes('--list-usecases')) {
    listUseCases();
    return;
  }

  const usecaseIdx = args.indexOf('--usecase');
  if (usecaseIdx !== -1 && usecaseIdx + 1 < args.length) {
    handleUseCase(args[usecaseIdx + 1], mode);
    return;
  }

  const customIdx = args.indexOf('--custom');
  if (customIdx !== -1 && customIdx + 1 < args.length) {
    handleCustom(args[customIdx + 1], mode);
    return;
  }

  showHelp();
}

main();