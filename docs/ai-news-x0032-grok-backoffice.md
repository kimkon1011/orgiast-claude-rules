# X-0032: Grok Bot連携でバックオフィス経費削減

**AIニュース提案 X-0032**: Grok Bot（xAI）をバックオフィス業務の自動化ハブとして活用し、会計データ処理・スカウト業務・資料作成・問い合わせ対応を統合する。

観測日: 2026-11-14

---

## 1. 概要

| 項目 | 内容 |
|---|---|
| 提案の核 | Grok Bot のブラウザ自動操作・スケジュール/トリガー実行・Routine機能を活用し、オージャストのバックオフィス4領域を自動化 |
| 既存の基盤 | `grok-ask.mjs`（CLI問合せ）、`grok-bot-prompt-bridge.mjs`（リサーチ→実装変換）、`freee-query.mjs`（会計API）、`line-channel.mjs`（LINE送受信） |
| 必要な追加 | Grok Bot Routine（SuperGrok $30/月）、Webhook連携、freee MCPサーバー（2026年10月以降公開中）、LINE→Webhookブリッジ |
| 期待効果 | 会計データ処理の工数50%減、スカウト業務の初期調査80%自動化、資料作成の時間70%削減、問い合わせ一次回答を自動化 |
| コスト試算 | Grok SuperGrok $30/月 + freee API無料枠内 + VPS不要（Grok BotのクラウドPCを利用） |

---

## 2. 4領域のアーキテクチャ

### 2.1 全体構成

```
┌─────────────────────────────────────────────────────┐
│                  Grok Bot（xAI）                      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐ │
│  │ Routines │ │ Automations│ │ Browser  │ │ Skills │ │
│  │ (定時/   │ │ (Webhook  │ │ (ブラウザ│ │ (知識  │ │
│  │ トリガー)│ │ トリガー) │ │ 自動操作)│ │ ベース)│ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬───┘ │
└───────┼─────────────┼────────────┼────────────┼──────┘
        │             │            │            │
   ┌────▼──┐   ┌─────▼───┐  ┌────▼───┐  ┌────▼────┐
   │freee  │   │ LINE     │  │ スカウト│  │Claude   │
   │API    │   │Webhook   │  │ サイト  │  │Code/    │
   │連携   │   │ブリッジ  │  │ブラウザ │  │Codex    │
   └───────┘   └─────────┘  └────────┘  └─────────┘
```

### 2.2 領域別コンポーネント

| 領域 | Grok Botの役割 | 連携先 | 既存アセット |
|---|---|---|---|
| **会計データ処理** | freee API経由のデータ取得・登録指示、自動消込（2026 MCP対応） | freee API / freee-mcp | `freee-query.mjs`, `lib/freee-auth.mjs` |
| **スカウト業務** | Scout Botで候補者調査・ドラフト作成（ブラウザ自動操作） | ATS / スカウトサイト / Email | `grok-x-fetch.mjs` |
| **資料作成** | リサーチ収集→Claude Code/Codexへ実装指示 | Claude Code / Codex / Design Deck | `grok-bot-prompt-bridge.mjs`, `design-deck-pipeline` |
| **問い合わせ自動化** | LINE/メール受信→Grok自動応答 or 人間確認 | LINE Webhook / Gmail API | `line-channel.mjs`, `discord-autoreply.mjs` |

---

## 3. フェーズ別実装計画

### Phase 0（1週間）: 現状アセスメント ← 本セッション

- [x] Grok Bot用XAI_API_KEYの確認（`grok-ask.mjs` 疎通確認済み）
- [x] freee API疎通確認（`freee-query.mjs` 稼働中）
- [ ] Grok Bot（SuperGrok）アカウント契約 → $30/月
- [ ] Grok Bot Routine機能の動作確認
- [ ] 各領域の現行工数ベンチマーク計測

### Phase 1（2〜3週間）: 会計データ連携

#### 1a. Grok + freee API ブリッジ

**現状**: `freee-query.mjs` でGET読取のみ。POST登録は `keiri-hub` 経由で可能だが、Grok Botから直接呼べない。

**構築するもの**:

| コンポーネント | 説明 | 優先度 |
|---|---|---|
| `tools/grok-freee-bridge.mjs` | Grok BotのRoutineからfreee APIを呼ぶためのRESTエンドポイント | P0 |
| `tools/freee-wallet-txn-match.mjs` | Grokに「明細の消込状況を教えて」と聞かれたときの検索・集計CLI | P1 |
| freee-mcpの検証 | 2026年10月公開のfreee公式MCPで消込操作が可能か確認 | P1 |

