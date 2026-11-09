# Phase1-crawl: 実HTTPクローリングの実装

## 概要
`skills/booth-kw-research/process/phase1-crawl.mjs` の `crawlPage()` 関数を、実HTTPクローリングで動作するよう実装する。現在は空配列を返すモック。

## 要件
1. `node:https` / `node:http` を使って実際のHTTPリクエストを行う
2. HTMLをパースして以下を抽出する:
   - ページタイトル (`<title>`)
   - H1見出し (`<h1>`)
   - メタディスクリプション (`<meta name="description">`)
   - 主要見出し (h2〜h3)
   - 同一ドメイン内のリンク (`<a href>`)
3. `robots.txt` をパースし、禁止パスをスキップする
4. 同一ドメイン内リンクを再帰的にクロールする (深さ制御: `config.settings.max_pages_per_site` / 最大階層3)
5. クロール間隔: 最低1秒 (config.settings.crawl_delay_s)
6. タイムアウト: 15秒 / リクエスト (config.settings.request_timeout_ms)
7. User-Agent: config.settings.user_agent を使用
8. 重複URLはスキップする (Set使用)

## HTMLパース方法
- `node-html-parser` が無ければインストール (`npm install node-html-parser`)
- または正規表現ベースの簡易パース (パッケージ追加不可の場合)

## 出力
既存の出力形式を維持:
```json
[
  {
    "domain": "https://orgiast.jp",
    "pages": [
      {
        "url": "...",
        "title": "...",
        "h1": "...",
        "description": "..."
      }
    ]
  }
]
```

## 変更してよいファイル
- `skills/booth-kw-research/process/phase1-crawl.mjs` のみ
- 必要なら `package.json` に node-html-parser を追加

## テスト検証
変更後は以下が通ること:
```
node --test skills/booth-kw-research/test/dryrun.test.mjs
```
dry-run モード (`--dry-run`) はネットワークを使わず、test/fixtures のデータを使う。
実クロールは `--dry-run` なしで起動した場合のみ動作する。

## 注意
- 既存の dry-run モードの振る舞いは変更しない
- エラーハンドリング: 個別ページの取得失敗は全体を止めずスキップし、エラー数をサマリ出力
- Windows パスを扱うため、path は `path.join`/`path.resolve` を使用
- 出力は `output/crawl-results.json` (実実行時)