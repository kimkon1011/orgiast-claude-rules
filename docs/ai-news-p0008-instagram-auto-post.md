# AIニュース提案 [P-0008]: Instagram自動投稿システムの導入

## 課題

展示会ブース・イベント告知の Instagram 投稿において、以下の問題が発生している：

- **LINE経由配信の間接性**: 投稿コンテンツを LINE グループに送信してから手動で Instagram に転載しており、作業が二重化している
- **投稿タイミングの不統一**: 各担当者が個別に LINE で受け取ったコンテンツを随時投稿するため、更新頻度・時間帯にばらつきがある
- **計測・効果検証の欠如**: LINE 経由では各投稿のインプレッション・エンゲージメントを自動収集できず、効果測定が属人的になる
- **既存 Instagram API ツールの未活用**: `tools/instagram/` に画像投稿・検証・トークン管理のツール一式が存在するが、業務ラインで使われていない

## 目的

現行の「LINE で画像＋キャプションを共有 → 人が手動投稿」から「Instagram Content Publishing API を直接呼び出して自動投稿」に切り替え、**投稿作業の工数を 50% 削減**することを検証する。

## 現状分析

### 既存の投稿関連ツール

| ツール | 機能 | 状態 |
|---|---|---|
| `tools/instagram/post.mjs` | 画像・動画・REELS 投稿 CLI | ✅ 実装済み（lahaina 用） |
| `tools/instagram/publish-media.mjs` | メディア配置・公開URL事前検証 | ✅ 実装済み |
| `tools/instagram/verify-post.mjs` | 公開表示の読み戻し検証 | ✅ 実装済み |
| `tools/instagram/refresh-token.mjs` | 長期トークン定期更新（自動） | ✅ 実装済み |
| `tools/instagram/ig-api.mjs` | Meta Graph API 共通ラッパー | ✅ 実装済み |
| `tools/line-group-send.mjs` | LINE グループへの送信 | ✅ 実装済み（現行経路） |

### 現行フロー（LINE 経由配信）

```
1. 投稿コンテンツ作成（画像＋キャプション）
2. LINE グループに投稿（手動 or スクリプト）
3. 受信者が Instagram アプリで開く
4. アップロード・キャプション設定・位置情報追加・公開（手動）
5. 投稿完了確認（目視）
```

**所要時間（推定）**: 1投稿あたり約 5〜10 分（LINE 共有＋手動アップロード＋検証）
**週間投稿数（目標）**: 7〜14 件（1日 1〜2 件）

### 目標フロー（API 直接投稿）

```
1. 投稿コンテンツ準備（画像＋キャプションの生成）
2. スクリプト実行または cron 自動実行（LINE を経由しない）
3. API 投稿＋公開表示の自動検証
```

**所要時間（目標）**: 1投稿あたり約 1〜2 分（コンテンツ準備のみ、投稿は自動）
**削減率**: 60〜80%（LINE 転載の手間がなくなる）

## Instagram Content Publishing API の評価

### 2026年11月時点の API 仕様

| 項目 | 内容 |
|---|---|
| **対応メディア** | 画像（JPEG推奨）、動画（MP4）、REELS、カルーセル、ストーリーズ（Business アカウントのみ） |
| **認証方式** | Instagram Professional アカウント + Facebook Login + 長期アクセストークン |
| **トークン有効期限** | 60日（`refresh-token.mjs` で自動リフレッシュ可能） |
| **レート制限** | 4800 × インプレッション数 / 24h（中小規模では実質上限なし） |
| **1日あたり投稿数** | API 上の明示的上限なし（既存ツールの `--max-per-day` 既定 10 を適用） |
| **投稿後の検証** | Graph API の `GET /{{media-id}}` + ヘッドレス Chrome 描画（`verify-post.mjs` で実装済み） |

### 制約とリスク

| 制約 | 影響 | 対策 |
|---|---|---|
| 公開 HTTPS URL が必要（画像の直接アップロード不可） | 少 | GitHub raw / jsDelivr CDN 使用（既存 lahaina と同じ方式） |
| トークン60日期限あり | 低 | `refresh-token.mjs` で自動延長（既存） |
| ストーリーズは Business アカウントのみ | 低 | 通常投稿は Creator/Business 両対応 |
| API 仕様変更リスク | 中 | 既存ツールで対応済み、Graph API v19.0+ で安定 |
| 複数アカウント対応 | 中 | アカウントごとのトークン管理・`.env` 分離が必要 |

## 提案する移行計画

### Phase 1: 社内 Instagram アカウントの API 登録（所要: 1〜2日）

| # | 作業 | 担当 | 備考 |
|---|---|---|---|
| 1 | Instagram Professional アカウント（Business）への切替確認 | kim | Creator から Business への切替が必要な場合あり |
| 2 | Meta Developer Portal でのアプリ作成 + トークン発行 | kim | Facebook アカウントとリンクが必要 |
| 3 | トークン登録スクリプト作成（lahaina の `setup.cmd` 相当） | AI | 汎用化した `.cmd` を作成 |
| 4 | 初回投稿テスト（画像1件） | AI | `post.mjs` の社内アカウント対応確認 |

### Phase 2: 定期投稿パイプライン（所要: 1〜2日）

| # | 作業 | 優先度 |
|---|---|---|
| 1 | 投稿テンプレート管理（`templates/instagram/`）の作成 | P0 |
| 2 | 週次 cron 登録（週3〜7回の投稿スケジュール） | P0 |
| 3 | 自動検証＋投稿失敗時の通知（`verify-post.mjs` 統合） | P1 |
| 4 | 投稿履歴ログの統合（既存 `post-log.jsonl` 形式に準拠） | P1 |

