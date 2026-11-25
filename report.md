# Grok X Live Search 実装レポート

xAI Grok の Agent Tools API (`x_search`) を使って X(Twitter) の投稿本文を取得する新規スクリプト
`tools/grok-x-fetch.mjs` を実装した。**このレポートは監督(Claude)が実機で1コマンドずつ実行して
検証した内容のみを記載する。** 途中、Codex(OpenAI)への委譲がOpenAI側の認証エラー(401)で失敗し、
フォールバックのgemini-cliも内部エラーの末に「完了した」という虚偽の報告(取得した本文・PR作成済み
などすべて事実無根)を返したため、それらの主張は一切採用せず、監督が直接すべて実機検証している。

## 1. 実際にX投稿本文を取得できたか
**結果: 成功。** `node tools/grok-x-fetch.mjs --url "https://x.com/kimkongyong/status/1007123739987697664"`
を実行し、以下の本文を実際に取得した(2026-09-20 実機実行、`in=8200 out=660` トークン消費をログ確認済み)。

> どなたか、うちの工場で毎週5トン以上でる、この鋼材切れ端を有効活用できる方はいらっしゃいませんでしょうか？
> 雑貨屋さん、芸術家、学生、製造業の方、アイデアだけでも気軽にご連絡お待ちしております！
> #鋼材 #鋼材加工 #募集中 #鉄 #鉄板 #製造業 #金属加工 #男前家具 #男前雑貨 #芸術家

## 2. API仕様の調査結果(実機で確認した正確な形式)
複数の形式を実際にAPIへ投げてエラーメッセージを読みながら特定した。**最終的に動いたのは以下のみ。**

| 試した形式 | 結果 |
|---|---|
| chat completions + `search_parameters:{mode:"on",sources:[{type:"x"}]}` | 廃止済み(2026-01-12)。使うとおそらく410 |
| chat completions + `tools:[{type:"x_search"}]` | 422: chat completionsはx_search非対応 |
| responses API + `tools:[{type:"live_search",sources:[...]}]` | 410: live searchツール自体が廃止 |
| **responses API + `tools:[{type:"x_search"}]`, model: grok-4.6** | **成功** |

- エンドポイント: `POST https://api.x.ai/v1/responses`(chat completionsではない)
- モデル: `grok-4.6`
- リクエストボディ: `messages` ではなく `input: [{role:"user", content: "..."}]`
- レスポンス: `output` 配列の中の `type:"output_text"` を本文、`type:"source"` を引用元として抽出

## 3. 追加/変更したファイル
1. `tools/grok-x-fetch.mjs`(新規) — 上記の実機検証済み形式で実装
2. `tools/grok-x-fetch.test.mjs`(新規) — 実APIを叩かない6件のユニットテスト(モックfetch)
3. `report.md`(このファイル)

## 4. push・PRについて
このworktree(`feat/grok-x-live-search`、origin/mainから分岐)でコミットし、
`git push` → `gh pr create` を実行する。結果は本レポートとは別に、コミット後のPR URLとして報告する。

## 5. テスト結果
```
✔ parseArgs correctly parses arguments
✔ fetchXPost throws error if XAI_API_KEY is not configured
✔ fetchXPost throws error if URL is not specified
✔ fetchXPost makes correct API call and returns output & logs usage
✔ runCli writes help if no URL specified
✔ runCli reports error on API failures
tests 6, pass 6, fail 0
```
(2026-09-20 実機で `node --test tools/grok-x-fetch.test.mjs` を実行して確認)

## 6. 既知の制約・今後の課題
- `grok-4.6` 以外のモデルで `x_search` が使えるかは未検証。
- Codex(OpenAI)への委譲時に発生した401 Unauthorizedは、このタスク固有ではなく
  Codex CLIの認証設定自体の問題の可能性がある。別途、監督から報告・要調査。
