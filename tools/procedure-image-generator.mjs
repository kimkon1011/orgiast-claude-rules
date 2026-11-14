#!/usr/bin/env node
/**
 * tools/procedure-image-generator.mjs
 * X-0028: Claude Code+Codexで手順画像自動生成
 *
 * 手順定義JSONを入力として、Codex用プロンプトやプレビューHTMLを生成する。
 * Codex実行環境で実際のスクリーンショット＋枠線＋番号付与まで自動化する。
 *
 * Usage:
 *   node tools/procedure-image-generator.mjs --init              # テンプレート生成
 *   node tools/procedure-image-generator.mjs --steps steps.json  # 全出力生成
 *   node tools/procedure-image-generator.mjs --steps steps.json --prompt  # Codex用プロンプトのみ
 *   node tools/procedure-image-generator.mjs --steps steps.json --output ./out  # HTML/CSS生成
 *   node tools/procedure-image-generator.mjs --steps steps.json --codex-steps  # ブーステンプレート
 *   node tools/procedure-image-generator.mjs --help              # ヘルプ
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/* ── 型定義 (JSDoc) ────────────────────────────────────────────── */

/**
 * @typedef {Object} Annotation
 * @property {'border'|'arrow'|'highlight'} type - 注釈の種類
 * @property {string} [selector] - CSSセレクタ
 * @property {string} [color] - 枠線の色（デフォルト: #e63946）
 * @property {string} [label] - 番号ラベル（例: "①"）
 * @property {string} [arrowFrom] - 矢印の始点説明
 * @property {string} [arrowTo] - 矢印の終点説明
 */

/**
 * @typedef {Object} Step
 * @property {number} id - ステップ番号
 * @property {string} title - ステップタイトル
 * @property {string} description - ステップの説明文
 * @property {string[]} [selectors] - 操作対象のCSSセレクタ（Codex用）
 * @property {Annotation[]} [annotations] - 画像注釈定義
 * @property {number} [estimatedMinutes] - 所要時間（分）
 */

/**
 * @typedef {Object} TargetConfig
 * @property {string} [app] - アプリケーション名
 * @property {string} [url] - 対象URL
 * @property {{ width: number, height: number }} [viewport] - ブラウザビューポート
 */

/**
 * @typedef {Object} ProcedureDefinition
 * @property {string} title - 手順書のタイトル
 * @property {string} description - 手順書の概要説明
 * @property {TargetConfig} [target] - 対象環境設定
 * @property {Step[]} steps - 手順ステップの配列
 * @property {number} [estimatedTotalMinutes] - 総所要時間（自動計算）
 */

/* ── テンプレート定義 ─────────────────────────────────────────── */

/** オージャスト標準ブース設営手順テンプレート */
const BOOTH_SETUP_STEPS = {
  title: 'オージャスト標準ブース設営手順（10ft小間）',
  description: '展示会ブース設営の基本ステップ。10ft×10ftの小間を想定。',
  target: {
    app: 'オージャスト管理画面',
    url: 'https://orgiast.jp/admin/booth-setup',
    viewport: { width: 1440, height: 900 }
  },
  steps: [
    { id: 1, title: '案件を開く', description: '管理画面トップから該当案件のカードをクリックして案件詳細画面を開く', selectors: ['.project-card:first-child'], estimatedMinutes: 1 },
    { id: 2, title: '設営予定日を確認', description: '案件詳細の「設営情報」セクションで予定日・時間・会場を確認する', selectors: ['#setup-info'], estimatedMinutes: 2 },
    { id: 3, title: '設営指示書をダウンロード', description: '「設営指示書」ボタンをクリックし、PDFをダウンロードする', selectors: ['.btn-download-setup'], estimatedMinutes: 3 },
    { id: 4, title: '備品リストを印刷', description: '「備品一覧」タブを開き、印刷アイコンからリストを印刷する', selectors: ["[data-tab='equipment']"], estimatedMinutes: 2 },
    { id: 5, title: '設営機材を搬入', description: '倉庫から指定された備品・機材をトラックに積み込み会場へ移動', estimatedMinutes: 10 },
    { id: 6, title: 'ブース骨組みを組立', description: 'アルミフレームを展開し、基本構造を組み立てる', estimatedMinutes: 15 },
    { id: 7, title: 'パネルを取り付け', description: 'デザインパネルを所定の位置に取り付ける', estimatedMinutes: 10 },
    { id: 8, title: '備品を配置', description: 'テーブル・椅子・照明・モニターをレイアウト図通りに配置', estimatedMinutes: 10 },
    { id: 9, title: '現場写真を撮影', description: '完成したブースの全景・各アングルの写真を撮影する', estimatedMinutes: 5 },
    { id: 10, title: '写真をアップロード', description: '撮影した写真を案件の「写真アップロード」エリアにドラッグ＆ドロップ', selectors: ['.photo-upload-zone'], estimatedMinutes: 3 }
  ]
};

