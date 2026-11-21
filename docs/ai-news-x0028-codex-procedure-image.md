# X-0028: Claude Code+Codexで手順画像自動生成 — スクショ＋枠線＋番号を自動付与

> AIニュース提案 2026-11-15
> 対象: Claude Code + Codex による手順書解説画像の自動生成
>
> **目的**: Claude Code＋Codexにお願いするとスクショ＋枠線＋番号が自動で作られる。画像は自分でいじらない。オージャストでブース設営やイベント準備の手順書解説画像を自動生成し制作時間・コスト削減を試す。

## 概要

Codex に「この手順の各ステップをスクリーンショット＋枠線＋番号で図解して」と指示すると、Codex が各ステップごとに以下の画像生成を自動実行する:

| 要素 | 自動生成内容 |
|------|-------------|
| **スクリーンショット** | 各手順の該当作業画面をキャプチャ（ブラウザ/管理画面/アプリ） |
| **枠線（赤枠）** | 操作すべき箇所を視覚的に強調する矩形枠 |
| **番号（①②③）** | 手順順序を示す数字バッジを各枠線に付与 |
| **説明テキスト** | 各画像の下部にステップ説明を配置 |

**画像は人がいじらない** — すべての編集（切り抜き・枠線・番号・矢印）を Codex が自動実行する。

## 1. 現状の問題

| 問題 | 影響 |
|------|------|
| 手順書のスクショ撮影が手作業 | 各ステップで画面キャプチャ→切り抜き→保存の反復。1手順書で30〜60分 |
| 枠線・番号の付与が画像編集ソフト依存 | Photoshop/Illustratorの操作が必要。非デザイナーは作業できない |
| 修正時の再編集が手間 | 手順変更時にスクショの撮り直し＋枠線の付け直しが必要 |
| 複数ブース案件で手順書が共通化できない | 案件ごとにスクショを撮り直すため、共通手順でも再作成が必要 |
| 外注費の発生 | スクショ加工を外注すると1枚500〜1,000円、1手順書で5,000〜20,000円 |

## 2. 解決アプローチ: Claude Code + Codex での自動画像生成

### 2.1 全体フロー

```
[手順定義(YAML/JSON)]
  ├─ 各ステップ: タイトル・説明・操作対象の説明
  └─ 参照スクショ: 任意（無ければCodexが自動生成）
       ↓
[procedure-image-generator.mjs]
  ├─ 手順定義からCodex用プロンプトを生成
  ├─ ステップ画像生成HTMLテンプレートを出力
  └─ codex-doに委譲（実際のスクショ＋枠線＋番号）
       ↓
[Codex 自動実行]
  1. 各ステップの画面をキャプチャ（Puppeteer/Playwright）
  2. 操作箇所に赤枠をオーバーレイ
  3. 枠線に番号バッジ（白抜き数字＋赤丸）を付与
  4. 画像下部にステップ説明を配置
  5. 全ステップ画像を1枚の手順書HTMLにまとめて出力
       ↓
[出力]
  ├─ outputs/X-0028/<案件名>-<日時>/step-01.png ... step-NN.png
  ├─ outputs/X-0028/<案件名>-<日時>/procedure.html（全画像一覧）
  └─ outputs/X-0028/<案件名>-<日時>/procedure.pdf（印刷用）
```

### 2.2 ツール構成

```
tools/procedure-image-generator.mjs   # メインCLI
tools/procedure-image-generator.test.mjs  # テスト
templates/procedure-image/            # HTML/画像テンプレート
outputs/X-0028/                       # 生成物出力先
docs/ai-news-x0028-codex-procedure-image.md  # 本設計書
```

### 2.3 CLI 使い方

```bash
# 1. 手順テンプレートを生成（雛形作成）
node tools/procedure-image-generator.mjs --init > procedure-steps.json

# 2. 手順定義ファイルからCodexプロンプトを生成
node tools/procedure-image-generator.mjs --steps procedure-steps.json --prompt

# 3. 手順画像HTMLを生成（Codex無しでも確認可能なHTML出力）
node tools/procedure-image-generator.mjs --steps procedure-steps.json --output outputs/X-0028/booth-setup

# 4. Codex委譲を実行（スクリーンショット自動取得＋枠線番号付与）
codex-do "tools/procedure-image-generator.mjs --steps procedure-steps.json --execute" \
  --cwd "C:\Users\kimko\.claude\auto-session-repo"
```

