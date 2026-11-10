# X-0010: AIコーディング用インタラクティブUIライブラリ — transitions.dev 統合設計書

> 2026-11-10 設計。自動セッションによる初回実装。

## 概要

transitions.dev（44+ transitions, 30+ interactive components）を Claude Code / Cursor / Codex の **Motion Skill** および **MCP** として統合し、株式会社オージャストの展示会ブース受付サイト（`apps/expo-apply/`）にインタラクティブなブースプレビューとトランジションを追加する。

## transitions.dev が提供する機能

| 機能 | 説明 | 統合方法 |
|------|------|---------|
| **Library** | 43+のプロダクション用CSSトランジション（CSS変数で調整可能） | `.t-*` 名前空間のスニペットとしてコピーまたは `npx transitions-dev add --free` |
| **Motion Skill** | AIエージェントがトランジションを理解・生成するための指示書 | `npx skills add Jakubantalik/transitions.dev` |
| **Motion Agent** | コードベースをスキャンしモーションスコア(0-100)を計算、自動修正PR | `npx transitions-agent` / `npx transitions-agent fix --pr` |
| **MCP** | Builderエージェントをコーディングエージェントから呼び出す | npx 経由のCLI統合 |
| **Builder** | AIエージェントと対話してコンポーネントを生成（HTML/CSS or React） | ブラウザ上のプロンプトインターフェース |

### インストール方法（全AIコーディングツール共通）

```bash
# Free transitions をプロジェクトへ追加
npx transitions-dev add --free

# AIエージェントへ Skill としてインストール（Claude Code/Cursor/Codex/GitHub Copilot/Gemini CLI）
npx skills add Jakubantalik/transitions.dev

# Motion Agent でコードベースをスキャン
npx transitions-agent

# CI に Motion Agent を組み込む
npx transitions-agent init-ci
```

### トランジションの特徴

- **Compositor-friendly**: `transform`, `opacity`, `filter` のみ使用。`will-change` は最小限
- **アクセシビリティ**: `@media (prefers-reduced-motion: reduce)` 対応。DOMとテキストで状態を表現
- **単一のモーショントークン**: duration, easing, distance, blur, scale を CSS 変数で一元管理
- **名前空間**: `.t-*` クラスでカプセル化（競合防止）

## オージャスト適用計画

### 対象アプリケーション

`apps/expo-apply/` — 海外企業向け日本展示会出展受付サイト

### 追加するトランジション

| トランジション | 適用箇所 | 効果 |
|--------------|---------|------|
| Card resize | ヒーローセクションのブースサイズ選択 | ブースサイズ変更時にカードが滑らかにリサイズ |
| Modal open/close | 申込詳細モーダル | スケールトランジションで開閉 |
| Tabs sliding | サービス選択 | アクティブなタブに沿ってインジケータがスライド |
| Notification badge | ステータス変更の通知 | 斜めスライド + スプリング |
| Toast open/close | アラートバナー | フェード + ブラー + スケールで出現/消滅 |
| Toggle | 言語切替（EN/JA） | ダブルバウンスのトグル |
| Checkbox check | サービス選択のチェックボックス | ストロークパスでチェック描画 |
| Confetti burst (Pro) | 申込完了時 | 申込成功を祝福 |
| Spinning counter | 統計バーの数値表示 | 3Dドラムで数値が回転 |
| Accordion | FAQ | グリッド行の高さ + 矢印モーフィング |
| Like button | お問い合わせ完了 | ハート + パーティクル |

### ブースインタラクティブプレビュー（新規追加）

`apps/expo-apply/booth-preview.html` として追加する独立したコンポーネント：

```
[ブースサイズ選択] → [3D tilt + カードリサイズ] → [パネルリビールで内装プレビュー]
                                         ↓
                              [装飾オプション（スライディングタブ）]
                                         ↓
                              [リアルタイム3Dプレビュー（マウス追従）]
```

## AIコーディングツール別の統合手順

### Claude Code
```bash
# Skill の追加（1回）
npx skills add Jakubantalik/transitions.dev

# 使用例（Claude Code 内で）
# /transitions-ui "ブースプレビューページに3D tiltとカードリサイズを追加"
```

### Cursor
```bash
npx skills add Jakubantalik/transitions.dev
# Cursor の Composer / Chat で "Add a card resize transition to this booth selector"
```

### Codex
```bash
npx transitions-dev add --free
# または npx skills add Jakubantalik/transitions.dev
# Codex に `.t-*` クラスを使ったコンポーネント生成を指示
```

### 共通の使い方（全ツール）
1. `npx skills add Jakubantalik/transitions.dev` でスキルを追加
2. AIエージェントに「[transition名] を [要素] に追加して」と指示
3. エージェントが適切な `.t-*` スニペットを挿入
4. Motion Agent でモーション品質をスコアリング・改善

## 実装アーキテクチャ

```
skills/transitions-ui/
├── SKILL.md            # スキル定義（AIエージェントへの指示）
├── samples/
│   ├── booth-preview/  # ブースプレビュー用サンプルトランジション
│   │   ├── preview.html  # 3D tilt + card resize + panel reveal
│   │   └── preview.css   # トランジションCSS定義
│   └── common/           # 共通トランジション定義
│       ├── modal.css     # Modal open/close
│       ├── toast.css     # Toast open/close
│       └── tabs.css      # Tabs sliding

apps/expo-apply/
├── index.html           # 既存（トランジション追加）
├── booth-preview.html   # 新規：ブースインタラクティブプレビュー
└── transitions.css      # transitions.dev 互換のCSS変数定義
```

## 検証方法

```bash
# Node.js の構文チェック（該当ファイルのみ）
node --check apps/expo-apply/expo-apply-core.mjs

# テスト実行
node --test apps/expo-apply/test/expo-apply.test.mjs

# Motion Agent によるスコアリング（実装後）
npx transitions-agent
```

## 禁止事項
- transitions.dev Pro コンテンツ（confetti-burst, gooey-plus-menu, card-stack-hover, drag-drop-with-physics, spinner-to-check-morph 等）はライセンス未確認のため使用しない
- 既存ファイルの書き換えは最低限とし、新規ファイルを優先
- 外部APIへの自動送信・デプロイを行わない
- Claude API（anthropic）は使わない

## 期待効果
1. ブース申込フォームのUX向上：操作フィードバックが視覚的で直感的に
2. コンバージョン率改善：インタラクティブなブースプレビューで申込意欲向上
3. AIコーディング効率：Claude Code/Cursor/Codex が共通の `.t-*` ライブラリでUI生成
4. メンテナンス性：モーショントークンのCSS変数一元管理で一貫性確保
5. アクセシビリティ：prefers-reduced-motion + DOM状態表現で全てのユーザに対応