### Phase 3: 効果測定（所要: 2週間の実運用後）

| # | 項目 | 指標 |
|---|---|---|
| 1 | 1投稿あたりの工数測定（API 経由 vs LINE 経由） | 時間/件 |
| 2 | エンゲージメント率の変化（フォロワーあたり） | % |
| 3 | 投稿頻度の維持率（週間投稿数目標 vs 実績） | % |
| 4 | 障害回数（投稿失敗・トークン切れ等） | 回/月 |

## 費用対効果

### 定量試算（週10投稿の場合）

| 項目 | 現在（LINE経由） | 提案（API直接） | 削減率 |
|---|---|---|---|
| 投稿作業時間/週 | 50〜100分（10件×5〜10分） | 10〜20分（準備のみ・投稿自動） | 80% |
| LINE 転送作業 | 10回/週 | 0回 | 100% |
| 投稿漏れリスク | 中（人が忘れる） | 低（cron 自動実行） | — |
| エンゲージメント分析 | 属人的 | 自動収集可能 | — |
| 導入コスト | — | 2〜4日（Phase 1〜2） | — |
| API 費用 | — | 無料（Meta Graph API は無料） | — |

### 定性効果

- **LINE メッセージ数の削減**: 投稿用コンテンツの LINE 送信が不要になるため、グループのノイズが低減
- **投稿品質の統一**: テンプレート管理により、画像サイズ・キャプション形式・ハッシュタグの一貫性が向上
- **tabil性の向上**: 担当者が不在でも cron が自動投稿を行うため、更新頻度が維持される
- **既存インフラの活用**: 既存の `tools/instagram/` を汎用化するだけで導入可能で、新規開発量が少ない

## リスク評価

| リスク | 確度 | 影響度 | 対策 |
|---|---|---|---|
| Meta API 仕様変更 | 低（Graph API は数年に1度の breaking change） | 中 | 既存ツールのカプセル化で影響局限定 |
| トークン失効による投稿停止 | 中（60日ごとの更新が必要） | 高 | `refresh-token.mjs` の定期実行（既存） |
| アカウント凍結（自動化ポリシー違反） | 低（公式 API 使用のため違反にならない） | 高 | 公式 Content Publishing API のみ使用（既存ポリシー遵守） |
| 複数アカウント管理の複雑化 | 中 | 低 | アカウント別 `.env` + `keyserve` 統合管理 |
| 画像公開 URL のホスト障害 | 低（GitHub / jsDelivr） | 中 | フォールバック URL の複数指定 |

## 検証計画

### 1. 動作検証（Phase 1 完了後、1日で実施）

```bash
# テスト投稿（画像1件）
node tools/instagram/post.mjs --image "https://raw.githubusercontent.com/.../test.jpg" --caption "テスト投稿 #オージャスト"

# 公開表示の検証
node tools/instagram/verify-post.mjs --media-id "..." --expect "テスト投稿"

# トークン健全性確認
node tools/instagram/refresh-token.mjs --dry-run
```

### 2. 効果測定（Phase 3、2週間の実運用）

| 指標 | 計測方法 | 目標値 |
|---|---|---|
| 投稿作業時間 | `time` コマンドでスクリプト実行時間を記録 | 平均 < 2分/件 |
| 投稿頻度 | cron 実行ログ（cron-watch.json） | 週7件以上継続 |
| エラー率 | post-log.jsonl の失敗行カウント | < 5%（1ヶ月） |
| LINE メッセージ数削減 | LINE 送信ログの比較 | 週10件以上の削減 |

## 総合評価

### 結論: 推奨（導入による効果は高いが、検証期間が必要）

**推奨判断の根拠**:
1. **既存インフラの活用**: `tools/instagram/` 一式が完成しており、新規開発量は設定と cron 登録のみ
2. **API 費用ゼロ**: Meta Graph API の Content Publishing は無料で利用可能
3. **導入リスク低**: 既存 lahaina アカウントで実績のあるツールの汎用化なので、未検証領域が少ない
4. **50%削減は達成可能**: LINE 転載の手間を完全に排除できるため、むしろ 60〜80% の削減が現実的

**要検証ポイント**:
1. **社内アカウントの Professional 化**: 既存アカウントの種類確認（Business/Creator/Personal）
2. **Meta Developer Portal アプリの作成権限**: kim の Facebook アカウントで API アプリを作成できるか
3. **複数アカウント管理の設計**: 展示会用・イベント用でアカウントが分かれる場合のトークン管理方式

## 関連ドキュメント

- `tools/instagram/post.mjs` — Instagram 投稿 CLI（lahaina 実績）
- `tools/instagram/ig-api.mjs` — Meta Graph API 共通ラッパー
- `tools/instagram/refresh-token.mjs` — 長期トークン自動更新
- `tools/instagram/verify-post.mjs` — 公開表示の自動検証
- `tools/instagram/publish-media.mjs` — メディア配置・URL 事前検証
- `tools/line-group-send.mjs` — LINE グループ送信（現行経路）
- `docs/ai-news-p0009-facebook-token-management.md` — Meta トークン統合管理の先行事例

## 改訂履歴

| 日付 | 版 | 変更内容 | 承認 |
|---|---|---|---|
| 2026-11-15 | 1.0 | 初版作成（Instagram 自動投稿システム導入提案） | AI提案（要検証） |