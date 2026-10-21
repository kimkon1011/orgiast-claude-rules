# handoff-audit 検証記録: `194d1afc68350276`「Discord チャンネル ID／ユーザー ID が要る」（2026-10-22）

対象 TODO: `[handoff-audit:194d1afc68350276] Discord チャンネル ID／ユーザー ID が要る — この handoff が再発していないかを実物で検証し結果を記録する`
再発防止の経路（起票時の指定）: **user に聞かず `tools/discord-channel-id.mjs` で台帳から取得**。

送信なし・権限変更なし・kim への DM なし・外部への送信なし。既存の承認範囲のみで実施
（Discord への書込みは一切せず、台帳検索とメンバー検索の read のみ）。

## 結論（3点）

1. **起票後の再発は 0 件。** 2026-10-20 18:03Z（起票）以降、直近の全 Claude Code トランスクリプト
   （`~/.claude/projects/**/*.jsonl`、assistant 発話）を走査し、ユーザーへ
   「チャンネルID／ユーザーID を教えて・貼って・コピーして」と依頼した行は **0 行**。
   「ID が未特定／分からない／見つからない」と放置した行も **0 行**（§2）。
2. **再発防止の経路はこの PC で実物動作する。** `tools/discord-channel-id.mjs` は台帳から
   200 行（`checkedAt` = 2026-10-21）を取得し、名前1件なら ID だけを返し、複数候補なら
   候補一覧を出して exit 1 で止まる（§3）。ユーザーID 側も `tools/discord-member-directory.mjs`
   が実名で解決できることを実測（`百瀬` → `1382566741464449124`）。
3. **足すコードはない。** 起票の原因は「社長の Discord ユーザーID が未特定のまま DM 送信を断定した」
   という 1 セッションの手順漏れで、ツール欠落ではない。恒久ルール（ONBOARDING 2.6.1 /
   `rules-extracted/discord-integration.md`）と取得ツールは既に本番 main にあり、今回の実測でも機能している。
   重複実装は作らず、実測結果だけを残す。

## 1. 原文の素性（一次証拠）

`~/.claude/handoff-audit-nightly-ledger.jsonl` の該当行（`ts` = 2026-10-20T18:03:14.845Z /
`sessionId` = 723e6b19-17ac-4680-a437-cfa4d48b070f / `verdict` = `block` / provider = deepseek）:

- `violations[rule=4]` の quote: 「社長に確認しています」を投稿し、社長へ DM
- 同 fix: **「社長の Discord ユーザーIDが未特定のまま。tools/discord-channel-id.mjs や台帳で
  社長のIDを直接照会して特定し、本番反映済みと断定する前に DM 送信先が実在するか実測する。」**

同 `learned` と `~/.claude/handoff-audit-promotions.jsonl`（同 ts）に
`pattern="Discord チャンネル ID／ユーザー ID が要る"` / `route="user に聞かず tools/discord-channel-id.mjs で台帳から取得"`
が high confidence で昇格済み。つまり本チケットは「ツールが無い」のではなく
**「ID を引かずに未特定のまま進めた」手順違反**の再発監視。

## 2. 再発の有無（実物走査）

| 走査 | 対象 | 条件 | 結果 |
|---|---|---|---|
| A | `~/.claude/projects/**/*.jsonl`（subagents 除く） | mtime 直近14日・assistant の text 行・`チャンネルID|ユーザーID|channelID|userID` かつ `教えて|貼って|ください|共有|もらえ|取得して|コピーして|必要です|が要る` | **1 件ヒット／うち Discord は 0 件**。唯一のヒットは OpenRouter の `user_...` アカウントIDの案内で対象外 |
| B | 同上 | mtime 直近10日・assistant の text 行・`チャンネルID|ユーザーID` かつ `未特定|分からない|不明|特定でき|見つから` | **0 件** |
| C | `~/.claude/auto-session/runs/**/*.md` | `チャンネル ?ID|ユーザー ?ID`（大小無視） | ヒットはすべてルール文書・導入ガイド（`rules-extracted/`, `ONBOARDING.md`, feedback-kit の INSTALL）で、**セッションが user に ID を求めた記録は無し** |

走査スクリプトは `~/.claude/auto-session/runs/work-20261022-idcheck/scan.mjs`（A）と `scan2.mjs`（B）。
判定は assistant の text ブロックのみ（tool_result 内の文書引用を除外）。

## 3. 再発防止経路の実物検証（この PC / 2026-10-22）

```
$ node tools/discord-channel-id.mjs --all --json
{"query":"","count":200,"rows":[{"id":"1382609269001814126","name":"🔰初めての方へ🔰…","checkedAt":"2026-10-21"},…]}   # exit 0

$ node tools/discord-channel-id.mjs bot制御
1382873177255968839        # exit 0（1件ならIDのみ）

$ node tools/discord-channel-id.mjs 倉庫
候補が複数あります。名前で選んでください。
ID / 名前 / カテゴリ / 用途
1382970982096044132 / 倉庫関連 /  /
1382599099597066323 / 倉庫関連 /  /
1476476737264291931 / 千葉倉庫連絡用（（株）あらた様） / 倉庫関連 /   # exit 1（人が名前を選ぶだけ。ID取得作業は依頼しない）

$ node tools/discord-member-directory.mjs 百瀬
{"id":"1382566741464449124","label":"百瀬　12月末までお休み"}          # exit 0（ユーザーID側）

$ node --test tools/discord-channel-id.test.mjs tools/discord-member-directory.test.mjs
tests 22 / pass 22 / fail 0
```

補足:

- 台帳は `~/.claude/fleet-sheet.env` の FLEET_SHEET_URL/TOKEN を読み、`checkedAt` 2026-10-21 の
  スナップショットを返した（前日分＝鮮度あり）。Bot トークンも `~/.claude/orgiast-discord-bot-token.txt` に存在。
- ルール文書の記載パス `~/orgiast-claude-rules/tools/discord-channel-id.mjs` はこの PC に実在し、
  `ONBOARDING.md:1178` と `rules-extracted/discord-integration.md:73` が同じコマンドを案内している
  （＝実装と文書の乖離なし）。
- 複数候補時の挙動（exit 1 で候補一覧）は「名前だけ選んでもらい、ID 取得作業は依頼しない」という
  ルールの意図どおり。ID を user に貼らせる経路にはならない。

## 4. 判定と後続

- 本チケットは**再発なし・恒久対応済み**として閉じてよい。追加のコード変更・PR は不要。
- 次に同種の P が再発した場合の見方: (a) assistant 発話に「ID を教えて／コピーして」があるか、
  (b) `node tools/discord-channel-id.mjs "<名前>"` を実行した形跡が無いまま「未特定」と書いていないか、
  の2点だけ確認すればよい。ツール自体の不調なら §3 のコマンドで切り分けられる。