/** オージャスト標準イベント準備手順テンプレート */
const EVENT_PREP_STEPS = {
  title: 'オージャスト標準イベント準備手順',
  description: '企業イベント（キックオフ・表彰式・パートナー会）の準備ステップ。',
  target: {
    app: 'Google Workspace + オージャスト管理画面',
    viewport: { width: 1440, height: 900 }
  },
  steps: [
    { id: 1, title: 'イベント概要を確認', description: '案件詳細でイベントの目的・予算・参加人数を確認する', estimatedMinutes: 3 },
    { id: 2, title: 'スプレッドシートを開く', description: 'イベント管理用スプレッドシートを開き、テンプレートを複製する', estimatedMinutes: 2 },
    { id: 3, title: '参加者リストを作成', description: '参加者シートで招待者一覧を入力する', estimatedMinutes: 5 },
    { id: 4, title: 'タイムテーブルを作成', description: 'タイムテーブルシートで各セッションの時間割を設定する', estimatedMinutes: 10 },
    { id: 5, title: '会場レイアウトを確認', description: '会場見取り図に席次・ステージ・備品を配置する', estimatedMinutes: 5 },
    { id: 6, title: '配布資料を準備', description: 'プログラム・名札・アンケート用紙を印刷・準備する', estimatedMinutes: 10 },
    { id: 7, title: '設営指示書を発行', description: '管理画面から設営スタッフ向け指示書を発行する', selectors: ['.btn-issue-setup'], estimatedMinutes: 3 },
    { id: 8, title: '最終確認', description: '全項目の準備状況をチェックリストで確認する', estimatedMinutes: 5 }
  ]
};

/** オージャスト標準撤収手順テンプレート */
const TEARDOWN_STEPS = {
  title: 'オージャスト標準撤収手順',
  description: '展示会終了後のブース撤収・備品返却手順。',
  steps: [
    { id: 1, title: '撤収開始を報告', description: '管理画面で撤収開始を報告する', selectors: ['.btn-teardown-start'] },
    { id: 2, title: '備品を片付ける', description: 'レンタル備品を所定のケースに収納する' },
    { id: 3, title: 'パネルを取下げ', description: 'デザインパネルを丁寧に取り外し、運搬用ケースに収納する' },
    { id: 4, title: 'ブース骨組みを解体', description: 'アルミフレームを分解し、運搬用ケースに収納する' },
    { id: 5, title: '廃棄物を分別', description: '廃材・一般ゴミ・リサイクルに分別して廃棄エリアへ運ぶ' },
    { id: 6, title: 'ゴミ処理完了写真を撮影', description: '清掃後の小間の写真とゴミ処理完了証を撮影する' },
    { id: 7, title: '撤収完了を報告', description: '管理画面で撤収完了を報告し、写真をアップロードする', selectors: ['.btn-teardown-complete', '.photo-upload-zone'] }
  ]
};

/* ── 手順定義の検証 ──────────────────────────────────────────── */

