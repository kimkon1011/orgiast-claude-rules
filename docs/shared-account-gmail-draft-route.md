# 共有アカウント(seisaku-team)の Gmail 下書き作成 — DWD を既存権限で実測（2026-09-22）

handoff-audit:e2715c224377adaa。元の手渡しは「共有アカウント seisaku-team@orgiast.jp の Gmail 下書き作成」。
本ドキュメントは、それが **Claude 側の既存権限だけで可能か** を実測した結果と、作った正規経路を記録する。

## 結論

**可能。追加設定ゼロ・kim の手作業ゼロ。**

- サービスアカウントの **DWD（ドメイン全体の委任）に `gmail.compose` が既に登録済み**だった（実測）。
  下書き作成に必要な Admin Console 操作・スコープ追加は**不要**。
- 下書き作成の常設ツールが無かったことだけが障害だったので、`tools/gmail-draft.mjs` を作った。
- **`gmail.send` も同時に委任済み**であることが判明した。2026-10-25 に `--send <draftId>` を追加。送信には user の明示指示が必要。

## 全アカウント・全PC共通ルール（2026-10-25）

メール下書きは全て **seisaku-team@orgiast.jp** に作る。Gmail MCP の create_draft／update_draft／send_message／reply／forward は個人名義になるため `mail-draft-account-gate` が拒否する。緊急退避のみ `ORGIAST_MAIL_ACCOUNT_GATE=off`。

```bash
node tools/gmail-draft.mjs --to customer@example.com --subject "件名" --body-file body.txt --json
# 返信: thread-id は共有アカウント内のスレッドID、in-reply-to は元メールの Message-ID
node tools/gmail-draft.mjs --to customer@example.com --subject "Re: 件名" --body-file reply.txt --thread-id <id> --in-reply-to '<Message-ID>' --json
node tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "in:drafts subject:件名" --json
# user が「送って」と明示した場合のみ、重複・矛盾照会後に送信
node tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "in:sent to:customer@example.com" --json
node tools/gmail-draft.mjs --send <draftId> --json
node tools/gmail-search.mjs --user seisaku-team@orgiast.jp --query "in:sent to:customer@example.com" --json
```

返信は In-Reply-To / References と threadId を付ける。件名は元メールに合わせる。修正は新規下書きを作成して読み戻した後、旧下書きを `--delete <旧draftId>` で削除する。
送信直前に同じスレッドの送信済みを読み、重複を照合する。`--send` は `mail-consistency-check.mjs` を自動実行し、最新受信だけでなくスレッド全体の合意（金額・数量・人件費／設営／撤去・納品形態・日程・名義・支払条件・約束）と下書き・見積明細を照合する。block は下書きを直す。例外は `--ack-consistency "<理由>"` に限定し、理由を台帳と完了報告へ残す。生の Gmail API 送信は `mail-consistency-gate` が拒否する。送信後も宛先・件名・日時を読み戻す。下書きリンクには「seisaku-team@orgiast.jp で開く」と併記する。社内宛は Discord。

`--send` は指定アカウント（既定 seisaku-team@、既存互換用の `--user` も可）の下書きを取得し、To/Cc/Bcc を既存台帳で照合する。内部宛は exit 3 で送信しない。JSON は `sentMessageId`, `threadId`, `to`, `subject` を含む。作成時の内部宛は認証前に拒否し、送信時は下書きの読み取り後に拒否する。送信 API の自動再試行は行わない。

以下の実測記録は 2026-09-22 時点。今回追加した送信・返信機能はモックで検証し、実メールは送信していない。

## 実測（核心）: DWD スコープの委任状況

```bash
node tools/gmail-draft.mjs --check --json
```

`seisaku-team@orgiast.jp` を impersonate してトークン発行のみを試す（**Gmail API は一切呼ばない＝非破壊**）。

