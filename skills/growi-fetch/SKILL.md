---
name: growi-fetch
description: オージャストの Growi 社内マニュアル（orgiast-manual.com）の本文をコンテキストに取り込む手順。「マニュアルを見て」「Growi の○○ページ」「社内マニュアルによると」「業務手順を確認」など Growi / 社内マニュアル / orgiast-manual.com の内容参照が必要になったら必ずこのスキルを使う。WebFetch は認証必須のため禁止。
---

# Growi 本文取り込み（標準手順）

## 厳守 1: WebFetch 禁止
orgiast-manual.com は認証必須。Cookie/セッションを保持できない WebFetch は確実に失敗する。試行禁止。

## 厳守 2: Drive の Part を丸ごと読もうとしない
全文は Drive に **Part01〜Part14**（2026-08-30 時点。今後増える）の Google Docs として置かれているが、
**1 Part = 約 90 万文字 / 1.7MB** あり、`download_file_content` はトークン上限を超える。
下の CLI で**ページ単位**に引くこと（全 6,867 ページ / 1ページ平均 4KB）。

## 日常の使い方: status → search → get

```bash
node ~/orgiast-claude-rules/tools/growi-manual.mjs status              # 最初に必ず。鮮度と取得状況
node ~/orgiast-claude-rules/tools/growi-manual.mjs search 応募対応      # 該当ページ一覧（本文は出ない）
node ~/orgiast-claude-rules/tools/growi-manual.mjs get p0001           # そのページの本文だけ
```

- **`search`** はタイトルと内部パスを部分一致検索し `id / part / タイトル / 内部パス` の TSV を返す。
  **本文は絶対に返さない**ので何度打っても安全。`--path /13:人事部` で階層を絞る、
  `--body` で本文も検索（遅い・未取得 Part は対象外になり stderr に注意が出る）、`--limit N`（既定 20）。
- **`get`** は 1 ページの本文だけを出す。複数該当時は候補を出して exit 1（勝手に選ばない）。
- **`get` が exit 3 で止まったら**、そのページの Part の本文がまだ手元に無い。
  出力に **fileId と次にやる 2 手**が書いてあるので、そのとおりに実行する（下の「本文の取り寄せ」と同じ）。
- **`status` が exit 1**（キャッシュ無し）→ 下の「初回セットアップ」へ。`STALE` 警告が出たら user に報告してから進める。

## 初回セットアップ

### kim 環境（サービスアカウント鍵あり）
```bash
node ~/orgiast-claude-rules/tools/growi-manual.mjs sync
```
全 Part を取得して索引を作り、**続けて索引を Drive ハブへ発行する**（他アカウント向け）。約 80 秒。
夜間バッチにも配線済みなので、放っておいても索引は新しくなる。

### 他アカウント（鍵なし）— 索引を 2 ファイル取るだけ
**14 本すべてを落とす必要はない。** 索引だけ入れれば全 6,867 ページの検索がすぐ効く。

1. Drive MCP `search_files` で `parentId='1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw'`（共通ハブ）を検索し、
   **`growi-manual-index.tsv`** と **`growi-manual-meta.json`** の fileId を取る（**fileId はハードコードしない**）
2. それぞれ `download_file_content` を呼ぶ。索引は 1.5MB あるので
   「大きいのでローカルに保存した」と言われる — **それが正常**。保存パスを控える
3. ```bash
   node ~/orgiast-claude-rules/tools/growi-manual.mjs install-index <索引の保存パス> <metaの保存パス>
   ```
   引数の順序はどちらでもよい。`索引を取り込みました: Parts 14 / Pages 6867（本文は未取得）` と出れば完了。
   この時点で **`search` が全ページに効く**。

### Google Drive コネクタが無い / 未認可のとき

`search_files` や `download_file_content` が使えない（ツール一覧に Google Drive が無い、
認証が必要と言われる）場合、**索引を取り寄せる経路が塞がっている**。
このとき Claude は「できません」で終わらせず、**下の手順をそのまま user に提示する**こと。
承認は本人しかできない OAuth なので、ここだけは人の操作が要る。

> **Google ドライブ連携をオンにしてください（3分）**
>
> Claude が社内マニュアルを読むには、Claude と Google ドライブをつなぐ設定が必要です。
> あなたのアカウントでの承認が必要なため、お手数ですが以下をお願いします。
>
> 1. ブラウザで **https://claude.ai/settings/connectors** を開く
> 2. 右上のアカウント表示が **自分の orgiast.jp のアドレス**になっているか確認する
>    （個人の Gmail になっていたら、アバターをクリックして orgiast.jp のアカウントに切り替える）
> 3. 一覧から **Google Drive** を探して「接続」ボタンを押す
> 4. Google のログイン画面が出るので、**orgiast.jp のアカウント**を選ぶ
>    （ここで個人 Gmail を選ぶとマニュアルが見えないので注意）
> 5. 「許可」を押す
> 6. Claude Code に戻り、**いったん終了して開き直す**（コネクタは起動時に読み込まれるため）
> 7. 「マニュアル見て」ともう一度言う
>
> うまくいったか分からないときは、Claude に「Google ドライブのファイルを検索できる？」と
> 聞いてください。検索できれば成功です。

補足: Claude Code の対話セッションなら `/mcp` でも接続状態を確認・設定できる。
非対話セッションでは OAuth を実行できないので、上の手順を user に渡すこと。

### 本文の取り寄せ（必要になった Part だけ）
`get` が exit 3 で止まったら、その案内どおりに:
1. 表示された fileId を `download_file_content`（`exportMimeType: text/plain`）で呼ぶ → 保存パスを控える
2. `node ~/orgiast-claude-rules/tools/growi-manual.mjs ingest <保存パス>`

これでその Part の全ページが `get` できるようになる。たいてい 1〜2 Part で足りるので、
14 本落とす必要は無い。`ingest` は 1 本も取り込めなければ exit 1 で失敗する。

## 一次ソース（Drive）

- マニュアル本体フォルダ: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`
  （所有 seisaku-team@orgiast.jp / orgiast.jp ドメインに reader 共有。**一般公開ではない**）
- 索引の置き場: 共通ハブ `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`（`growi-manual-index.tsv` / `growi-manual-meta.json`）
- 運用 GAS:「社内マニュアル-NotebookLM連携」Script ID `1BVhALp3knyh4PaXGIre3v_ut6sOfWDMlAr_5S4yQM7-NGUzW-I5iLhIW`
- 元々は NotebookLM 用。Part 数は増えるので**決め打ちせず** `search_files` で実数を取る

## それでも足りないとき

1. **一次で不足/古い時**: user に個別 Markdown エクスポートを依頼（配置先 `docs/_source/growi/`、ファイル名は元ページタイトルのまま）。案内文:
   > 社内マニュアル_NotebookLM連携 フォルダのデータでは不足／古いので、対象ページを Growi で個別 Markdown エクスポートして `docs/_source/growi/` に置いてください（ファイル名は元のページタイトルのまま）。
2. **最終手段**: チャット貼り付け / PDF。

## 廃止済み経路
旧 `growi-rag` フォルダ（`1jVubtQMQ0zS5GlTYFjs9c5yrOZfVroV3`）は 2025-10-30 更新停止。緊急で旧版が必要な場合以外使わない。