## 3. 手順定義フォーマット

### 3.1 JSON定義例: ブース設営手順

```json
{
  "title": "オージャスト標準ブース設営手順",
  "description": "展示会ブース設営の基本ステップ（10ft×10ft 小間）",
  "target": {
    "app": "管理画面",
    "url": "https://orgiast.jp/admin/booth-setup",
    "viewport": { "width": 1440, "height": 900 }
  },
  "steps": [
    {
      "id": 1,
      "title": "案件を開く",
      "description": "管理画面トップから該当案件のカードをクリックして案件詳細画面を開く",
      "selectors": [".project-card:first-child", ".project-card .btn-open"],
      "annotations": [
        { "type": "border", "selector": ".project-card:first-child", "color": "#ff0000", "label": "①" }
      ]
    },
    {
      "id": 2,
      "title": "設営予定日を確認",
      "description": "案件詳細の「設営情報」セクションで予定日・時間・会場を確認する",
      "selectors": ["#setup-info", ".setup-date"],
      "annotations": [
        { "type": "border", "selector": "#setup-info", "color": "#ff0000", "label": "②" }
      ]
    },
    {
      "id": 3,
      "title": "設営指示書をダウンロード",
      "description": "「設営指示書」ボタンをクリックし、PDFをダウンロードする",
      "selectors": [".btn-download-setup"],
      "annotations": [
        { "type": "border", "selector": ".btn-download-setup", "color": "#ff0000", "label": "③" }
      ]
    },
    {
      "id": 4,
      "title": "備品リストを印刷",
      "description": "「備品一覧」タブを開き、印刷アイコンからリストを印刷する",
      "selectors": ["[data-tab='equipment']", ".btn-print"],
      "annotations": [
        { "type": "border", "selector": ".btn-print", "color": "#ff0000", "label": "④" }
      ]
    },
    {
      "id": 5,
      "title": "現場写真をアップロード",
      "description": "設営完了後、現場写真を「写真アップロード」エリアにドラッグ＆ドロップする",
      "selectors": [".photo-upload-zone"],
      "annotations": [
        { "type": "border", "selector": ".photo-upload-zone", "color": "#ff0000", "label": "⑤" }
      ]
    }
  ]
}
```

### 3.2 イベント準備手順例

```json
{
  "title": "オージャスト標準イベント準備手順",
  "description": "企業イベント（キックオフ・表彰式）の準備ステップ",
  "target": {
    "app": "Google Workspace",
    "viewport": { "width": 1440, "height": 900 }
  },
  "steps": [
    { "id": 1, "title": "スプレッドシートを開く", "description": "イベント管理用スプレッドシートを開く", "selectors": [".spreadsheet-title"] },
    { "id": 2, "title": "参加者リストを確認", "description": "参加者シートで登録者数を確認する", "selectors": ["[data-sheet='participants']"] },
    { "id": 3, "title": "タイムテーブルを編集", "description": "タイムテーブルシートで各セッションの時間割を調整する", "selectors": ["[data-sheet='timetable']"] }
  ]
}
```

## 4. ツールの生成するHTML出力

本ツールはCodexが実際のスクショを取得する前に、**ブラウザで確認できるHTML形式の手順書**も生成する。このHTMLは:

- 各ステップのタイトルと説明を視覚的に並べる
- 番号バッジ（①〜⑳）を自動割り振り
- 各ステップにダミーのスクショ領域（後でCodexが実画像に置換）を配置
- 印刷用CSSでPDF出力に対応

### 4.1 出力HTML構造