/**
 * 手順定義のバリデーション
 * @param {ProcedureDefinition} def
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateDefinition(def) {
  const errors = [];

  if (!def) { errors.push('手順定義がnullまたはundefinedです'); return { valid: false, errors }; }
  if (typeof def !== 'object') { errors.push('手順定義はオブジェクトである必要があります'); return { valid: false, errors }; }
  if (!def.title || typeof def.title !== 'string') errors.push('title: 必須の文字列');
  if (!def.description || typeof def.description !== 'string') errors.push('description: 必須の文字列');
  if (!Array.isArray(def.steps) || def.steps.length === 0) errors.push('steps: 1つ以上のステップが必要');
  if (def.steps) {
    for (const [i, step] of def.steps.entries()) {
      if (!step.title) errors.push(`steps[${i}].title: 必須`);
      if (!step.description) errors.push(`steps[${i}].description: 必須`);
      if (step.id == null || typeof step.id !== 'number') errors.push(`steps[${i}].id: 必須の数値`);
      if (step.selectors && !Array.isArray(step.selectors)) errors.push(`steps[${i}].selectors: 配列である必要があります`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/* ── HTML/CSS生成 ─────────────────────────────────────────────── */

/** 番号バッジ (①, ②, ... ⑳まで対応) */
const NUMBER_CIRCLES = [
  '①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩',
  '⑪','⑫','⑬','⑭','⑮','⑯','⑰','⑱','⑲','⑳'
];

/**
 * 数値を丸数字に変換
 * @param {number} n
 * @returns {string}
 */
function toCircledNumber(n) {
  if (n < 1 || n > 20) return `(${n})`;
  return NUMBER_CIRCLES[n - 1];
}

/**
 * 手順書のCSSを生成
 * @returns {string}
 */
function generateCSS() {
  return `/* X-0028 手順書スタイル (自動生成) */
@page { margin: 15mm 20mm; size: A4; }

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: 'Noto Sans JP', 'Hiragino Sans', 'Yu Gothic', sans-serif;
  color: #333;
  line-height: 1.7;
  max-width: 210mm;
  margin: 0 auto;
  padding: 20mm;
  background: #fff;
}

/* 表紙 */
.procedure-cover {
  text-align: center;
  padding: 60mm 0 40mm;
  page-break-after: always;
}
.procedure-cover h1 {
  font-size: 32px;
  font-weight: 700;
  color: #1a3a5c;
  margin-bottom: 16px;
  letter-spacing: 0.05em;
}
.procedure-cover .procedure-meta {
  font-size: 16px;
  color: #666;
  margin-bottom: 8px;
}
.procedure-cover .procedure-desc {
  font-size: 14px;
  color: #888;
  max-width: 360px;
  margin: 0 auto;
}

/* ステップ一覧 */
.procedure-steps {
  list-style: none;
  counter-reset: step-counter;
}

/* 各ステップ */
.step {
  position: relative;
  margin-bottom: 40px;
  padding: 20px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fafafa;
  page-break-inside: avoid;
  counter-increment: step-counter;
}

/* ステップ画像領域 */
.step-image-wrapper {
  position: relative;
  width: 100%;
  margin-bottom: 16px;
  border-radius: 4px;
  overflow: hidden;
  background: #f0f0f0;
  min-height: 200px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px dashed #d1d5db;
}
.step-image-wrapper img {
  width: 100%;
  height: auto;
  display: block;
}
.step-image-placeholder {
  color: #9ca3af;
  font-size: 14px;
  padding: 40px 20px;
  text-align: center;
}

/* 枠線オーバーレイアノテーション */
.step-image-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.annotation-border {
  position: absolute;
  border: 3px solid #e63946;
  border-radius: 4px;
  pointer-events: none;
}
.annotation-badge {
  position: absolute;
  top: -16px;
  left: -16px;
  width: 32px;
  height: 32px;
  background: #e63946;
  color: #fff;
  border-radius: 50%;
  font-size: 14px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
}

/* ステップ番号バッジ（左側固定） */
.step-number-badge {
  position: absolute;
  top: -12px;
  left: -12px;
  width: 40px;
  height: 40px;
  background: #e63946;
  color: #fff;
  border-radius: 50%;
  font-size: 18px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 2px 6px rgba(230,57,70,0.4);
  z-index: 10;
}

/* ステップ本文 */
.step-body { padding-left: 8px; }
.step-body h2 {
  font-size: 20px;
  font-weight: 700;
  color: #1a3a5c;
  margin-bottom: 8px;
}
.step-body p {
  font-size: 14px;
  color: #555;
  margin-bottom: 8px;
}
.step-meta {
  font-size: 12px;
  color: #9ca3af;
}

/* セレクタ情報 */
.step-selectors {
  margin-top: 8px;
  padding: 8px 12px;
  background: #f3f4f6;
  border-radius: 4px;
  font-size: 11px;
  font-family: 'SFMono-Regular', Consolas, monospace;
  color: #6b7280;
  overflow-x: auto;
}

/* 印刷設定 */
@media print {
  body { padding: 0; }
  .step { break-inside: avoid; border: 1px solid #ccc; }
  .step-image-wrapper { border: 1px solid #ccc; }
  .procedure-cover { padding-top: 80mm; }
}
`;
}

