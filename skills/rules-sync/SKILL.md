---
name: rules-sync
description: オージャスト共通ルール Drive ハブ（claude-common-rules）との同期。「ルール同期」「共通ルール更新」「最新ルール取り込み」「rules sync」「ナレッジ統合して」「inbox マージ」などの依頼、または月初・大きなルール変更後に必ずこのスキルを使う。pull（全アカウント共通: Drive→ローカル反映）と merge（管理者: knowledge-inbox→正本統合）の2モード。
---

# rules-sync — Drive ハブ同期

Drive ハブ（正本）: `claude-common-rules` folder `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`（作業ファイル配下、owner kim@orgiast.jp）
サブフォルダ: rules=`1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4` / skills=`1oSlYjJdlIy5GRYa3-AasAeybARKh4v-E` / knowledge-inbox=`1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2`

## 前提となる Drive MCP 制約
- **ファイル本文の取得は必ず `download_file_content`（base64 → デコード）を使う**。`read_file_content` は自然言語表現に変換され `_` `[` 等がエスケープされて**ファイルが壊れる**（2026-07-06 実測）。read はフォルダ内容の人間向け確認のみ
- update/delete/move ツールが無い → MCP 経由の更新 = 同タイトルで create_file し直し。読む側は「同タイトル複数 → modifiedTime 最新を正」（search_files 結果の modifiedTime で判定）
- kim 環境には in-place 更新できる CLI がある: `node <orgiast-claude-rules>/scripts/drive-hub-sync.mjs push/pull/list`（SA DWD 認証、fileId 保持。90KB 級のファイルもコンテキストを消費しない）→ **kim 環境の push/pull はこちらを優先**
- fileId は版ごとに変わりうる → **ファイル ID をハードコードしない**（フォルダ ID のみ固定）
- MCP でアップロードする場合は `contentMimeType: text/plain` + `disableConversionToGoogleType: true`（Google Docs 変換させない）

## モード判定
- 「取り込み / 最新化 / 同期して」→ **pull**
- 「統合 / マージ / inbox 処理」→ **merge**（kim 環境のみ）。kim 環境で pull 実行時に inbox 未処理があれば merge も提案する

## pull（全アカウント共通）
1. `search_files parentId='1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw' and title contains 'manifest'` → modifiedTime 最新の manifest.json を read_file_content
2. ローカル `~/.claude/orgiast-rules-version.txt` の版番号と比較。同じなら「最新です」で終了
3. manifest の files を順に取得（該当フォルダを parentId 検索 → 同タイトルの最新を **download_file_content** で取得し base64 デコード）
4. 反映先:
   - `ONBOARDING.md` → プロジェクトの ONBOARDING ローカルマスター（kim 環境: `Downloads/CLAUDE.md配布/ONBOARDING.md`。無い環境は `~/.claude/ONBOARDING.md`）
   - `rules/*.md` → `~/.claude/rules/`
   - `skills/<name>.md` → `~/.claude/skills/<name>/SKILL.md`
   - `CLAUDE.md.template` → `~/.claude/CLAUDE.md` が**無い場合のみ**新規作成。既存があれば上書きせず差分を提示するだけ
5. 反映前に既存ファイルを `~/.claude/backups/` にバックアップ
6. `orgiast-rules-version.txt` を新版番号で更新 → 完了報告（版番号 + 反映ファイル一覧）

## merge（管理者 = kim 環境のみ）
1. knowledge-inbox を parentId 検索 → 最新の `knowledge-merged.json`（台帳）に載っていないファイルを列挙
2. 各投稿を read → 既存ルールとの重複・矛盾をチェック → 反映先を判定（ONBOARDING §x.x / rules/ / skills/ / 却下）
3. 反映案を1行/件で user に提示 → 承認後、**ローカル正本を編集**
4. 正本を Drive に再アップ（同タイトル create_file）→ `manifest.json` を version+1 で再アップ → `knowledge-merged.json` に処理済み（fileId / タイトル / 反映先 / 日付）を追記して再アップ
5. GitHub ミラー: `orgiast-claude-rules` repo に ONBOARDING / skills / rules を同期して commit + push
6. 完了報告に新 version と反映内容を列挙

## 注意
- 他アカウントは正本を直接編集しない（競合防止）。変更提案はすべて /share-knowledge 経由
- inbox の投稿は削除できない → 台帳方式で処理済み管理。古い版の正本は kim が Drive UI で任意にゴミ箱へ（放置しても latest-by-title で動作に支障なし）
