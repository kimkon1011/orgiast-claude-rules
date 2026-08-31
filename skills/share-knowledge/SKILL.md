---
name: share-knowledge
description: セッション中に確立した Claude Code 開発ノウハウ・ルール・失敗パターンを、全アカウント共通ハブ（Drive claude-common-rules/knowledge-inbox）へ投稿する。「このノウハウ共有して」「全社ルールにして」「他のアカウントにも適用して」「共通化して」「seisaku-team でも使えるように」と言われた時、または全アカウントに適用すべき feedback を memory に保存した時に必ずこのスキルを使う。
---

# share-knowledge — ノウハウの上り投稿

投稿先: `knowledge-inbox` folder `1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2`（Drive ハブ claude-common-rules 配下）

## 手順
1. 投稿内容を下記フォーマットに整形（1投稿 = 1ノウハウ。複数あればファイルを分ける）
2. Drive MCP `create_file`:
   - parentId: `1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2`
   - title: `YYYYMMDD-<アカウント短縮名>-<slug>.md`（例: `20260706-kim-vercel-cron-unreliable.md`。アカウント = このマシンの Drive コネクタ owner）
   - contentMimeType: `text/plain` + `disableConversionToGoogleType: true`
3. 完了報告に fileId とタイトルを添える。統合は kim 環境の `/rules-sync`（merge）が拾って正本に反映する

## 投稿フォーマット
```markdown
---
date: YYYY-MM-DD
account: <投稿者メール>
type: feedback | reference | rule-change
title: <1行タイトル>
target: ONBOARDING §x.x | rules/gas.md | skills/<name> | new
---
<ルール本文（命令形で簡潔に）>

**Why:** <なぜ必要か。実際に起きた事例・日付>
**How to apply:** <どう適用するか。コマンド・URL 形式など具体的に>
```

## 書いてはいけないもの
- 機密値（API キー / トークン / パスワード / 接続文字列）— 「Script Properties の X から読む」等の間接表現にする
- 個社の経営数値・顧客名などノウハウに不要な実データ
- 特定マシンのローカルパス依存手順（全アカウントで再現できる形に一般化して書く）
