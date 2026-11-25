# 実装依頼: kim の DM 返信を GitHub Issue/PR のコメントに落とす夜間ジョブ

対象リポジトリ: `C:\Users\uers\Downloads\orgiast-claude-rules`
新規: `tools/feedback-replies.mjs` と そのテスト
改修: `tools/feedback-to-issues.mjs`（Issue 本文にマーカーを1行足すだけ）, `tools/nightly-batch.ps1`（登録）

## 背景（本番稼働中の既存フロー）

1. 各アプリのフォーム → 中継 `POST /api/feedback-intake` → **kim の Discord DM**
2. 夜間 `tools/feedback-to-issues.mjs` が中継の `GET ?pending=1` を読み、`gh` で GitHub Issue を作り、
   成功したら `POST /api/feedback-intake/ack` で ✅ を付けて既読化
3. 夜間 `tools/auto-session.mjs` が `feedback` ラベルの open Issue を拾って修正 → PR

**足りないもの**: kim が DM に**返信**して「これはこう直して」と指示しても、誰も読んでいない。

中継側に次の 2 つを**新設中**（別担当が実装中。この仕様どおりに出てくる前提で書いてよい）:

- `GET /api/feedback-intake/replies?limit=N`
  → `{ ok:true, items:[{ reply_id, created_at, content, replied_to_message_id,
       replied_to_kind:"feedback"|"notify", replied_to_excerpt, replied_to_urls:string[], discord_url }] }`
  未処理（✅ が付いていない）の kim 本人の返信だけを古い順で返す。
- `POST /api/feedback-intake/replies/ack` 本文 `{ message_id }` → その返信に ✅ を付ける。

認証は既存 `tools/feedback-to-issues.mjs` と**同じ**（`~/.claude/feedback-relay.env` の
`FEEDBACK_RELAY_URL` / `FEEDBACK_RELAY_SECRET`）。**env の読み込みは既存の実装を再利用すること**
（`parseEnvText` 等を import する。二重定義しない）。

## 実装するもの

### 1. `tools/feedback-to-issues.mjs` の `buildIssueBody` にマーカーを足す

Issue 本文の末尾に、機械可読な 1 行を足す:

```
<!-- feedback-dm:<message_id> -->
```

これで「どの DM から生まれた Issue か」を後から検索できる。
**既存の行の内容・順序は変えないこと**（テストが通らなくなる）。既存テストがあれば期待値を更新する。

### 2. `tools/feedback-replies.mjs`（新規）

`node tools/feedback-replies.mjs [--limit N] [--dry] [--dismiss <message_id>]`

処理:

1. `GET <relay>/api/feedback-intake/replies?limit=N`（既定 20）
2. 各返信について、コメント先を決める:
   - **`replied_to_urls` に GitHub の Issue または PR の URL があれば、そこにコメントする**（最優先）。
     URL 判定は `https://github.com/<owner>/<repo>/(issues|pull)/<番号>` の形。
   - 無ければ `gh search issues "feedback-dm:<replied_to_message_id>" --json repository,number --limit 5`
     でマーカー検索し、**ちょうど 1 件**に絞れたらそこにコメントする。
   - 0 件 or 2 件以上なら**コメントせず ack もしない**（推測で書き込まない）。
     `console.log` に理由と `reply_id` を出す。
3. コメント本文:
   ```
   kim からの実行指示（Discord DM 返信 / <created_at をJSTで>）

   <content>

   <!-- feedback-reply:<reply_id> -->
   ```
   `gh issue comment <番号> --repo <owner/repo> --body-file <一時ファイル>` で投稿する
   （PR も `gh issue comment` でコメントできる）。**本文は argv で渡さない**
   （改行・バッククォートがシェルに食われるため必ず `--body-file`）。
4. 投稿に成功したものだけ `POST /api/feedback-intake/replies/ack` で ✅ を付ける。
   ack に失敗したら警告を出す（次回重複コメントの可能性を明示）。
5. `--dry` は取得と判定だけして書き込まない。
6. `--dismiss <message_id>` は ack だけ打って対象外にする（既存 `feedback-to-issues.mjs` の
   `--dismiss` と同じ使い勝手・同じ出力の作法に合わせる）。

**無人ループの安全装置（必須）**:
- 1 回の実行でコメントするのは最大 `--limit` 件（既定 20）。
- 同じ `reply_id` に二重コメントしないよう、投稿前に**コメント本文のマーカー
  `<!-- feedback-reply:<reply_id> -->` が既に存在しないか**を
  `gh issue view <番号> --repo <r> --json comments` で確認する。あればコメントせず ack だけする。

### 3. `tools/nightly-batch.ps1` に登録

既存の `feedback-to-issues.mjs` の**直後**に `feedback-replies.mjs` を実行する行を足す
（Issue が作られた後に返信を載せるため順序が重要）。既存行の書き方に合わせること。

### 4. テスト

このリポジトリの既存テスト（`tools/*.test.mjs`）の流儀に合わせて、
**ネットワークと `gh` に繋がずテストできる純関数**に切り出してからテストを書く:
- `pickCommentTarget(reply, searchResults)` … URL 優先 / マーカー検索 1 件のみ採用 / 0件・複数件は null
- `buildReplyComment(reply)` … マーカー行が末尾に入る
- `hasAlreadyCommented(comments, replyId)`

## 制約

- `npm install` を実行しないこと（依存を増やさない。Node 標準 + `gh` のみ）。
- 既存ファイルは §1 と §3 で指定した箇所以外を変更しないこと。
- `gh` コマンドを実際に叩いて本番の Issue にコメントしないこと（テストはモック）。

## 完了条件

1. 上記 1〜4 が入っている。
2. 変更・作成したファイル一覧と、各ファイルで何をしたかを 1 行ずつ、合計 12 行以内で報告すること。
