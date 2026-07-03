---
name: growi-fetch
description: オージャストの Growi 社内マニュアル（orgiast-manual.com）の本文をコンテキストに取り込む手順。「マニュアルを見て」「Growi の○○ページ」「社内マニュアルによると」「業務手順を確認」など Growi / 社内マニュアル / orgiast-manual.com の内容参照が必要になったら必ずこのスキルを使う。WebFetch は認証必須のため禁止。
---

# Growi 本文取り込み（標準手順）

## 厳守: WebFetch 禁止
orgiast-manual.com は認証必須。Cookie/セッションを保持できない WebFetch は確実に失敗する。試行禁止。

## 一次ソース: Drive「社内マニュアル_NotebookLM連携」フォルダ
- **Folder ID**: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`（所有: seisaku-team@orgiast.jp）
- Growi 全マニュアルが **13 個の Google Docs**（`社内マニュアル_NotebookLM連携_Part01`〜`_Part13`、各 ~450KB）に分割され定期更新
- 運用 GAS:「社内マニュアル-NotebookLM連携」Script ID `1BVhALp3knyh4PaXGIre3v_ut6sOfWDMlAr_5S4yQM7-NGUzW-I5iLhIW`

## 手順
1. **鮮度チェック（必須・最初に）**: Part 群の `modifiedTime`（Drive MCP `get_file_metadata`）と description 内「最終更新: YYYY/MM/DD」を確認。**3ヶ月以上古ければ user に報告**して stale で進めるか確認。
2. **対象 Part の特定**: 13 Parts 全読みは高コスト。質問中の部署名/タイトル/URL を手がかりに該当 Part だけ `read_file_content`。不明なら Part01 で目次構造把握 → 推定 → 該当 Part。13 Parts 超に拡張されていたら `search_files parentId='1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B'` で実数取得。
3. **一次で不足/古い時**: user に個別 Markdown エクスポートを依頼（配置先 `docs/_source/growi/`、ファイル名は元ページタイトルのまま）。案内文:
   > 社内マニュアル_NotebookLM連携 フォルダのデータでは不足／古いので、対象ページを Growi で個別 Markdown エクスポートして `docs/_source/growi/` に置いてください（ファイル名は元のページタイトルのまま）。
4. **最終手段**: チャット貼り付け / PDF。

## 廃止済み経路
旧 `growi-rag` フォルダ（`1jVubtQMQ0zS5GlTYFjs9c5yrOZfVroV3`）は 2025-10-30 更新停止。緊急で旧版が必要な場合以外使わない。