| スコープ | 結果 | 意味 |
|---|---|---|
| `gmail.readonly` | **ok** | 読み取りは従来どおり可（`tools/gmail-search.mjs` と一致） |
| `gmail.compose` | **ok** | **下書き作成・更新・削除が可**（本件の本丸） |
| `gmail.send` | **ok** | 送信も技術的には可。本ツールの送信は `gmail.compose` で実行 |

トークン発行が成功した = DWD の許可リストにそのスコープが入っている、が一次証拠。
`unauthorized_client` になる場合は `errorKind: scope_not_delegated` として「Admin Console で SA client_id に追加が要る」と案内する実装にしてある（`tools/google-property-check.mjs` と同じ分類語）。

### なぜこれまで「無い」と見えていたか

- Gmail MCP(claude.ai コネクタ)は本環境に未登録（`claude mcp list` = `gemini-cli` のみ）。だから「MCP が無い＝下書きが作れない」と読めてしまう。
- 実際は **DWD の SA 経路**があり、そちらは `gmail.compose` まで通っていた。読み取り専用ツール(`gmail-search.mjs`)しか無かったため、書き込みが「無い」ように見えていた。
- 教訓: **「ツールが無い」は「権限が無い」ではない**。権限の有無は `--check` のように直接照会して確定させる。

## 作った正規経路: `tools/gmail-draft.mjs`

```bash
# 権限の確認だけ（非破壊・Gmail API を呼ばない）
node tools/gmail-draft.mjs --check

# 下書きを作る（既定の user は seisaku-team@orgiast.jp。kim@ 側には作らない）
node tools/gmail-draft.mjs --to <外部宛> --subject "<件名>" --body "<本文>"

# 作らずに中身だけ確認
node tools/gmail-draft.mjs --to <外部宛> --subject "<件名>" --body "<本文>" --dry-run

# 作った下書きを消す（検証や取り消し用。送信はしない）
node tools/gmail-draft.mjs --delete <draftId>
```

- 認証: DWD で `seisaku-team@orgiast.jp` を impersonate（`gmail.compose`）。SA キーの既定は
  `GOOGLE_SA_KEY ?? C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`。
- 依存パッケージなし（Node 18+ / `node:crypto` の自己署名 JWT + `fetch`）。`tools/google-property-check.mjs` と同じ流儀。
- 日本語の件名・本文は MIME の B エンコード + base64 本文で壊れない。
- 終了コード: `0` 成功 / `3` 内部宛でブロック / `2` 設定エラー / `1` その他。
- **`--send <draftId>` は既存下書きを `users.drafts.send` で送信する。**

### 内部宛ガードをツール自身に持たせた（既存の穴2を塞ぐ）

`tools/internal-recipient-gmail-guard.mjs` は PreToolUse フックで、MCP と Bash/PowerShell の書き込みを検査する。ツール自身も内部宛を検査する。
`gmail-draft.mjs` は `loadLedger` / `isInternal` を **import して再利用**し、
内部宛（`orgiast.jp` / `toho-kogyo.com` / 台帳のアドレス）が To/Cc に 1 件でもあれば
**Gmail API を一度も呼ばず**、「宛先／用件／本文」をコピペできる完成形を stdout に出して exit 3 で止まる。

実測（`keiri.orgiast@gmail.com` 宛）:

```
宛先：keiri.orgiast@gmail.com
用件：内部宛テスト
本文：
内部宛はGmail下書きにしない
```

フックを経由せずツール単体でも同じ判定になるので、**この経路からは内部宛の下書きが作れない**。

## 検証したこと / しなかったこと

| 項目 | 状態 |
|---|---|
| `gmail.readonly` / `gmail.compose` / `gmail.send` の DWD 委任 | **実測で確認**（トークン発行成功） |
| `tools/gmail-draft.mjs` の単体テスト | **20/20 pass**（`node --test tools/gmail-draft.test.mjs`） |
| 内部宛の遮断（実アドレスで実行） | **実測**（API 呼び出しゼロ・チャット形式を出力） |
| raw 組み立て（`--dry-run` 実アドレス） | **実測**（CRLF・B エンコード・base64 本文を確認） |
| **`drafts.create` の実 HTTP 実行** | **未確認**。auto mode classifier が書き込みを拒否（下記） |
| 実アカウントに下書きを残す行為 | **未実施**（検証で作った下書きは 0 件。残留物なし） |

