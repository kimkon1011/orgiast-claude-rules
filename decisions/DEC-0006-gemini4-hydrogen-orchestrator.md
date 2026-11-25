# DEC-0006: Gemini 4 Hydrogen + Orchestrator 導入提案

## decision_id
DEC-0006

## date
2026-11-14

## status(PROPOSAL|ACTIVE|SUPERSEDED)
PROPOSAL

## project
共通ルール / AI委譲レーン / ブース制作エージェント

## QUESTION
2026-11-12 リリースの Gemini 4 Hydrogen をオージャストのブース制作AIエージェントへ導入するか。

## CONTEXT

### Gemini 4 Hydrogen の位置付け
2026-11-12 に Google がリリースした高速推論モデル。Gemini 4 Argon（前世代フロンティア）を AI Index で上回り（51 vs 50）、3.8 Flash 比で 2.5 倍の処理速度を達成。4段階の思考レベル（low/medium/high/xhigh）を設定可能。

### 価格
- 入力: $1.50/100万トークン（3.8 Flash の $0.75 の2倍だが、3.7/3.8 Flash 世代も同額帯）
- 出力: $7.50/100万トークン（3.8 Flash の $3.75 の2倍）
- 100万トークンコンテキスト対応
- 出典: ai.google.dev/gemini-api/docs/pricing

### Gemini 4 ファミリー価格比較（2026-11-14 時点）

| モデル | 用途 | 入力 ($/1M tok) | 出力 ($/1M tok) | 備考 |
|--------|------|-----------------|-----------------|------|
| Argon | 最高精度推論 | $2.00→$4.00* | $10.00→$20.00* | プロモ価格は11/30まで、12/1より2倍 |
| Carbon | 標準フロンティア | $1.00→$2.00* | $5.00→$10.00* | Orchestrator の計画担当候補、同上 |
| Hydrogen | 高速実行 | $1.50 | $7.50 | プロモ価格の記載なし（定額の可能性） |
| 3.8 Flash | 現行軽量 | $0.75 | $3.75 | 価格変動予定なし |

*12月1日以降の価格。Carbon はプロモ期間（〜11/30）の $1.00/$5.00 が最も安い。

**経済性のポイント**:
- Hydrogen は 3.8 Flash 比で出力単価 2 倍だが、コード品質（Terminal-Bench 3.1倍）と速度（2.5倍）を考慮すると総トークン消費量が減り、トータルコストが同等以下の可能性がある
- Carbon はプロモ期間中（あと 16 日間）が最も安く、Orchestrator 試験導入はこの期間を活用すべき
- 12月以降は Carbon 単体運用より、Carbon (plan) + Hydrogen (exec) の Orchestrator 構成のほうが経済的になる

### 性能
- Terminal-Bench 4.1: **57%**（3.8 Flash 18.2% から 3.1倍）
- ハルシネーション: 3.8 Flash 比で **1/5**
- 速度: 3.8 Flash 比で **2.5倍**
- AI Index（高思考）: 54（Argon 50、3.8 Flash 非公表）

### Orchestrator モード（Carbon + Hydrogen）
Google Antigravity の新機能。Carbon（フロンティアモデル）が計画・判断を担当し、Hydrogen が実行を担当する動的切替方式。
- Carbon 単体比で **19% 時間短縮**
- **24% クォータ削減**（Carbon 呼び出しが減る）
- Terminal-Bench 4.0 で Carbon に近い成功率を維持
- 出典: blog.google, The Verge, Ars Technica 2026-11-12

### 現状のオージャスト構成
- model-router.mjs / provider-routing.mjs / routing-table.mjs: プロバイダ・モデルルーティング基盤
- 現在の Gemini 利用: gemini-cli MCP（npx gemini-mcp-tool）経由で 3.8 Flash 相当
- gemini-pricing.default.json: 3.5/3.6/3.7/3.8 Flash まで登録、Hydrogen は未登録
- codex-do.mjs: codex 不在時は gemini-cli がフォールバック実行
- OpenAI 系（GPT-5.6 Luna 等）は OpenRouter 経由
- Kimi / DeepSeek / Mistral は OpenRouter 経由

### ブース制作AIエージェントへの応用可能性
- 展示会ブースの問い合わせ一次返信（reply-booth / reply-sponsor）
- 会場施工メモの要点抽出（extract-site / extract-purchase）
- 見積前提の整理（estimate-booth）
- 議事録作成（minutes-launch）
- 施工手順書生成（construction-manual skill）
- 実績記事生成（rebooth-wp-works-posting）

## OPTIONS

### (a) Hydrogen を新レーンとして追加（推奨）
既存の Gemini Flash 系レーンと並行で Hydrogen を追加し、コード生成・高速応答が必要なタスクから順次移行。

- 必要な作業:
  - gemini-pricing.default.json に Hydrogen の価格情報を追加
  - model-relay-catalog.json に Hydrogen タスク定義を追加
  - routing-table.mjs に Hydrogen のルーティング条件を追加（cost-routing-gate 経由）
  - codex-do.mjs の gemini-cli 呼び出しに Hydrogen オプションを追加
- コスト増: 出力トークン単価が 3.8 Flash 比で 2倍。ただし処理速度 2.5倍とコード精度向上で総トークン数が減る可能性
- リスク: 低

