# Growi 社内マニュアル取り込み 詳細

ONBOARDING.compressed.md §2.7 の詳細。

## 2.7 Growi マニュアル取り込みは Google Drive 一次ソース

オージャストの社内 Wiki（Growi: `https://orgiast-manual.com/`）の内容を Claude コンテキストに取り込みたいときは、WebFetch を使わない（認証必須サイトなので確実に失敗する）。

代わりに:
- 一次ソース: Google Drive フォルダ `社内マニュアル_NotebookLM連携`（Folder ID: `1LMRI2jFpVG3WnDYlepgbOuyJ6ZBYzI8B`）
- 13 個の Google Docs（Part01 〜 Part13）に分割されている
- Google Drive MCP の `read_file_content` で読む
- 必ず最初に `modifiedTime` または description 内の「最終更新: YYYY/MM/DD」で鮮度チェック
- 3ヶ月以上古い場合はユーザーに報告して、stale で進めるか確認
- 該当ページがフォルダに無い／古い場合は、ユーザーに Growi で個別 Markdown エクスポートを依頼（`docs/_source/growi/` 配下、ファイル名は元ページタイトルのまま）

（実運用では `/growi-fetch` skill がこの手順をカプセル化している。）
