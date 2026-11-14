# X-0052: Nuphos — 既存Claude/CodexサブスクでGrok Bot代替を低コスト実現

**AIニュース提案 2026-11-15**: NuphosはApache 2.0ライセンスのオープンソースプラットフォームで、Claude CodeやCodexの既存サブスクリプションを流用し、複数コンピュータでボットを自律稼働させる。チームでグループチャットから共同操作可能。Nuphos Cloudのマネージドコンピュータ（月額$20〜$100）か、セルフホスト（Docker Compose一発）を選べる。オージャストでは社内のイベント資料作成やブース提案ボットを既存Claude契約＋Nuphos（セルフホスト）で試す。

観測日: 2026-11-15

---

## 1. 概要

**Nuphos**（[nuphos.ai](https://nuphos.ai/)）は、複数のAIコーディングエージェントをチームで協調運用するためのオープンソースプラットフォームである。GitHubスター560、Apache 2.0ライセンス。

最大の特徴は **「既存のClaude Code / Codexサブスクリプションをそのまま使える」** 点。Nuphos自体はモデル推論料金を上乗せせず、コンピュータ容量（マネージドクラウドのvCPU）に対してのみ課金するか、セルフホストすれば無料で使える。

| 項目 | 内容 |
|------|------|
| ライセンス | Apache 2.0（完全OSS） |
| GitHub | [github.com/nuphos/nuphos](https://github.com/nuphos/nuphos) |
| 対応ランタイム | Claude Code, Codex, OpenCode, Grok Build, Antigravity |
| 利用形態 | Nuphos Cloud / セルフホスト（Docker Compose / Helm / Railway） |
| クライアント | macOS, Windows, Linux Desktop + iOS App |
| モデル課金 | **なし**（既存サブスクを流用、上乗せなし） |

### 1.1 Grok Botとの比較

| 比較軸 | Grok Bot | Nuphos |
|--------|----------|--------|
| ライセンス | プロプライエタリ | Apache 2.0 OSS |
| モデル課金 | Grokモデル込み（$30/月〜） | 既存サブスク流用、追加課金なし |
| セルフホスト | 不可 | 可（Docker Compose） |
| チーム共同操作 | 不可（個人用） | 可（マルチプレイヤーセッション） |
| 複数ランタイム | Grokのみ | Claude Code / Codex / OpenCode 等 |
| 常時稼働ボット | 部分的 | クラウド/リモートランタイムで完全対応 |
| トリガー | 未対応 | cron / Webhook |

## 2. アーキテクチャ

```
┌─────────────────────────────────────────────────────┐
│                   Nuphos Backend                      │
│  (Bun/Hono API — アカウント・チーム・セッション管理)     │
├────────┬────────┬────────┬────────┬──────────────────┤
│ Claude │ Codex  │ OpenCode│ Grok  │  その他ランタイム  │
│  Code  │        │        │ Build │  (Antigravity等)  │
├────────┴────────┴────────┴────────┴──────────────────┤
│   Computer (ローカルPC / 自サーバー / Nuphos Cloud)    │
└─────────────────────────────────────────────────────┘
```

### 2.1 3つのコアコンセプト

| 概念 | 説明 |
|------|------|
| **Computer** | 物理/仮想マシン。ラップトップ、自前サーバー、Nuphos管理クラウドのいずれか |
| **Runtime** | コンピュータにインストールされたターミナルコーディングツール（Claude Code CLI等） |
| **Agent** | ランタイム上で動作する長期稼働ワーカー。切断後もセッションを保持 |

### 2.2 チーム協調の仕組み

- **マルチプレイヤーセッション**: チームメイトをセッションに招待すると、全員が同じツール呼び出しと結果を見ながら協調操作できる
- **共有メモリ**: MCPサーバ追加不要で、チーム・エージェント・セッション間でメモリを共有
- **Slack/Discord連携**: 同じエージェントをチャンネルに追加してチャットから操作可能
- **iOS対応**: スマートフォンからセッションに参加・監視可能

## 3. 料金比較

### 3.1 Nuphos Cloud コンピュータプラン（月額USD）

| プラン | vCPU（チーム合計） | 月額 |
|--------|-------------------|------|
| Small | 4 vCPU | $20 |
| Medium | 12 vCPU | $50 |
| Large | 24 vCPU | $100 |

- 一時停止中のコンピュータは枠を消費しない
- 自分のマシンやサーバーはマネージド容量に含まれない（無料）
- モデル推論料金は各ランタイムプロバイダ側で個別課金

### 3.2 セルフホスト（無料）

Docker Composeで `docker compose up` 一発。MongoDB + S3互換ストレージ + バックエンド + エージェントランタイムが起動。自前のClaude Code / Codexアカウントでサインインするだけ。

注意点:
- メール認証には Resend API キーが必要
- マネージドランタイムプロビジョニング（「New computer」）は利用不可
- マネージドバックアップ・運用ツールは含まれない

### 3.3 オージャストでの試算

**シナリオ: セルフホスト（無料）＋既存Claude Codeサブスク流用**

| 項目 | コスト |
|------|--------|
| Nuphos | $0（セルフホスト、自社サーバー or ラップトップ） |
| Claude Code | 既存契約（追加費用なし） |
| Codex | 既存契約（追加費用なし） |
| **合計追加費用** | **$0/月** |

**シナリオ: Nuphos Cloud Small + 既存サブスク**

| 項目 | コスト |
|------|--------|
| Nuphos Cloud | $20/月（4 vCPU、常時稼働ボットホスト） |
| Claude Code | 既存契約 |
| Codex | 既存契約 |
| **合計追���費用** | **$20/月** |

Grok Bot（$30/月、1ランタイムのみ）と比較して、Nuphosは複数ランタイムを同時に使え、セルフホストなら追加費用ゼロで始められる。

## 4. オージャストでの試用シナリオ

### 4.1 ブース提案ボット（社内向け）

**現状**: ブース提案書の作成は人手。提案内容のフォーマット・パース・ドキュメント生成を毎回手動で行っている。

**Nuphos適用後**:
1. Nuphos上にClaude CodeをRuntimeとして登録
2. ブース提案用のSKILL.md（デザインルール・料金表・出展要項読込）を作成
3. 社内DiscordチャンネルにNuphos Botを参加
4. 「新規ブース提案」とDiscordに投稿 → Botが自律実行 → 結果をチャンネルに返す
5. 複数メンバーが同時に同じセッションを監視・修正指示

### 4.2 イベント資料作成ボット

**現状**: 展示会のパンフレット・チラシ・プレスリリースを都度人間が作成。

**Nuphos適用後**:
1. イベント資料生成用のClaude Codeセッションを常時稼働
2. スケジュールトリガー（cron）で「展示会前2週間は毎日資料生成チェック」
3. iOSアプリで外出先から進捗確認
4. 生成結果をチームでレビュー → そのまま修正依頼

### 4.3 問い合わせ自動仕分け（社外向け）

1. メール受信をWebhookでNuphosに転送
2. Claude Codeが内容を分析し「緊急度」「担当部署」「回答ドラフト」を生成
3. 結果をSlackチャンネルに通知
4. 人間が確認して承認 → 自動送信

## 5. 導入の手順

### 5.1 セルフホスト最小構成

```bash
# 1. リポジトリをクローン
git clone https://github.com/nuphos/nuphos.git
cd nuphos

# 2. Docker Composeで起動
docker compose -f deploy/compose/docker-compose.yml up -d

# 3. Resend APIキーを設定（メール認証用）
#    .env に RESEND_API_KEY を追加

# 4. 初回ユーザー作成
docker compose exec backend nuphos-admin create-user \
  --email seisaku-team@orgiast.jp

# 5. Desktopアプリをインストールしてサインイン
#    （サインイン画面 → "Self-hosted? Set API endpoint"）
```

### 5.2 Claude Code Runtimeの追加

1. Desktopアプリの Settings → Runtimes → Add runtime
2. Runtime type: 「Claude Code」
3. 初回サインインでClaude Code CLIの認証を通す
4. 利用可能なフォルダを指定

### 5.3 ボットの常時稼働

1. リモート/クラウドのComputerにRuntimeを追加（ラップトップを閉じても動く）
2. Agentを作成し、名前とアイコンを設定
3. セッションをチームで共有
4. トリガー設定（cron / Webhook）で自動起動

## 6. リスクと注意点

| リスク | 対策 |
|--------|------|
| セルフホストの運用負荷 | Docker Composeで最小限。MongoDBのバックアップは定期化必須 |
| メール認証にResend必須 | 無料枠（月100通）で十分。または `nuphos-admin` で初回ユーザー作成 |
| 認証情報の管理 | Claude CodeのトークンはNuphos Runtime内に保存。アクセス制御の設定を確認 |
| バージョンアップ | 互換性を確認してから。バックアップ必須 |
| まだ560スターの若いOSS | 機能は急速に進化中。ドキュメントと実動作の乖離に注意 |
| マネージドランタイムはセルフホスト不可 | 自前サーバーまたはNuphos Cloudが必要 |

## 7. 結論

Nuphosは **「既存のClaude Code / Codexサブスクリプションに追加費用ゼロでGrok Bot相当の機能を追加できる」** 稀有なOSSプラットフォームである。特にオージャストのようにClaude Codeを日常的に使い、社内ボット（ブース提案・イベント資料・問い合わせ仕分け）を運用した���場合、セルフホストで試せるハードルの低さが最大の魅力。

まずはDocker Composeでセルフホストを立ち上げ、1つのボット（例: ブース提案アシスタント）を動かして実用性を検証するのが推奨される。

---

**参照リンク:**
- [Nuphos 公式サイト](https://nuphos.ai/)
- [Nuphos ドキュメント — Introduction](https://docs.nuphos.ai/introduction)
- [Nuphos GitHub リポジトリ](https://github.com/nuphos/nuphos)
- [Nuphos ドキュメント — Billing](https://docs.nuphos.ai/billing)
- [Nuphos ドキュメント — Self-host](https://docs.nuphos.ai/self-host)