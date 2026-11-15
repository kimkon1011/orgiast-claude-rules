# Implementation Prompt: Booth AI Lead App

## Overview
Build a complete single-page application for trade show booth lead acquisition. Located at `apps/booth-lead/`.

## Files to Create

### 1. apps/booth-lead/README.md
- Documentation in Japanese
- Title: ブースAIリードアプリ
- 説明：展示会ブースでリード獲得を効率化するウェブアプリ
- 機能一覧：QRスキャン、会話録音、AIスコアリング、文字起こし、CRM連携、メールキャンペーン
- 使い方：4タブの説明
- 技術スタック：Pure HTML/CSS/JS, html5-qrcode, Web Speech API, MediaRecorder API

### 2. apps/booth-lead/index.html
Complete SPA with 4 tabs:
- **スキャン (Scan)**: QRコードスキャナー（html5-qrcode CDN）+ 手動入力フォーム
- **ダッシュボード (Dashboard)**: 統計 + リード一覧テーブル + 検索フィルター
- **会話 (Conversation)**: 録音・文字起こし・AIスコアリング・メモ
- **キャンペーン (Campaign)**: CRMエクスポート（CSV/JSON）、メールテンプレート生成、インポート

Include html5-qrcode from CDN: `https://unpkg.com/html5-qrcode`

### 3. apps/booth-lead/style.css
- モダンでクリーンなデザイン
- 色：プライマリ #1a73e8、アクセント #34a853、警告 #ea4335
- レスポンシブ（タブレット最適化）
- 大きめフォント・ボタン（ブーススタッフ用）
- 録音中赤いインジケーターアニメーション
- スコアゲージ（0-100）の色分け

### 4. apps/booth-lead/app.js
Complete application logic:

#### Data Model
```javascript
const LEAD_STORE_KEY = 'booth-leads';
const EXHIBITION_KEY = 'booth-exhibition';

// Lead: { id, name, company, position, email, phone, badgeScanMethod, badgeScanTime, conversationRecordings: [{id, duration, createdAt}], transcription, aiSummary, leadScore, leadCategory, interests, notes, followUpEmailBody, crmPushed, crmPushTime, createdAt }
```

#### Features
1. **QR Scanner**: Initialize html5-qrcode scanner, parse result into form fields, support camera switch
2. **Manual Input**: Form with name, company, position, email, phone fields with validation
3. **Lead Registration**: Save to localStorage, compute initial score (cold=10), render dashboard
4. **Dashboard**: 
   - Stats cards (total, hot/warm/cold counts, avg score)
   - Lead table sorted by score desc
   - Search by name/company
   - Click row to expand detail panel with full info + edit notes
5. **Recording**:
   - MediaRecorder wrapper with start/stop/pause
   - Audio visualization (simple canvas meter)
   - Recording timer display
   - Save recording reference (blob URL for playback)
6. **Transcription**:
   - Web Speech API (SpeechRecognition) with interim results
   - Display in real-time
   - Save transcription when stopped
7. **AI Scoring**: 
   - Algorithm: duration(sec) → 0-60pt + keyword detection from transcription → 0-40pt
   - Keywords for +20: 見積, 導入, 予算, デモ, PO, 発注
   - Keywords for +10: 興味, 検討, 比較, 評価, パイロット
   - Keywords for +5: いいですね, 魅力的, 素晴らしい, 使いたい
   - Decision keywords +15: 決裁, 稟議, 上長, 役員, 承認
   - Category: hot(>=70), warm(40-69), cold(<40)
8. **AI Summary** (mock):
   - Extract first 3 meaningful sentences from transcription
   - Structure as: { overview, interests, nextActions }
9. **CRM Export**:
   - CSV download with headers: id,name,company,position,email,phone,score,category,interests,notes,transcription,created_at
   - JSON download (full lead data)
   - JSON import (file upload → merge into localStorage)
10. **Email Templates**:
    - Templates: お礼 / 資料送付 / デモ案内 / 見積確認
    - Generate personalized email body using lead info and selected template
    - Preview in modal
    - Copy to clipboard button
    - Export as CSV (email list) and TXT (individual emails)

#### UI States
- Loading/Empty/Error states for all components
- Camera permission denied → show manual input fallback
- Microphone permission denied → show text-only mode
- Speech recognition not supported → show manual transcription input
- localStorage save success/failure notifications

## Quality Requirements
- All Japanese UI text
- Error boundaries for all async operations
- Clean, commented code
- No external dependencies except html5-qrcode CDN
- Proper cleanup (stop camera, stop recording on tab close)
- Touch-friendly (min 44px tap targets)
- Accessible (aria labels on interactive elements)

## File encoding
UTF-8 without BOM. LF line endings.