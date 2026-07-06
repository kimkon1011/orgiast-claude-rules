# orgiast-claude-rules

オージャスト全社共通の Claude Code ルール・スキル配布リポジトリ。

> **正本は Google Drive ハブ** `claude-common-rules`（folder `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`、orgiast.jp ドメイン共有済み）。この repo はミラー（履歴管理・plugin 配布用）。
> - ルールの取り込み・更新: 各自の Claude Code で `/rules-sync`
> - ノウハウの投稿（全アカウント共通化したい学び）: `/share-knowledge` → `knowledge-inbox/` へ
> - 統合と version 管理: kim 環境の `/rules-sync`（merge）のみ。同期 CLI: `scripts/drive-hub-sync.mjs`
> - 詳細設計: ONBOARDING.md §2.10

## インストール（社員向け・1回だけ）

GitHub にログイン済みの Claude Code で:

```
/plugin marketplace add kimkon1011/orgiast-claude-rules
/plugin install orgiast-rules@orgiast
```

以後の更新は `/plugin` から update するだけで全スキルが同期されます。

## 含まれるもの

| 種類 | 名前 | 用途 |
|---|---|---|
| skill | `gas-project-setup` | 新規 GAS 立ち上げ標準手順（clasp + コマンドキュー、手作業は setupOnce 1クリックのみ） |
| skill | `growi-fetch` | Growi 社内マニュアルの取り込み手順（Drive 一次ソース、WebFetch 禁止、鮮度チェック） |
| skill | `deploy-verify` | 変更後の2段検証（Layer1 ロジック再現 + Layer2 Playwright 実描画）を通してから完了報告 |
| skill | `rules-sync` | Drive ハブとの同期（pull = 全アカウント / merge = kim 環境で inbox 統合） |
| skill | `share-knowledge` | 学んだノウハウを Drive ハブの knowledge-inbox に投稿（全アカウント共通化の入口） |
| rules | `rules/gas.md` | GAS 開発の絶対ルール（`~/.claude/rules/` にコピーすると .gs 編集時に自動適用） |
| doc | `ONBOARDING.md` | 全社共通の絶対ルール全文（詳細版） |

## CLAUDE.md に足すもの（手動コピー、plugin では配布されない）

各自の `~/.claude/CLAUDE.md` に最低限:

- Google Workspace URL は `/a/orgiast.jp/` を必ず挟む（ONBOARDING 参照）
- プロジェクト CLAUDE.md 冒頭に ONBOARDING.md への参照を1行入れる
