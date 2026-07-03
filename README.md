# orgiast-claude-rules

オージャスト全社共通の Claude Code ルール・スキル配布リポジトリ（private）。

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
| rules | `rules/gas.md` | GAS 開発の絶対ルール（`~/.claude/rules/` にコピーすると .gs 編集時に自動適用） |
| doc | `ONBOARDING.md` | 全社共通の絶対ルール全文（詳細版） |

## CLAUDE.md に足すもの（手動コピー、plugin では配布されない）

各自の `~/.claude/CLAUDE.md` に最低限:

- Google Workspace URL は `/a/orgiast.jp/` を必ず挟む（ONBOARDING 参照）
- プロジェクト CLAUDE.md 冒頭に ONBOARDING.md への参照を1行入れる
