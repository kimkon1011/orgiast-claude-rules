# X-0020: スマホGrok経由Claude Codeのテスト付きサイト更新

**AIニュース提案 X-0020**: スマートフォンから Grok Bot にサイト更新のテキスト指示を送信 → Grok が指示を構造化 → Claude Code が実装 + テスト自動作成・実行 → 合否を Grok Bot へ返信 → プレビュー確認後ライブ配信。複数テストスイートと Git hooks による自動テスト実行で品質を担保する。株式会社オージャストのコーポレートサイト（orgiast.jp）やイベントページ更新に適用。

観測日: 2026-11-11
関連: X-0014（Grok Bot + Claude Code コーディング手順）、X-0005（AI Web Design 8-site workflow）

---

## 1. 概要

### 1.1 課題

オージャストのウェブサイト更新（コーポレートサイト・イベントページ・ブース紹介）は以下の課題を抱えている：

| # | 課題 | 現状 | 問題点 |
|---|------|------|--------|
| 1 | 現場からの更新依頼 | 担当者が PC で Claude Code を開く必要がある | 移動中・現場から即時指示できない |
| 2 | 品質担保 | 手動確認に依存 | リンク切れ・HTML 崩れ・SEO タグ漏れを見逃す |
| 3 | テスト欠落 | サイト更新時の回帰テストが無い | 意図しない副作用が本番に乗る |
| 4 | デプロイ手順 | 手動アップロード or 個別コマンド | 属人化・手順書必須 |

### 1.2 解決策

1. **スマホ → Grok Bot**: 現場からテキスト指示を送信（「トップページの実績数を3→5に更新して」）
2. **Grok → Claude Code**: Grok が指示を構造化JSONに変換し、Claude Code に渡す
3. **テスト自動生成**: 変更内容からテストスイートを自動選択・生成
4. **自動テスト実行**: Git hooks がコミット前に全テストスイートを実行
5. **合否 → Grok Bot**: 結果を Grok Bot へ返信、FAIL は修正指示付き
6. **プレビュー → ライブ**: PASS 後プレビューURLを確認し承認後にデプロイ

### 1.3 パイプライン図

```
スマホ（Grokアプリ）
  │
  │ テキスト指示: 「トップページの実績数を更新して」
  ▼
Grok Bot（リサーチ・構造化）
  │
  │ 構造化JSON（変更対象・種類・内容）
  ▼
┌─────────────────────────────────────────────────┐
│ site-deploy-pipeline（ブリッジツール群）          │
│                                                   │
│  ① grok-bot-prompt-bridge.mjs（X-0014）          │
│    → 構造化JSON → 実装プロンプト                 │
│                                                   │
│  ② Claude Code（変更実装）                       │
│    → コード生成＋テスト追加                      │
│                                                   │
│  ③ site-test-runner.mjs（テスト実行）             │
│    ├─ suite: HTML検証                             │
│    ├─ suite: リンクチェック                       │
│    ├─ suite: SEOメタチェック                      │
│    └─ suite: パフォーマンス基本チェック            │
│                                                   │
│  ④ grok-bot-test-report.mjs（結果報告）           │
│    → PASS/FAIL + 詳細を Grok Bot へ               │
└─────────────────────────────────────────────────┘
  │
  │ PASS → プレビューリンク送信
  │ FAIL → 修正指示 + 再テストループ（最大3回）
  ▼
プレビュー確認 → 承認 → ライブ配信
```

---

## 2. ツール構成

### 2.1 ツール一覧

| ツール | 役割 | 入力 | 出力 |
|--------|------|------|------|
| `site-test-runner.mjs` | テスト実行CLI | URL + オプション | JSON結果 |
| `site-test-suites.mjs` | テストスイート定義 | チェック対象データ | テスト結果配列 |
| `grok-bot-test-report.mjs` | Grok Bot 向けレポート生成 | テスト結果JSON | マークダウンレポート |
| `site-update-hook.mjs` | Git hook用スクリプト | gitイベント | 自動テスト起動 |

### 2.2 テストスイート一覧

| スイートID | 名称 | チェック内容 | フェイル条件 |
|-----------|------|-------------|-------------|
| `html-valid` | HTML検証 | 必須タグ存在（`<!DOCTYPE html>`, `<html lang="ja">`, `<meta charset="UTF-8">`, viewport, `<title>`, `<h1>`, `<main>`) | 1つ欠落でFAIL |
| `links` | リンクチェック | 同一サイト内リンクのステータスコード（200確認） | 1つでも404 or タイムアウトでFAIL |
| `seo-meta` | SEOメタチェック | title 30-60字・description 120-160字・h1 1つだけ・canonical存在・og:title存在 | いずれか違反でWARN |
| `performance` | パフォーマンス基本 | HTMLサイズ < 50KB、画像数 < 20 | 超過でWARN |
| `structure` | 構造チェック | h1→h2→h3 の階層飛び越しなし・`<img alt="">` 全件確認 | 飛び越しor alt欠落でFAIL |
| `wcag-basic` | アクセシビリティ基本 | フォーカス可能要素の tabindex > -1, コントラスト基準（簡易） | 違反でWARN |

