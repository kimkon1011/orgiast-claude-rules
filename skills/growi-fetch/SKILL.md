---
name: growi-fetch
description: オージャストの Growi 社内マニュアル（orgiast-manual.com）の本文をコンテキストに取り込む手順。「マニュアルを見て」「Growi の○○ページ」「社内マニュアルによると」「業務手順を確認」など Growi / 社内マニュアル / orgiast-manual.com の内容参照が必要になったら必ずこのスキルを使う。WebFetch は認証必須のため禁止。
---

# Growi 本文取り込み（標準手順）

## 厳守 1: WebFetch 禁止
orgiast-manual.com は認証必須。Cookie/セッションを保持できない WebFetch は確実に失敗する。試行禁止。

## 厳守 2: Drive の Part を丸ごと読もうとしない
全文は Drive に **Part01〜Part14**（2026-08-28 時点。今後増える）の Google Docs として置かれているが、
**1 Part = 約 90 万文字 / 1.7MB** あり、Drive MCP `download_file_content` はトークン上限を超えて失敗する。
Part を直接読むのではなく、下記 CLI で**ページ単位**に引くこと（全 6,867 ページ / 1ページ平均 4KB）。

## 手順: `tools/growi-manual.mjs` で search → get

```bash
node ~/orgiast-claude-rules/tools/growi-manual.mjs status              # 鮮度とキャッシュ有無を確認（最初に必ず）
node ~/orgiast-claude-rules/tools/growi-manual.mjs search 応募対応      # 該当ページ一覧（本文は出ない）
node ~/orgiast-claude-rules/tools/growi-manual.mjs get p0001           # そのページの本文だけ取得
```

1. **`status`（必須・最初に）** — Parts 数・総ページ数・各 Part の更新日時・`syncedAt` が出る。
   - キャッシュが無い（exit 1）→ 下の「初回セットアップ」へ
   - `STALE` 警告（最新 Part が 90 日以上前）→ user に報告してから進める
2. **`search <キーワード>`** — タイトルと内部パスを部分一致検索し、`id / part / タイトル / 内部パス` の TSV を返す。
   **本文は絶対に返さない**ので何度打っても安全。
   - `--path /13:人事部` で部署配下に絞る
   - `--body` で本文も検索対象にする（遅い。タイトルで当たらない時だけ）
   - `--limit N`（既定 20）
3. **`get <id|内部パス|タイトル>`** — 1 ページの本文だけを出力する。複数該当時は候補を出して exit 1（勝手に選ばない）。
4. 部署名や用語が分からず search が空振りする時は、`--body` か、内部パスの階層（`/12:営業部` `/13:人事部`
   `/33:クライアント情報` など）を `--path` で当てて探索する。

## 初回セットアップ（キャッシュが無いとき）

**kim 環境（SA 鍵あり）** — 1 コマンドで完結。約 80 秒。
```bash
node ~/orgiast-claude-rules/tools/growi-manual.mjs sync
```

**他アカウント（SA 鍵なし）** — Drive MCP で Part を落として `ingest` する。
1. `search_files parentId='1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B'` で Part の fileId を全部取る
2. 各 Part を `download_file_content`（`exportMimeType: text/plain`）で呼ぶ。
   サイズ超過で「ローカルに保存した」と言われるので、**その保存パスを控える**（これが正常な動作）
3. 保存パスをまとめて渡す:
   ```bash
   node ~/orgiast-claude-rules/tools/growi-manual.mjs ingest <保存パス1> <保存パス2> ...
   ```
   MCP 保存 JSON（base64）と生 txt の両方を受け付ける。取り込み後は自動で索引を作り直す。

## 一次ソース（Drive）

- **Folder ID**: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`（所有: seisaku-team@orgiast.jp、orgiast.jp ドメインに reader 共有済み）
- 運用 GAS:「社内マニュアル-NotebookLM連携」Script ID `1BVhALp3knyh4PaXGIre3v_ut6sOfWDMlAr_5S4yQM7-NGUzW-I5iLhIW`
- 元々は NotebookLM に読ませる目的で作られたもの。Part 数は増えるので**ハードコードせず** `search_files` で実数を取る

## それでも足りないとき

1. **一次で不足/古い時**: user に個別 Markdown エクスポートを依頼（配置先 `docs/_source/growi/`、ファイル名は元ページタイトルのまま）。案内文:
   > 社内マニュアル_NotebookLM連携 フォルダのデータでは不足／古いので、対象ページを Growi で個別 Markdown エクスポートして `docs/_source/growi/` に置いてください（ファイル名は元のページタイトルのまま）。
2. **最終手段**: チャット貼り付け / PDF。

## 廃止済み経路
旧 `growi-rag` フォルダ（`1jVubtQMQ0zS5GlTYFjs9c5yrOZfVroV3`）は 2025-10-30 更新停止。緊急で旧版が必要な場合以外使わない。