/**
 * 手順書HTMLを生成
 * @param {ProcedureDefinition} def
 * @returns {string} 完成したHTML
 */
export function generateHTML(def) {
  const totalSteps = def.steps.length;
  const totalMinutes = def.estimatedTotalMinutes ||
    def.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);

  const stepsHTML = def.steps.map((step, idx) => {
    const num = toCircledNumber(step.id);
    const selectorsHTML = step.selectors && step.selectors.length > 0
      ? `<div class="step-selectors">セレクタ: ${step.selectors.join(', ')}</div>`
      : '';
    const timeHTML = step.estimatedMinutes
      ? `<span class="step-meta">所要時間: 約${step.estimatedMinutes}分</span>`
      : '';

    return `<li class="step" id="step-${String(step.id).padStart(2, '0')}">
  <div class="step-number-badge" aria-label="ステップ${num}">${num}</div>
  <div class="step-image-wrapper">
    <img src="step-${String(step.id).padStart(2, '0')}.png" alt="${step.title}のスクリーンショット"
         onerror="this.parentElement.classList.add('no-image');this.style.display='none'" />
    <div class="step-image-placeholder" style="display:none">
      ⚡ Codex自動生成: ${step.title}<br>
      <small>スクリーンショット＋枠線＋番号を自動付与</small>
    </div>
    <div class="step-image-overlay"></div>
  </div>
  <div class="step-body">
    <h2>${step.title}</h2>
    <p>${step.description}</p>
    ${timeHTML}
    ${selectorsHTML}
  </div>
</li>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>手順書: ${escapeHTML(def.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;700&display=swap" rel="stylesheet" />
  <style>${generateCSS()}</style>
</head>
<body>

<div class="procedure-cover">
  <h1>${escapeHTML(def.title)}</h1>
  <p class="procedure-meta">全${totalSteps}ステップ | 所要時間: 約${totalMinutes}分</p>
  ${def.description ? `<p class="procedure-desc">${escapeHTML(def.description)}</p>` : ''}
</div>

<ol class="procedure-steps">
${stepsHTML}
</ol>

<script>
// 画像がない場合にプレースホルダを表示
document.querySelectorAll('.step-image-wrapper').forEach(wrapper => {
  const img = wrapper.querySelector('img');
  const placeholder = wrapper.querySelector('.step-image-placeholder');
  if (img && img.style.display === 'none' && placeholder) {
    placeholder.style.display = 'block';
  }
});
</script>
</body>
</html>`;
}

/**
 * HTMLエスケープ
 * @param {string} str
 * @returns {string}
 */
function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ── Codex用プロンプト生成 ──────────────────────────────────── */

/**
 * Codex委譲用プロンプトを生成
 * @param {ProcedureDefinition} def
 * @returns {string}
 */
export function generateCodexPrompt(def) {
  const hasSelectors = def.steps.some(s => s.selectors && s.selectors.length > 0);

  let selectorInstructions = '';
  if (hasSelectors) {
    selectorInstructions = `
## CSSセレクタによる枠線付与（Codex自動操作）
各ステップに指定されたCSSセレクタの要素をPuppeteer/Playwrightで特定し、
以下のルールで枠線と番号を付与してください:
- 赤枠: 2px solid #e63946 の矩形を該当要素にオーバーレイ
- 番号バッジ: 直径32pxの赤丸（#e63946）に白抜き数字。枠の左上に配置
- selectorsが複数ある場合は、操作順に枠線の色を変えるか、線種を変える`;
  }

  const stepsJSON = JSON.stringify(def.steps, null, 2);

  return `【X-0028: 手順画像自動生成】

以下の手順書の各ステップについて、操作画面のスクリーンショットを自動取得し、
枠線と番号バッジを付与した画像を生成してください。

## 手順書タイトル
${def.title}

## 手順定義（${def.steps.length}ステップ）
\`\`\`json
${stepsJSON}
\`\`\`
${selectorInstructions}

## 画像生成ルール（厳守）
1. **各ステップごと**に操作対象の画面をキャプチャ（Puppeteer/Playwright使用）
2. 操作箇所を**赤枠（2px solid #e63946）**で囲む
3. 枠線の左上に**番号バッジ（直径32pxの赤丸＋白抜き数字）**を配置
4. 画像**下部にステップタイトル＋説明**をキャプションとして追加
5. 枠線・番号は**画像編集ソフトで加工せず、コードでプログラム的に付与**
6. **画像は手で編集しない** — すべてプログラムで自動生成
7. 出力ファイル名: \`step-{id}.png\`（ゼロ埋め2桁、例: step-01.png）
8. 画像サイズは 1200×800px を基準とし、縦長画面は 800×1200px に調整

## 出力先
\`outputs/X-0028/<案件名>-<日時>/\`
- step-01.png 〜 step-NN.png
- procedure.html（生成した全画像を埋め込んだ手順書HTML — 本ツールの --output で生成済み）
- procedure.css（スタイル定義 — 本ツールの --output で生成済み）

## 品質要件
- 枠線は操作が必要な要素を正確に囲んでいること
- 番号バッジは視認性が高く、枠線と重ならない位置に配置
- 画像の解像度は十分に高く、文字が読めること
- 全画像で統一されたスタイル（枠線色・フォント・バッジサイズ）を維持
- 背景が白飛びしていないこと（適切な露光調整）
`;
}

/* ── ファイル出力 ────────────────────────────────────────────── */

/**
 * 手順書ファイル一式を出力
 * @param {ProcedureDefinition} def
 * @param {string} outputDir - 出力先ディレクトリ
 * @returns {{ htmlPath: string, cssPath: string }}
 */
export function writeProcedureFiles(def, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });

  const html = generateHTML(def);
  const htmlPath = path.join(outputDir, 'procedure.html');
  fs.writeFileSync(htmlPath, html, 'utf-8');

  const css = generateCSS();
  const cssPath = path.join(outputDir, 'procedure.css');
  fs.writeFileSync(cssPath, css, 'utf-8');

  // プレースホルダ画像（Codexが実際のスクショで上書きする）
  for (const step of def.steps) {
    const imgPlaceholder = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <rect width="1200" height="800" fill="#f3f4f6"/>
  <circle cx="600" cy="340" r="60" fill="#d1d5db"/>
  <rect x="440" y="440" width="320" height="4" rx="2" fill="#d1d5db"/>
  <rect x="480" y="460" width="240" height="4" rx="2" fill="#e5e7eb"/>
  <rect x="520" y="480" width="160" height="4" rx="2" fill="#e5e7eb"/>
  <text x="600" y="600" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#9ca3af">${escapeHTML(step.title)}</text>
  <text x="600" y="630" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#b0b7c3">Codex自動生成: スクリーンショット＋枠線＋番号</text>
</svg>`;
    const imgPath = path.join(outputDir, `step-${String(step.id).padStart(2, '0')}.svg`);
    fs.writeFileSync(imgPath, imgPlaceholder, 'utf-8');
  }

  return { htmlPath, cssPath };
}

/* ── テンプレートJSON生成 ────────────────────────────────────── */

/**
 * 空の手順定義テンプレートJSONを生成
 * @returns {ProcedureDefinition}
 */
export function generateTemplate() {
  return {
    title: '手順書のタイトル',
    description: '手順書の概要説明',
    target: {
      app: '対象アプリケーション名',
      viewport: { width: 1440, height: 900 }
    },
    steps: [
      { id: 1, title: 'ステップ1のタイトル', description: 'ステップ1の説明文', selectors: ['.css-selector'], estimatedMinutes: 5 },
      { id: 2, title: 'ステップ2のタイトル', description: 'ステップ2の説明文', estimatedMinutes: 10 }
    ],
    estimatedTotalMinutes: 15
  };
}

/* ── CLI ────────────────────────────────────────────────────────── */

function showHelp() {
  console.log(`
X-0028: Claude Code+Codexで手順画像自動生成

手順定義JSONを入力として、Codex用プロンプトやプレビューHTMLを生成。
Codex実行環境で実際のスクリーンショット＋枠線＋番号付与まで自動化。

Usage:
  node tools/procedure-image-generator.mjs [command]

Commands:
  --init                手順定義のテンプレートJSONを生成
  --steps <file>        手順定義JSONから全出力生成（--output必須）
  --steps <file> --prompt   Codex委譲用プロンプトのみ出力
  --steps <file> --output <dir>  HTML/CSS/プレースホルダを出力
  --codex-steps         オージャスト標準ブース設営テンプレートのCodexプロンプト
  --event-steps         オージャスト標準イベント準備テンプレートのプロンプト
  --teardown-steps      オージャスト標準撤収手順テンプレートのプロンプト
  --validate <file>     手順定義JSONのバリデーション
  --help                このヘルプ

Examples:
  node tools/procedure-image-generator.mjs --init > my-procedure.json
  node tools/procedure-image-generator.mjs --steps my-procedure.json --output ./output
  node tools/procedure-image-generator.mjs --steps my-procedure.json --prompt
  node tools/procedure-image-generator.mjs --codex-steps
  node tools/procedure-image-generator.mjs --validate my-procedure.json
  `);
}

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    showHelp();
    return;
  }

  // --init
  if (args.includes('--init')) {
    console.log(JSON.stringify(generateTemplate(), null, 2));
    return;
  }

  // --validate <file>
  const validateIdx = args.indexOf('--validate');
  if (validateIdx !== -1 && validateIdx + 1 < args.length) {
    const filePath = args[validateIdx + 1];
    if (!fs.existsSync(filePath)) {
      console.error(`エラー: ファイルが見つかりません: ${filePath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(filePath, 'utf-8');
    let def;
    try { def = JSON.parse(raw); } catch {
      console.error('エラー: JSONのパースに失敗しました');
      process.exit(1);
    }
    const { valid, errors } = validateDefinition(def);
    if (valid) {
      console.log(`✅ 定義は有効です（${def.steps.length}ステップ）`);
    } else {
      console.error('❌ バリデーションエラー:');
      errors.forEach(e => console.error(`  - ${e}`));
      process.exit(1);
    }
    return;
  }

  // テンプレート用のプロンプト出力
  if (args.includes('--codex-steps')) {
    console.log(generateCodexPrompt(BOOTH_SETUP_STEPS));
    return;
  }
  if (args.includes('--event-steps')) {
    console.log(generateCodexPrompt(EVENT_PREP_STEPS));
    return;
  }
  if (args.includes('--teardown-steps')) {
    console.log(generateCodexPrompt(TEARDOWN_STEPS));
    return;
  }

  // --steps <file>
  const stepsIdx = args.indexOf('--steps');
  if (stepsIdx === -1 || stepsIdx + 1 >= args.length) {
    console.error('エラー: --steps <file> が必要です');
    showHelp();
    process.exit(1);
  }

  const filePath = args[stepsIdx + 1];
  if (!fs.existsSync(filePath)) {
    console.error(`エラー: ファイルが見つかりません: ${filePath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  let def;
  try { def = JSON.parse(raw); } catch {
    console.error('エラー: JSONのパースに失敗しました');
    process.exit(1);
  }

  const { valid, errors } = validateDefinition(def);
  if (!valid) {
    console.error('❌ バリデーションエラー:');
    errors.forEach(e => console.error(`  - ${e}`));
    process.exit(1);
  }

  // --prompt (only)
  if (args.includes('--prompt')) {
    console.log(generateCodexPrompt(def));
    return;
  }

  // --output <dir>
  const outputIdx = args.indexOf('--output');
  if (outputIdx !== -1 && outputIdx + 1 < args.length) {
    const outputDir = args[outputIdx + 1];
    const { htmlPath, cssPath } = writeProcedureFiles(def, outputDir);
    console.log(`✅ 生成完了`);
    console.log(`  HTML: ${htmlPath}`);
    console.log(`  CSS:  ${cssPath}`);
    console.log(`  ステップ数: ${def.steps.length}（プレースホルダSVGを含む）`);
    return;
  }

  // フラグなし → 標準出力に全部出す
  console.log(generateCodexPrompt(def));
}

main();