**Grok Bot Routine設定例**:
```
Routine名: 毎朝の未決済確認
トリガー: Schedule（平日9:00）
アクション: tools/grok-freee-bridge.mjs --check-unmatched
→ 未決済があれば LINE #経理チーム に通知
```

#### 1b. 領収書・証憑の自動紐付け

**現状**: `receipt-fetch` でSUBLINE等の証憑をfreeeファイルボックスに投入→手動で取引に紐付け。

**改善**: Grok Botがfreee MCP（またはAPI）で未紐付け証憑を検出→取引との紐付けを自動実行→結果をLINE通知。

### Phase 2（2〜3週間）: スカウト業務自動化

#### 2a. Grok Bot Scout セットアップ

Grok Botの公式 Scout 機能（2026年実装済み）を利用。必要な設定:

| 設定項目 | 内容 |
|---|---|
| スカウト条件 | 職種・スキル・経験年数・地域 |
| ソース | スカウトサイト（Wantedly・Green等）のURLをGrok Botに教示 |
| 除外条件 | 既存パイプライン内の候補者を除外 |
| 出力 | 候補者リスト（ドラフト）→人間承認→スカウト送信 |

**オージャスト固有の調整**:
- 自社案件DB（`/jugyoin` 等）と連携し、既存社員・過去応募者を除外
- スカウト文面のテンプレートをGrok Bot Skillとして登録
- 週1回のスカウト実行cron設定（月曜10:00）

#### 2b. ブラウザ操作パイプライン

Grok Botのブラウザ自動操作機能で、APIがないスカウトサイトでも対応可能。
ただし「powerful and brittle」（UI変更で壊れる）なため、週1回の動作確認ルーチンを追加。

### Phase 3（3〜4週間）: 問い合わせ自動化（LINE/メール連携）

#### 3a. LINE → Grok Bot 連携

**現状**: `line-channel.mjs` でLINEメッセージの送受信は可能（GWS Proxy経由）。

**構築するもの**:

| コンポーネント | 説明 | 優先度 |
|---|---|---|
| LINE Webhook → Grok Automations | LINEメッセージ受信時にGrok Automationを起動 | P0 |
| 応答テンプレート管理 | よくある質問の回答をGrok Bot Skillに登録 | P1 |
| 人間確認エスカレーション | 判断が必要な問い合わせをLINE通知→人間回答→Grok送信 | P1 |

**アーキテクチャ**:
```
LINE受信 → GWS Proxy → Grok Automations Webhook → Grok Bot処理
                                                      ↓
                                            ┌── 自動回答可能 → LINE送信
                                            └── 判断必要 → LINE #経理チーム通知
                                                              → 人間回答 → Grok送信
```

#### 3b. メール自動応答

Grok BotのEmailトリガー機能（SuperGrok必須）を利用。既存の `gmail-draft.mjs` / `seisaku-team` GAS token relay と組み合わせる。

| ユースケース | Grok Bot処理 | 人間確認 |
|---|---|---|
| 請求書に関する問い合わせ | freee APIで該当請求書を検索→回答案生成 | 必要に応じて |
| 支払期日確認 | freee APIで期日を照会→自動回答 | 不要 |
| 見積依頼 | テンプレートから見積案生成 | 必須 |
| 取引先登録依頼 | freee APIで取引先を検索→新規登録案 | 必須 |

### Phase 4（並行: 1〜2週間）: 資料作成自動化

#### 4a. Grok Bot リサーチ → Claude Code/Codex 実装パイプライン

既存の `grok-bot-prompt-bridge.mjs` を拡張し、以下のループを自動化:

```
Grok Bot リサーチ（ネット収集） → JSON出力
    ↓
grok-bot-prompt-bridge.mjs → 実装指示書.md
    ↓
Codex（codex-do.mjs） → 実装
    ↓
Grok Bot QA検証 → 修正 or 完了報告
```

#### 4b. 既存アセットとの統合

| 既存アセット | X-0032での活用 |
|---|---|
| `design-deck-pipeline` | Grok Botリサーチ結果を企画書に自動組版 |
| `screenshot-website-builder` | Grok Botが集めた参考デザインからLP自動生成 |
| `ai-seo-agent-workflow` | SEO分析ループと統合 |
| `grok-monitor-cost-model` | 監視頻度最適化を全ルーチンに適用 |

---

