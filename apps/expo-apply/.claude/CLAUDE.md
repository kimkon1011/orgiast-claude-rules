# expo-apply token-saving rules

このアプリでの調査・実装は、正確さと既存テストを保ったままコンテキスト消費を抑える。

- **token-savior (01):** ファイル全文を読む前に `rg -n "<識別子|文言>" apps/expo-apply` と `rg --files apps/expo-apply` で対象を絞る。必要な行範囲だけ読む。構造が不明な場合だけ範囲を広げる。
- **claude-token-efficient (02):** 依頼の言い換え、同意の前置き、一般論、作業実況を省く。結論・変更点・検証結果だけを簡潔に返す。
- **caveman (03):** 回答は短く、前置き不要。コードや技術用語は省略しない。完了時は結論と、実行コマンド・結果を示す小さな検証表だけを付ける。
- **context-mode (05):** 巨大なログや生成物は会話へ貼らず一時ファイルへ出力し、`rg` / `Select-String` でエラー・要点だけを取り出す。秘密情報を含む出力は保存・引用しない。
- **ccusage (09):** 作業前後または改善評価時に、リポジトリルートから `node tools/token-cost-report.mjs --days 30` を実行して推定コストを確認する。値は概算であり請求額として扱わない。

## 検証

変更箇所に応じて最小の検証から実行し、完了前に次を通す。

```sh
node --check apps/expo-apply/expo-apply-core.mjs
node --test apps/expo-apply/test/expo-apply.test.mjs
```

外部依存を追加しない。アプリの保存方式・外部送信なし・英日切替の既存仕様を、明示された変更依頼なしに変えない。