### (b) Orchestrator（Carbon + Hydrogen）を導入
Google Antigravity の Orchestrator 機能を使い、複雑な依頼（見積・施工手順書生成等）は Carbon が計画、Hydrogen が実行する分業体制を構築。

- 必要な作業:
  - 上記 (a) の全作業
  - Gemini 4 Carbon API キーの取得とルーティング追加
  - Orchestrator のプロンプト設計（計画→実行の分離指示）
  - ブース制作タスクを「計画フェーズ」「実行フェーズ」に分解するプロトコル策定
- コスト増: Carbon（上位モデル）の API 費用が別途発生
- リスク: 中（Orchestrator が新しい機能であること、Carbon API の安定性未検証）

### (c) 既存のコード生成レーン（Codex / Gemini 3.8 Flash）を維持
新モデル導入は行わず、現状維持。

- リスク: 競合他社に速度・コスト面で差をつけられる
- 利点: 導入工数ゼロ

### (d) Gemini Hydrogen への全面置換
既存の Gemini Flash 系レーンをすべて Hydrogen に置き換える。

- リスク: 高（新モデルの安定性未確認。コストが出力 2倍）
- 非推奨

## DECISION
本提案は PROPOSAL である。以下の RECOMMENDATION に基づき、kim の承認を得てフェーズド導入を開始する。

## RECOMMENDATION
**(a) を先行実施し、成果を測定後に (b) へ拡大する。**

Phase 1（即日〜1週間）:
1. ~~gemini-pricing.default.json に Hydrogen/Argon/Carbon 価格を追加~~ ✅ 本セッションで実施済み
2. model-relay-catalog.json に Hydrogen のタスク定義を追加（コード生成・返信生成・要約の 3 カテゴリ）
3. codex-do.mjs の gemini-cli 呼び出しに `--model gemini-4-hydrogen` オプションを追加
4. 既存の Gemini 3.8 Flash タスクとのコスト・速度比較を計測

Phase 2（1〜2週間後）:
5. Hydrogen の品質・速度が実用基準を満たせば、Gemini 3.8 Flash を Hydrogen へ既定切替
6. Orchestrator（Carbon + Hydrogen）の技術調査と試験導入準備

Phase 3（3〜4週間後）:
7. Carbon API キー取得・Orchestrator プロトコル実装
8. ブース制作エージェントの複合タスク（見積＋施工手順書 etc.）に Orchestrator を適用
9. Carbon 単体 vs Orchestrator の速度・コスト比較

## TRADE-OFF
- (b) の Carbon API 費用はプロモ期間（〜11/30）が最も安い。Orchestrator 試験導入は残り 16 日間のプロモ価格帯で行うべきだが、Phase 1 の Hydrogen 評価を優先すると Orhestrator 試験開始が 12 月以降になりコスト増となる
- Hydrogen はリリースから 2 日。短期間の実測だけで品質判断するリスク
- Hydrogen の出力単価（$7.50）は Carbon プロモ価格（$5.00）より高い。つまり Carbon 単体プロモ運用は Hydrogen より経済的だが、Orchestrator で両者を組むと計画トークンは Carbon、実行トークンは Hydrogen で消費され、合計は増えるが Carbon 単体より 19% 時間短縮＋24% クォータ削減のトレードオフ
- 3.8 Flash から Hydrogen への移行は出力単価 2 倍だが、総トークン削減で相殺される可能性あり

## ASSUMPTIONS
- Gemini 4 Hydrogen API の料金が変わらない（$1.50/$7.50/1M tokens が維持される）
- Hydrogen の速度向上（2.5x）が少なくともコード生成・テキスト生成の一部で実測再現される
- Orchestrator（Carbon ↔ Hydrogen）が Google Antigravity で安定して利用可能
- 既存の cost-routing-gate / app-llm-cost-gate が新レーンの費用上限管理をカバーできる
- Hydrogen は gemini-cli MCP 経由で呼び出せる（要確認）

## REVERSIBILITY
REVERSIBLE — Hydrogen の追加は設定変更のみでロールバック可能。Orchestrator 導入は Carbon API キー発行が必要だが、キー削除で即時停止可能。

## REVISIT_TRIGGER
- 2026-12-01: Carbon/Argon のプロモ価格終了と価格倍増（Phase 2 判断に直接影響）
- Hydrogen の API 価格が変更されたとき
- Hydrogen の実測品質が 3.8 Flash を下回ったとき（Phase 1 の計測で判定）
- Orchestrator の Google Antigravity 以外（OpenRouter 等）での代替利用が可能になったとき
- ブース制作AIエージェントのタスク特性が大きく変化したとき

## RELATED
- supersedes: なし（新規）
- DEC-0005: 期限原簿（コスト管理基盤）
- model-router.mjs / provider-routing.mjs / routing-table.mjs（ルーティング基盤）
- gemini-pricing.default.json（価格設定、要更新）
- codex-delegate playbook（委譲経路）

## RULE
コスト最適化の 7 手順（AI運用プレイブック）に従い、Phase 1 実装前に現行 3.8 Flash のレーン別消費を実測する。ccusage または executor-usage.jsonl で 1 週間分のプロバイダ別トークン消費を集計し、Hydrogen 導入前後の差分を測定可能にする。