```html
<!DOCTYPE html>
<html>
<head>
  <title>手順書: オージャスト標準ブース設営手順</title>
  <link rel="stylesheet" href="procedure.css" />
</head>
<body>
  <div class="procedure-cover">
    <h1>オージャスト標準ブース設営手順</h1>
    <p class="procedure-meta">全5ステップ | 所要時間: 約30分</p>
  </div>
  <ol class="procedure-steps">
    <li class="step">
      <div class="step-number">①</div>
      <div class="step-image">
        <img src="step-01.png" alt="案件を開く" />
      </div>
      <div class="step-body">
        <h2>案件を開く</h2>
        <p>管理画面トップから該当案件のカードをクリックして案件詳細画面を開く</p>
      </div>
    </li>
    <!-- 各ステップ繰り返し -->
  </ol>
</body>
</html>
```

### 4.2 CSSスタイル（自動作成）

| 要素 | スタイル |
|------|---------|
| 全体 | A4縦レイアウト、max-width: 210mm、センタリング |
| 表紙 | タイトル大見出し＋案件情報＋ステップ数概要 |
| ステップ番号 | 直径40pxの赤丸（#e63946）に白抜き数字、position: absolute で画像左上に重ねる |
| 枠線 | 赤色2px dashed、必要に応じて画像内にCSSオーバーレイとして表示 |
| 説明文 | 画像下に16px/1.6行送り、グレー背景のボックス |
| 印刷対応 | `@media print { page-break-after: always; }`、フッターにページ番号 |

## 5. Codex 委譲プロンプト

本ツールが生成するCodex委譲用プロンプトの構造:

```
【X-0028: 手順画像自動生成】
以下の手順書の各ステップについて、スクリーンショットを自動取得し、
枠線＋番号バッジを付与した画像を生成してください。

手順定義: <steps.jsonの内容>

生成ルール:
1. 各ステップごとに、操作対象の画面をPuppeteerまたはPlaywrightで開く
2. 指定されたCSSセレクタの要素に赤枠（2px solid #e63946）をオーバーレイ
3. 枠線の左上に番号バッジ（直径32pxの赤丸に白抜き数字）を配置
4. 画像下部にステップタイトル＋説明をキャプションとして追加
5. 出力ファイル名: step-{id}.png（ゼロ埋め2桁）
6. 画像は自分で編集しない（枠線・番号はコードでプログラム的に付与）
7. 最終的に全ステップを1枚の手順書HTMLにまとめる

出力先: outputs/X-0028/<案件名>-<日時>/
```

## 6. オージャスト適用シナリオ

### 6.1 対象手順書

| 手順書種別 | 現状の制作時間 | Codex自動化後 | 削減率 |
|-----------|--------------|--------------|--------|
| ブース設営手順書（10ステップ） | 60〜90分 | 5〜10分 | ▲83〜89% |
| イベント準備手順書（15ステップ） | 90〜120分 | 10〜15分 | ▲83〜87% |
| 撤収手順書（8ステップ） | 45〜60分 | 5〜8分 | ▲87〜89% |
| 備品チェックリスト（20ステップ） | 120〜180分 | 15〜20分 | ▲83〜89% |
| 新入社員研修手順書（12ステップ） | 90分 | 10分 | ▲89% |

### 6.2 月間削減効果（見積もり）

| 案件数 | 手順書種別 | 月間発行数 | 削減時間/枚 | 月間削減時間 |
|--------|-----------|-----------|------------|-------------|
| 15件/月 | ブース設営手順書 | 15枚 | 55分 | 825分(13.8h) |
| 5件/月 | イベント準備手順書 | 5枚 | 80分 | 400分(6.7h) |
| 3件/月 | 撤収手順書 | 3枚 | 40分 | 120分(2.0h) |
| 10件/月 | 更新版手順書 | 10枚 | 30分 | 300分(5.0h) |
| **合計** | | **33枚/月** | | **1,645分(27.4h)** |

### 6.3 費用対効果

| 項目 | コスト |
|------|--------|
| Codex 1回実行費用（Puppeteer+画像処理含む） | $0.05〜0.20/手順書 |
| 手動制作の機会費用 | デザイナー単価3,000〜8,000円/時間 |
| 月間削減時間 | 27.4時間 |
| 月間削減コスト | 82,200〜219,200円 |
| Codex実行コスト | 33枚×$0.20 = $6.60（約990円） |
| ROI | 初週で回収可能 |

