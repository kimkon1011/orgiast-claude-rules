# orgiast-claude-rules コードマップ

> **更新**: 2026-11-20  
> **目的**: AI コーディングエージェントがこのリポジトリの構造を理解し、正しいファイルを迅速に特定するための地図

## リポジトリの正体

| 項目 | 内容 |
|------|------|
| **リポジトリ名** | `orgiast-claude-rules` |
| **GitHub** | `https://github.com/kimkon1011/orgiast-claude-rules` |
| **正本** | Google Drive ハブ `claude-common-rules`（folder `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`） |
| **役割** | オージャスト全社共通の Claude Code ルール・スキル・hook・ツールの配布リポジトリ |
| **言語** | JavaScript (Node.js)、PowerShell（hook・bootstrap）、Markdown |
| **type** | `module`（ESM）|
| **テスト** | Node.js 組み込みテストランナー（`node --test`） |
| **該当PC** | 018 = DESKTOP-2D0R4LI（kim メイン機） |

## ディレクトリ構成（最上位）

```
orgiast-claude-rules/
├── tools/           # MJS ツール群 (1635ファイル) — 実質的なアプリケーションコード
├── docs/            # AIニュース提案・設計文書
├── skills/          # Claude Code スキルの Markdown 定義
├── .claude/         # Claude Code 設定 (agents/, memory/, settings.json)
├── config/          # JSON 設定ファイル群
├── apps/            # 各アプリケーションのプロトタイプ・評価コード
├── packages/        # 共有パッケージ
├── rules/           # パススコープ別ルール (.gs, .nextjs 向け)
├── protocols/       # 司令塔プロトコル (HANDOFF, DECISION, INCIDENT)
├── playbooks/       # シチュエーション別プレイブック
├── scripts/         # 大規模スクリプト (drive-hub-sync.mjs)
├── gas/             # Google Apps Script 連携コード
├── data/            # データファイル (automation/, booth-projects.json)
├── decisions/       # 設計判断記録 (DEC-*)
├── eval-driven/     # 評価駆動開発 (eval-set, schema, scripts)
├── tasks/           # タスク定義
├── ai-visibility/   # AI 可視化・スコアリング
├── analysis/        # 分析スクリプト
├── tests/           # テスト支援 (agent-tuning, fixtures)
├── templates/       # テンプレート
├── reports/         # レポート生成
├── research/        # 調査資料
├── runs/            # 実行ログ
├── outputs/         # 出力成果物
├── results/         # 結果データ
├── evidence/        # 証跡ファイル
├── portable-knowhow/ # ポータブルナレッジ
├── packages/        # 共有パッケージ
├── skills/          # スキル定義
├── config/          # JSON 設定
└── docs/            # マークダウン文書
```

## 主要コンポーネント詳細

### tools/ — 実行可能ツール群（最大のコードベース）

**形式**: Node.js ESM (`.mjs`) で実装。各ツールは原則同名の `.test.mjs` を持つ。

| カテゴリ | 例 | 説明 |
|----------|-----|------|
| **ゲート (gate)** | `lane-guard.mjs`, `handoff-regret-gate.mjs`, `user-burden-gate.mjs`, `url-format-guard.mjs`, `outbound-claim-evidence-gate.mjs`, `verify-before-done-detector.mjs` | 応答内容の自動検査・ブロック |
| **監視 (watch)** | `vehicle-inspection-watch.mjs`, `webhook-health.mjs`, `stuck-pr-sweeper.mjs`, `window-spawn-watch.ps1` | 定常監視・アラート |
| **自動化 (auto)** | `auto-progress.mjs`, `auto-tuner.mjs`, `agent-auto-tuner.mjs` | 自律進行・調整 |
| **セッション管理** | `close-session.mjs`, `session-claims.mjs`, `session-close.mjs`, `next-session.mjs` | セッションライフサイクル |
| **通知** | `notify-kim.mjs`, `ad-hoc-nag-monitor.mjs`, `unread-nag-monitor.mjs` | kim への通知・催促 |
| **インフラ** | `access-doctor.mjs`, `onboarding-sync.mjs`, `verify-setup.ps1`, `version-drift.mjs` | 環境診断・修復 |
| **委譲・実装** | `codex-do.mjs`, `cheap-code.mjs`, `lane-doctor.mjs`, `pr-land.mjs`, `pr-merge.mjs` | Codex/他AI への委譲・PR管理 |
| **分析・コスト** | `ai-cost-unify.mjs`, `cost-directive.mjs`, `cost-loop-guard.mjs`, `usage-stats.mjs` | 費用分析・監視 |
| **ユーティリティ** | `kim-inbox.mjs`, `fleet-mail*.mjs`, `fleet-*.mjs`, `gdoc-publish.mjs`, `design-deck.mjs` | 業務ユーティリティ |

