# マルチアカウント共通ナレッジ運用 詳細

ONBOARDING.compressed.md §2.10 の詳細。

## 2.10 マルチアカウント共通ナレッジ運用 — Drive ハブが正本

kim@orgiast.jp / seisaku-team@orgiast.jp / 他アカウントの Claude Code で得たノウハウ・ルールを全アカウント共通で適用するための仕組み。やり取りはすべて Google Drive 上で行い、各マシンのローカルファイルはキャッシュ、GitHub repo はミラー（履歴・plugin 配布用）と位置付ける。

ハブ（正本）: Drive `claude-common-rules`（作業ファイル配下、folder `1RLYbK6CKyPWRJsG6LY0WB9OzlbFYSFvw`、owner kim@orgiast.jp）

```
claude-common-rules/
├─ manifest.json          ← version 番号と配布ファイル一覧（同期判定の起点）
├─ ONBOARDING.md          ← 本ファイルの正本
├─ CLAUDE.md.template     ← 各自の ~/.claude/CLAUDE.md 雛形（既存がある人は上書きしない）
├─ rules/                 ← パススコープ別ルール (gas.md 等)      folder 1cNOSlo8pcrhXiRMRK_WD3O5IW-K9lYX4
├─ skills/                ← 共通スキル (<name>.md 形式)           folder 1oSlYjJdlIy5GRYa3-AasAeybARKh4v-E
├─ knowledge-inbox/       ← 各アカウントからのノウハウ投稿        folder 1AyZcrlK9JCNPUkhKCBOezet9a2QoSwK2
└─ knowledge-merged.json  ← 統合済み台帳
```

3つのフロー:

1. 下り（配布）: 各自の Claude Code で `/rules-sync`（pull）→ manifest の version をローカル版と比較 → 差分を `~/.claude/rules/`・`~/.claude/skills/`・ONBOARDING ローカルマスターに反映（反映前に `~/.claude/backups/` へバックアップ）。
2. 上り（収集）: どのアカウントでも、全社適用すべき学び（feedback / 失敗パターン / 新ルール）が出たら `/share-knowledge` → knowledge-inbox に md 投稿（date / account / type / target の frontmatter 付き、命名 `YYYYMMDD-<account>-<slug>.md`）。
3. 統合: kim 環境の `/rules-sync`（merge）が inbox の未処理分を列挙 → kim 承認後に正本へ反映 → manifest version+1 → GitHub `kimkon1011/orgiast-claude-rules` にミラー push。

Drive MCP の制約と、それを吸収する規約（update / delete / move ツールが存在しない）:

- 本文の取得は必ず `download_file_content`（base64 → デコード）。`read_file_content` は自然言語表現に変換され `_` `[` 等がエスケープされて同期ファイルが壊れる（2026-07-06 実測）。read はフォルダの人間向け確認のみに使う
- MCP 経由の更新 = 同タイトルで create_file し直し。読む側は「同タイトルが複数あれば modifiedTime 最新を正」とする（latest-by-title 規約）
- kim 環境には in-place 更新 CLI がある: `node <orgiast-claude-rules>/scripts/drive-hub-sync.mjs push/pull/list/share-domain`（SA `aujust-sheets-reader` の DWD で kim を impersonate、fileId 保持、大きいファイルでもコンテキスト消費ゼロ）→ kim 環境の push はこちらを優先
- fileId は版ごとに変わりうるため、ファイル ID のハードコード禁止（上記フォルダ ID のみ固定してよい）
- inbox の投稿は削除できない → `knowledge-merged.json` 台帳で処理済み管理
- MCP でアップロードする場合は `text/plain` + `disableConversionToGoogleType: true`（Google Docs に変換させない）

共有と役割分担: ハブは orgiast.jp ドメイン writer 共有設定済み（2026-07-06、SA 経由）。技術的には全員書けるが、正本の編集と version 管理は kim 環境のみという規約で運用する。他アカウントは pull と knowledge-inbox への投稿のみ（競合防止）。

新アカウントの初回セットアップ:
1. 各自の claude.ai で Google Drive コネクタを接続（自分の orgiast.jp アカウント）
2. 初回は §3.0 の貼り付けプロンプトでルール取り込み（GitHub public raw 経由、コネクタ不要）→ 以降の更新は `/rules-sync` で Drive ハブから

由来: 2026-07-06 kim「複数アカウントの Claude Code ノウハウを共通適用したい。やり取りはすべて Google Drive で」→ Claude Code はローカルファイルしか読み込めない制約 + Drive MCP の update 不可制約の下で、「Drive 正本 + /rules-sync ローカルキャッシュ + latest-by-title 規約 + inbox/台帳」で設計。
