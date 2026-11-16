# Booth AI Lead App — Implementation Spec

## Overview
展示会ブース用リード獲得アプリ。バッジスキャン→会話録音→AIスコアリング→文字起こし→CRM連携→フォローアップメール。
株式会社オージャストの展示会ブースで使うプロトタイプ。

## Directory
`apps/booth-lead/`

## Files to Create

### 1. `index.html` — Main SPA
- シングルページアプリケーション
- ヘッダーにアプリタイトル「Booth AI Lead」と現在の展示会名
- 4つのタブで構成（タブ切り替え）

### 2. `style.css` — Styling
- モダンでクリーンなデザイン
- 展示会ブーススタッフが使いやすい大きめUI（タブレット対応）
- カラースキーム: 青系（プロフェッショナル）
- ダーク/ライト両対応

### 3. `app.js` — Application Logic

## Data Model
```javascript
// Lead
{
  id: "uuid",
  name: "string",
  company: "string",
  position: "string",
  email: "string",
  phone: "string",
  badgeScanMethod: "qr" | "manual",
  badgeScanTime: "ISO timestamp",
  conversationRecordings: [{ id, duration, createdAt }],
  transcription: "string",
  aiSummary: "string",
  leadScore: 0-100,
  leadCategory: "hot" | "warm" | "cold",
  interests: ["string"],
  notes: "string",
  followUpEmailBody: "string",
  crmPushed: false,
  crmPushTime: null | "ISO timestamp",
  createdAt: "ISO timestamp"
}
```

## Features by Tab

### Tab 1: Scan (スキャン)
- **QRコードスキャン**: html5-qrcodeライブラリ（CDN）でカメラ起動
- スキャン結果 → Leadフォーム自動入力
- **手動入力**: 名前・会社名・役職・メール・電話 を入力可能
- 「登録」ボタン → リード保存 + 自動スコアリング

### Tab 2: Dashboard (ダッシュボード)
- 現在の展示会の統計:
  - 総リード数
  - Hot/Warm/Cold 別カウント
  - 平均スコア
- リード一覧（テーブル表示）: 名前, 会社, スコア, カテゴリ, ステータス
- 各行クリック → 詳細パネル展開
- 検索フィルター（名前/会社）

### Tab 3: Conversation (会話)
- 録音ボタン（MediaRecorder API）
- リアルタイム文字起こし（Web Speech API: SpeechRecognition）
- AIサマリー生成（モックアルゴリズム: キーワード抽出 + 簡易スコアリング）
- スコアリング結果表示（0-100のゲージ）
- メモ追加入力

### Tab 4: Campaign (キャンペーン)
- **CRMエクスポート**: CSV / JSON ダウンロード
- **フォローアップメール生成**: リード情報 + 興味からテンプレート生成
- メールプレビュー
- 一括メールCSV出力（メールアドレスリスト）

## AI Features (Mock Implementation)

### Lead Scoring Algorithm
- Duration basis: 会話時間（秒）をスコア変換（30秒=20pt, 60秒=40pt, 120秒+=60pt）
- Interest basis: transcription からキーワード検出
  - 「見積」「導入」「予算」「デモ」→ +20pt
  - 「興味」「検討」「比較」→ +10pt
  - 「いいですね」「魅力的」→ +5pt
- Decision basis: 「決裁」「稟議」「上長」→ +15pt
- Category: hot(>=70), warm(40-69), cold(<40)

### Transcription Summary (Mock)
- transcription から最初の3文を抽出
- 名前・会社・興味・次のアクションを構造化

### Follow-up Email Template (Mock)
- リード情報 + 選んだテンプレートからメール本文生成
- テンプレート: お礼 / 資料送付 / デモ案内 / 見積依頼確認
- 件名 + 本文 + 署名 を生成

## Storage
- localStorage キー `booth-leads` に JSON 配列
- エクスポート機能（CSV/JSON ファイルダウンロード）
- インポート機能（JSON ファイル読み込み）

## Tech Stack
- Pure HTML/CSS/JS (no framework)
- html5-qrcode CDN (QRスキャン)
- Web Audio API + MediaRecorder (録音)
- Web Speech API (文字起こし)
- localStorage (データ保存)
- File API (エクスポート/インポート)

## Export CSV Format
```csv
id,name,company,position,email,phone,score,category,interests,notes,transcription,created_at
```

## Design Notes
- オージャストカラー: #1a73e8 (プライマリ)
- オージャストの展示会ブースでそのまま使えるように日本語UI
- タブレット（iPad）での操作を前提に大きめのボタン・フォント
- 録音中は赤いインジケーター表示
- QRスキャンボタンでカメラ切替（背面/前面）
- レスポンシブ対応（Desktop + Tablet）