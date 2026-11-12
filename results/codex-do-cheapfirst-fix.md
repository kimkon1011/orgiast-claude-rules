# codex-do cheap-first 修正

- ブランチ: fix-codex-do-cheapfirst（origin/main から作成）
- implement は代替AIの実行前後の Git スナップショットを比較し、変更ゼロなら失敗として次の代替AI／Codexへ進む。
- 空出力、Unicode置換文字・不正制御文字・代表的な文字化け、unrecognized_model を含む出力は成功扱いしない。モデル認識エラーは stderr も検査する。
- Git 比較は HEAD と内容差分を使い、未ステージ・ステージ済み・コミット済みの変更を確認する。
- investigate/classify/summarize の既存経路は維持。
- 単体テストの既定環境を明示し、実機の CODEX_DO_CHEAP_FIRST 設定への依存を除去。

## 検証

- 修正対象の13テスト: 成功、失敗0。
- Windows: `node --test tools/codex-do*.test.mjs` 成功（257件中256成功・1件既存skip・失敗0、exit 0）。
- git diff --check: 成功。

## PR

標準手順 `node tools/pr-land.mjs --title <題> --body-file <本文>` で作成。

https://github.com/kimkon1011/orgiast-claude-rules/pull/1954

automerge ラベル付与済み。force push、ファイル削除、workflow変更、他ブランチ・他PRの変更なし。