**テスト**: `node --test tools/*.test.mjs` で全テスト実行。

### skills/ — Claude Code スキル定義

各スキルはディレクトリ単位で管理され、`SKILL.md` がエントリポイント。

| スキル | 用途 |
|--------|------|
| `autopilot/` | 無人運転（自律セッション進行） |
| `deploy-verify/` | Layer1/2 検証（変更後の動作確認） |
| `design-deck/` | ハイブリッド企画書制作 |
| `fleet-mail/` | メール処理自動化 |
| `gas-project-setup/` | GAS プロジェクト立ち上げ |
| `case-consult-sources/` | 案件調査ソース照会 |
| `case-resume/` | 案件再開 |
| 計 20+ スキル | 各種業務フロー |

### .claude/ — Claude Code 設定

```
.claude/
├── settings.json           # プロジェクト設定 (hooks, permissions)
├── agents/                 # エージェント定義
│   ├── Classifier.md
│   ├── Explore.md
│   ├── Extractor.md
│   ├── Implementer.md
│   └── LogReader.md
├── memory/                 # memory ファイル
└── comms-hub/             # 通信ハブ
```

### config/ — 設定ファイル（JSON）

| ファイル | 内容 |
|----------|------|
| `account-inventory.json` | アカウント在庫管理 |
| `ai-key-owners.json` | AI キー所有者管理 |
| `auto-resume.json` | 自動再開設定 |
| `comms-hub.json` | 通信ハブ設定 |
| `external-send-registry.json` | 社外送信許可リスト |
| `mail-groups.json` | メールグループ |
| `staff-addresses.json` | スタッフアドレス帳 |
| `lane-guard.json` | レーンガード設定 |

### protocols/ — 司令塔プロトコル

| プロトコル | 用途 |
|-----------|------|
| `HANDOFF.md` | セッション間引き継ぎ実行指示 |
| `DECISION-TEMPLATE.md` | 判断テンプレート |
| `INCIDENT-TYPES.md` | 事故の型カタログ |
| `INTAKE-TWO-AXES.md` | 2軸イテーク分類 |
| `LEARNING-LEDGER.md` | 学びの台帳 |

### docs/ — AIニュース提案・設計文書

命名規則: `ai-news-x{数字}-{英題}.md`（例: `ai-news-x0055-agent-loop-cache.md`）。  
新規提案 → `pr-body-x{数字}.md` → `PR #` → merge 後の doc。

## テスト実行

```sh
# 全ツールのテスト実行
node --test tools/*.test.mjs

# 特定のテストのみ
node --test tools/lane-guard.test.mjs tools/pr-land.test.mjs
```

## AI エージェントのナビゲーションガイド

| 目的 | 読むべきファイル |
|------|-----------------|
| リポジトリ全体を把握 | `README.md`, `docs/code-map.md`（本ファイル） |
| 全社ルールを確認 | `ONBOARDING.md`（巨大、必要節だけ Grep） |
| スキルの使い方を調べる | `skills/<name>/SKILL.md` |
| ツールの動作を確認 | `tools/<name>.mjs`（コード） + `tools/<name>.test.mjs`（テスト） |
| 新しい AI ニュース提案を追加 | `docs/ai-news-x{数字}-*.md` を参照、`pr-body-x{数字}.md` を作成 |
| ゲートの挙動を理解 | `tools/*-gate.mjs`, `tools/*-guard.mjs` |
| セッション管理フロー | `tools/close-session.mjs`, `tools/session-claims.mjs`, `.claude/agents/` |
| テスト追加方法 | `tools/*.test.mjs` の既存パターンに従う |
| 設定変更 | `config/*.json` + `.claude/settings.json` |
| 設計判断の経緯 | `decisions/DEC-*.md` |
| 事故の型（再発防止） | `protocols/INCIDENT-TYPES.md` |

## 開発の定石

1. **テストファースト**: ツール変更は既存テストが緑であることを確認してから。
2. **型で直す**: 不具合は `protocols/INCIDENT-TYPES.md` に型を登録 → 同型を横断修正 → ゲートを追加。
3. **セッション境界を意識**: `tools/close-session.mjs` で正しく締め、`protocols/HANDOFF.md` で引き継ぐ。
4. **Codex 委譲**: 実装は `tools/codex-do.mjs`、監督（Claude）は設計・レビュー・検証のみ。
5. **PR 着地**: `tools/pr-land.mjs` で base へ push し着地させる。