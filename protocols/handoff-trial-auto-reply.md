---
name: handoff-trial-auto-reply-on-011
description: トライアル受け入れの自動応答にkim指定シート案内を追加するための引継書（本体は011側）
---

# HANDOFF: トライアル自動応答 改修

## TASK_ID
trial-auto-reply-20261106

## OBJECTIVE
Discord 自動応答（トライアル受け入れ）に、kim 指定のシート案内を毎回追加する。

## BACKGROUND
- kim 指示（2026-11-04）: 「毎回トライアルの方には、こちらを自動で送るようにしてください。トライアルの案内にも入れてもらって良いです」
- 送るシート: 「トライアルの方にやっていただきたい業務」
  URL: https://docs.google.com/spreadsheets/d/1Kdyr8Mih2ihFmxM46Cg22RpRCVdM9qIFhVNpBY4EG_c/edit?usp=drivesdk
  共有設定: trial@orgiast.jp が編集者、orgiast.jp ドメインが閲覧者
- このPC（kim-PC/w018）には該当コードが無い。探した場所: nightly-repo、Downloads/aujust-sales-automation、D:/CLaUDE.md配布、D:/assign-app-ready-wt 等
- コードは別PC（作業用011）にある見込み

## CONTEXT
### 自動応答の現状
- 対象: Discord orgiast サーバー、チャンネル 1382597125757735023
- Bot: 「clawd-connector」
- 応答には末尾に「（オージャスト 自動応答）」が付く
- 毎時7〜8分ごろに出ている
- 例1: 「ご連絡ありがとうございます。業務開始日（11月6日）までに担当から案件をご案内します。… 小川華音さんの最初の案件の割当をお願いします（業務開始日 11/6）」
- 例2: 「ご提出ありがとうございます。受け取りました。」

### コードの在り処の推定（優先順）
1. **GAS プロジェクト（trial-contract-gas 等）** — Google Apps Script で定期実行して Discord Webhook にPOSTしている可能性が高い
2. **discord-mcp-connector** — Vercel デプロイ（https://discord-mcp-connector.vercel.app/api/mcp）に auto-reply ロジックが含まれている可能性
3. **supabase Edge Function or cron** — assign-app の contractor 関連コードに from しているかも
4. **claude.ai 定期ジョブ** — チャンネルIDと「オージャスト 自動応答」をキーワードに検索

### このトライアルについて（小川華音さん）
- 小川華音さんには kim-PC から今回分のシート案内を送付済み（Discord message 1567465003106312272）
- 以下は次回以降の自動反映だけ

## INPUT
### 変更1: 自動応答に1行追加
業務開始・初案件割当の自動応答に、次の一文とURLを必ず入れる:
```
まずはこちらのシート「トライアルの方にやっていただきたい業務」をご確認ください: https://docs.google.com/spreadsheets/d/1Kdyr8Mih2ihFmxM46Cg22RpRCVdM9qIFhVNpBY4EG_c/edit?usp=drivesdk（seisaku-team@orgiast.jp のアカウントで開いてください）
```

### 変更2: トライアル案内の定型文にも
トライアル案内の定型文にも同じ一文とURLを入れる。

### 変更3: テスト → PR → デプロイ → 反映確認
Layer 1（ロジック再現）+ 実際にDiscordにテスト投稿して確認。

## CONSTRAINTS
- 「（オージャスト 自動応答）」の末尾表記は維持
- 毎時7〜8分のタイミングは変えない
- URL は `seisaku-team@orgiast.jp` のアカウントで開くよう明記
- シートは trial@orgiast.jp が編集者、orgiast.jp ドメインが閲覧者

## HUMAN_GATE
- PR の code review（必す）
- 本番への deploy（PRマージ後自動 or 手動）

## DONE_CRITERIA
1. 自動応答のコードを特定し改修
2. 該当行にシート案内が含まれていることをテスト（Layer 1: Node test）
3. Discord にテスト投稿して本文にシート案内が含まれていることを確認
4. PR → マージ → デプロイ → 本番で確認

## OUPUT
夜間-repo の protocols/ にこのファイル（handof-trial-auto-reply.md）を置く。

## REPORT_TO
このセッションの応答として、次のセッションへの引継ぎ情報として

## 実行原則
- 自動化できないことは無理に自動化しない
- 本番の自動応答を壊さない（テストモード or 別チャンネルで先に確認）
- 他の機能に影響を与えない