## 7. 制約・注意点

| 制約 | 影響と対策 |
|------|-----------|
| Puppeteer/Playwright が利用可能な環境が必要 | このPCではWSL不在だが、codex-do経由でCodex実行環境に委譲可能 |
| 対象アプリのURLとCSSセレクタの更新 | アプリ更新でセレクタが変わったら手順定義も更新が必要 |
| スクショの品質はブラウザ解像度に依存 | viewport指定で品質を統一（1440×900推奨） |
| 動画やアニメーションのキャプチャ | 静止画のみ対応。動画はX-0029（Gemini）と併用 |
| ログイン認証が必要な画面 | 事前にログインセッションを確保するか、テスト用ユーザーで実行 |
| Microsoft Edge / Chrome のヘッドレス | Puppeteer は Chromium バンドル、Playwright は各ブラウザのシステムインストールが必要 |

## 8. 実装計画

### Phase 1: ツール開発（今回の範囲）

| # | 作業 | ファイル | 内容 |
|---|------|---------|------|
| 1 | 設計書作成 | `docs/ai-news-x0028-codex-procedure-image.md` | 本ファイル |
| 2 | CLIツール実装 | `tools/procedure-image-generator.mjs` | JSON定義の読み込み・HTML生成・Codexプロンプト出力 |
| 3 | ユニットテスト | `tools/procedure-image-generator.test.mjs` | 定義パース・HTML出力・CSS生成のテスト |
| 4 | PR作成 | `pr-body-x0028.md` / `outputs/X-0028/` | プルリクエスト本文 |

### Phase 2: Codex連携検証（別セッション）

| # | 作業 | 内容 |
|---|------|------|
| 5 | codex-do委譲テスト | 実際にCodex環境が使えるPCでスクショ自動取得を検証 |
| 6 | 枠線・番号精度確認 | 生成画像の枠線位置・番号バッジの見やすさを評価 |
| 7 | 実用手順書テンプレート作成 | オージャスト標準ブース設営・撤収・イベント手順をテンプレート化 |

### Phase 3: 運用化（継続）

| # | 作業 | 頻度 |
|---|------|------|
| 8 | 手順定義テンプレートの拡充 | 月次 |
| 9 | セレクタのメンテナンス | アプリ更新時 |
| 10 | 生成画像のQAレビュー | 手順書発行ごと |

## 9. 検証方法

### 9.1 ツール単体検証

```bash
# 1. ヘルプ表示
node tools/procedure-image-generator.mjs --help

# 2. テンプレート生成
node tools/procedure-image-generator.mjs --init > outputs/X-0028/test-steps.json

# 3. HTML生成
node tools/procedure-image-generator.mjs \
  --steps outputs/X-0028/test-steps.json \
  --output outputs/X-0028/test-output

# 4. 生成物確認
ls outputs/X-0028/test-output/
# → procedure.html, procedure.css, step-*.png が生成されているか確認
```

### 9.2 ユニットテスト

```bash
node --test tools/procedure-image-generator.test.mjs
```

### 9.3 Codex連携検証（完了条件）

- 5ステップ以上の手順書で、各ステップに枠線・番号が正しく付与された画像が生成される
- 全画像が1枚の手順書HTMLにまとめられる
- 画像は手編集なしでCodexのみで完了している
- 出力ファイルは `outputs/X-0028/` 以下に保存される

## 10. 参考資料

- [Claude Code ドキュメント](https://docs.anthropic.com/en/docs/claude-code/overview)
- [Puppeteer 公式](https://pptr.dev/)
- [Playwright 公式](https://playwright.dev/)
- [X-0029: Geminiで作業動画から手順書自動生成](ai-news-x0029-gemini-video-to-manual.md) — 動画ベースの手順書生成（補完的アプローチ）
- [X-0027: Codex MCPでIllustrator作業5分自動化](ai-news-x0027-codex-mcp-illustrator-automation.md) — Illustratorグラフィック自動生成（画像生成の類似手法）