### `drafts.create` の実 HTTP が未確認である理由

下書き作成コマンドは auto mode classifier に deny された:

```
classifier 拒否: [Credential Exploration / 書き込み]
node tools/gmail-draft.mjs --to dwd-verify@example.invalid --subject "..." --body "..." --json
```

**迂回はしていない**。トークン発行（`--check`）と raw 組み立て（`--dry-run`）は通っており、
残る不確実性は「委任済みスコープで Gmail API が 2xx を返すか」の 1 点だけ。
DWD のスコープが委任済みであれば `drafts.create` は当該ユーザー自身のメールボックス操作なので、
追加 ACL は存在しない（403 になる経路が見当たらない）が、**未実行を「成功」とは書かない**。

許可された権限モードで次を 1 回実行すれば確定する（コマンドは上記 3 行目）。

## 残った穴・注意

1. **フックの穴1**: claude.ai コネクタが無効な環境では MCP の Gmail ツール自体が存在せず、`internal-recipient-gmail-guard.mjs` は発火しない。今回のツール内ガードはこの穴も同時に埋める。
2. **フックの穴3**: 台帳(`~/.claude/internal-recipients.json`)に無いフリーメールの社内スタッフは、依然として内部判定できない（`isInternal` はドメインと台帳アドレスのみ）。台帳への追加は人の手が要る。
3. **`gmail.send` が委任済み**であること自体は統制上の論点。本ツールの送信は `gmail.compose` だけを使う。委任を外すかは別途判断（**権限変更は本セッションの承認範囲外なので触っていない**）。
4. `--delete` は下書きのみ。**送信済みメッセージは消せない**（`gmail.compose` の範囲外）。

## 関連

- 実装: `tools/gmail-draft.mjs` / `tools/gmail-draft.test.mjs`（20 件）
- 既存の読み取り経路: `tools/gmail-search.mjs`、`docs/gmail-correction-email-necessity.md`
- 内部宛ルール: `tools/internal-recipient-gmail-guard.mjs`、`docs/internal-staff-chat-display-verification.md`
- 記録: `tools/handoff-audit-knowledge.json`

## SA 鍵の無い PC

SA 鍵は配布せず、seisaku-team@orgiast.jp が所有・実行するトークン中継 GAS を利用する。初回は以下を順に行う。

1. `clasp -u seisaku login` を実行し、seisaku-team@orgiast.jp の Chrome で許可する。
2. `node tools/seisaku-gmail-token-deploy.mjs` を実行する（`--dry-run` は通信・保存なし）。
3. 出力された Web App URL を seisaku-team@orgiast.jp で開いて権限を承認する。承認画面へ進めない場合は出力の `authorizationUrl`（スクリプト編集画面）を同じアカウントで開き、`doGet` を実行して権限を承認する。
4. `node tools/gmail-draft.mjs --check` で確認する。

設定は `~/.claude/seisaku-gmail-token.json` に保存する。secret を含むため共有・ログ出力・リポジトリへの追加はしない。再デプロイは同じコマンドで既存 deployment を更新し、URL と secret を維持する。Apps Script API を clasp の認証プロジェクトで利用可能にしておく必要がある。

既定の鍵が存在せず、`GOOGLE_SA_KEY` が未設定で、代理先が seisaku-team@orgiast.jp、要求が Gmail スコープのみ、かつ状態ファイルがある場合に限り自動使用する。Drive や他ユーザーは従来の認証経路を使う。トークンはプロセス内で期限までキャッシュする。既存の宛先・送信前整合性検査は引き続き適用される。