### 2.3 スイートの自動選択（変更内容からの推論）

Grok Bot からの構造化JSONに含まれる `change_type` フィールドに応じて実行するスイートを最適化する：

| 変更種別 | 必須スイート | 推奨スイート |
|---------|-------------|-------------|
| `text`（文章修正） | html-valid, seo-meta | structure, wcag-basic |
| `layout`（レイアウト変更） | html-valid, structure, wcag-basic | performance |
| `link`（リンク追加・削除） | links, html-valid | seo-meta |
| `image`（画像追加・削除） | html-valid, wcag-basic | performance |
| `seo`（SEO関連修正） | seo-meta, html-valid, structure | links |
| `full`（新規ページ作成） | 全スイート | — |

---

## 3. hooks による自動テスト実行

### 3.1 Git hook（pre-commit）

`.claude/settings.json` に以下を設定し、サイト関連ファイルの変更時にテストを自動実行する：

```json
{
  "hooks": {
    "PreCommit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/tools/site-update-hook.mjs\"",
            "async": false,
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

### 3.2 hook の動作

1. 変更ファイル一覧を取得（git diff --cached --name-only）
2. サイトファイル（`.html`, `.css`, `.js`, `.md`）が含まれるか判定
3. 含まれる場合、サイトURLを検出（設定ファイル or 環境変数から）
4. `site-test-runner.mjs` を呼び出してテスト実行
5. FAIL の場合、コミットをブロックし修正を促す
6. PASS の場合、コミットを継続

### 3.3 スキップ条件

- 緊急修正（`[skip-site-test]` をコミットメッセージに含む）は hook をスキップ
- ドキュメントのみ（`.md` 単独）はスキップ

---

## 4. Grok Bot 連携フロー

### 4.1 スマホ → Grok Bot の指示例

```
ユーザー: 「orgiast.jp のトップページの実績数を3から5に増やして。
          最新の実績として「株式会社M」を追加。テストも作って。」

Grok Bot: 構造化JSONを生成（change_type: text, target: top page, content: ...）
```

### 4.2 Grok Bot → Claude Code の連携

```
Grok Bot が生成した構造化JSON:

{
  "change_type": "text",
  "target_url": "https://orgiast.jp/",
  "target_file": "index.html",
  "content": "実績セクションに「株式会社M（テスト自動化構築支援）」を追加",
  "required_suites": ["html-valid", "seo-meta", "links"],
  "preview_required": true,
  "deploy_on_approval": "confirm_only"
}
```

### 4.3 テスト結果の Grok Bot 返信フォーマット

```
✅ サイト更新テスト結果
━━━━━━━━━━━━━━━━━━━
対象: orgiast.jp トップページ
変更: 実績数 3→5（株式会社M追加）

📋 テスト結果
  html-valid: ✅ PASS（6/6 チェック合格）
  seo-meta:   ✅ PASS（title: 42字 ✓, description: 145字 ✓）
  links:      ⚠️ WARN（外部リンク2件未確認）

🔄 推奨アクション: リンクの確認後、承認してデプロイ可能

🔗 プレビュー: https://preview.orgiast.jp/pr-1234/
```

---

## 5. オージャストへの適用計画

### Phase 1: 基盤構築（今回）
- ✅ `site-test-runner.mjs` — テスト実行CLI
- ✅ `site-test-suites.mjs` — 6つのテストスイート
- ✅ `site-test-suites.test.mjs` — スイートのテスト
- ✅ `grok-bot-test-report.mjs` — Bot向けレポート
- ✅ `grok-bot-test-report.test.mjs` — レポーターのテスト
- ✅ `site-update-hook.mjs` — Git hookスクリプト

### Phase 2: CI/Grok連携
- GitHub Actions でテスト実行（`.github/workflows/site-test.yml`）
- Grok Bot API Webhook の登録
- プレビュー環境のセットアップ（Vercel Preview / GitHub Pages）

### Phase 3: 本番運用
- orgiast.jp 更新パイプラインへの適用
- イベントページ（rebooth.co.jp, 学会特設ページ等）への展開
- テスト結果の蓄積・経時変化の可視化

---

## 6. 期待効果

| 指標 | 目標 | 測定方法 |
|------|------|---------|
| 現場からの更新指示〜反映までのリードタイム | 従来比 50% 削減 | 更新依頼〜デプロイ時間の計測 |
| 本番障害（リンク切れ・HTML崩れ） | 0件/月 | テスト検出件数 + ユーザー報告 |
| テストカバレッジ | 全HTMLページ 100% | site-test-runner 実行結果 |
| スマホからの更新比率 | 全更新の 30% 以上 | 更新元のログ分析 |

---

## 7. 参考資料

- X-0014: Grok Bot + Claude Code コーディング手順（設計文書＋ブリッジツール）
- X-0005: AI Web Design 8-site workflow
- Google Lighthouse: https://developer.chrome.com/docs/lighthouse/
- WCAG 2.1: https://www.w3.org/TR/WCAG21/