## 4. 技術詳細

### 4.1 Grok Bot Routine 設定（参考）

Grok Bot Routineは以下のトリガーに対応:

| トリガー種別 | 用途 | オージャスト適用例 |
|---|---|---|
| Schedule（cron） | 定時実行 | 毎朝9:00 未決済確認、月曜10:00 スカウト実行 |
| Webhook | 外部イベント起動 | LINE受信時、freeeファイルボックス新着時 |
| Email | メール受信起動 | 請求書関連メール着信時 |
| Slack/GitHub | 既存ツール連携 | Slack #経理チーム の投稿をトリガーに |

### 4.2 freee MCP 連携（2026年10月〜）

freeeが公開した `freee-mcp`（OSS MCPサーバー）により、AIエージェントからfreeeの基幹業務を直接操作可能に:

- 未決済取引と明細の自動消込
- 明細に紐付く新規取引の作成
- プライベート取引・口座振替の自動処理
- 自動登録ルールのAPI経由での適用

**検証手順**: freee-mcp を localhost で立ち上げ → Grok BotからMCP経由で消込テスト → 結果をAPI読み戻し確認。

### 4.3 セキュリティ・ガードレール

| リスク | 対策 |
|---|---|
| freeeへの誤登録 | 登録系操作は全て「ドラフ���作成→人間確認」の2段階 |
| スカウト誤送信 | Grok Bot Scoutはデフォルトで人間承認必須（変更不可） |
| LINE誤送信 | Grok Bot Routineに承認ステップを組み込む |
| コスト超過 | Grok SuperGrok $30/月固定 + freee API無料枠。超過監視は `grok-monitor-cost-model.mjs` を応用 |

---

## 5. コスト試算

| 項目 | 月額 | 備考 |
|---|---|---|
| Grok SuperGrok | $30（約4,500円） | Routine・Emailトリガー・Scout機能に必須 |
| freee API | 無料 | 全プランで利用可能。消込APIは2026年Q4 |
| VPS | 不要 | Grok BotのクラウドPCを利用 |
| Claude Code/Codex | 従量（実装時のみ） | Phase 4の実装パイプラインでのみ使用 |
| **合計** | **約4,500円/月** | 現状の人件費削減効果と比較 |

---

## 6. 検証計画

| Phase | 検証項目 | 合格基準 |
|---|---|---|
| 0 | Grok Bot Routine動作確認 | Schedule/Webhookトリガーが正常起動 |
| 1 | freee API疎通（Grok経由） | Grok Routineからfreee取引一覧を取得・表示 |
| 1 | 自動消込テスト | freee MCPで未決済取引の消込が成功（API読み戻し確認） |
| 2 | Scout候補者リスト生成 | 条件に合致する候補者が10件以上リストアップ |
| 3 | LINE応答テスト | 自動回答可能な問い合わせに100%応答 |
| 4 | 実装パイプライン実行 | Grokリサーチ→Codex実装→QA完了まで自動通過 |

---

## 7. 既存ツールとの関係

| 既存ツール | X-0032での位置づけ | 変更の要否 |
|---|---|---|
| `grok-ask.mjs` | Grok API呼出しの基盤 | 変更不要 |
| `grok-bot-prompt-bridge.mjs` | リサーチ→実装の橋渡し | 拡張（Routine出力対応） |
| `grok-x-fetch.mjs` | X/Twitter情報収集 | 変更不要 |
| `grok-monitor-cost-model.mjs` | コスト監視モデル | 全Routineに適用拡張 |
| `freee-query.mjs` | freee読取 | 変更不要（Grokから呼ぶためのラッパー追加） |
| `line-channel.mjs` | LINE送受信 | Webhook受信モード追加 |
| `grok-freee-bridge.mjs` | **新規** | Grok→freee APIブリッジ |
| `freee-wallet-txn-match.mjs` | **新規** | 明細照合のCLI化 |
| `line-grok-webhook.mjs` | **新規** | LINE→Grok Webhook変換 |

---

## 8. 開始手順（次セッション）

1. `node tools/grok-ask.mjs "What can you do with Grok Bot Routines and Automations?"` でGrok Botの現状機能を確認
2. Grok SuperGrok（$30/月）の契約を kim に提案
3. 契約後、Grok BotのScout機能とRoutine機能の実機検証
4. `outputs/X-0032/` ディレクトリに検証結果を保存
5. Phase 1（freee連携）の実装に着手: `tools/grok-freee-bridge.mjs`
