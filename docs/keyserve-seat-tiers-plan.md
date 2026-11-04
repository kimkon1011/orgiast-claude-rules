# keyserve: 各席の自己完結化・第2段の配布計画

調査日: 2026-11-04（kim-PC / Windows）。この文書は**名前・置き場所・配布案のみ**。
秘密値の表示、コピー、コミット、Vercel env の変更は行っていない。

## 調査範囲と件数

- `C:/Users/uers/Downloads` 配下の `.env` / `.env.local` 31 ファイルを再帰走査した。
  `.git`、依存パッケージ、ビルド成果物、キャッシュ、各プロジェクト内の `.claude` / `.codex` / `.qwen` は除外。
- `C:/Users/uers/.claude` 直下の env 31 ファイルは代入左辺の変数名だけを抽出。
  txt / json はファイル名だけを確認し、内容を開いていない。
- 利用コードが参照する `aujust-sales-automation/.gcp/sheets-sa.json` は存在だけを確認した。
  env の右辺は解釈・比較・保存・表示していない。空値か、有効か、本番用か、同じ鍵かは未確認。
- `D` は `C:/Users/uers/Downloads`、`P` は `D/CLAUDE.md配布`、`~` は `C:/Users/uers` の略。

| tier 案 | 棚卸し項目数 | 所在ファイル数 | 数え方 |
| --- | ---: | ---: | --- |
| ai | 追加 0 | 既存 manifest の 14 配布ファイルを維持 | 今回の拡張対象には加えない |
| project | 89 | 20 | `(ファイル, 変数名)` 88 組 + bot token txt 1 件 |
| workspace | 11 | 11 | SA JSON 変数 10 箇所 + SA JSON ファイル 1 件 |

同じ変数の worktree / scratch / 一時コピーも所在として数えている。**鍵の種類数・異なる秘密値の数ではない**。
project の変数名は重複除去で 23 種、workspace の env 変数名は 1 種。
同じファイルに project / workspace 両方があるため、両 tier のファイル数を足して総ファイル数にはしない。
対象は aujust、学会、LINE、Growi、Discord bot、DWD。周辺アプリの Supabase 等は参考表に分け、上記件数に含めない。

## 配布束の案と利用先

| 用途 | 正本候補・現状 | tier / 配布ファイル案 | 利用上の確認事項 |
| --- | --- | --- | --- |
| aujust Supabase | `P/aujust-sales-automation/.env.local` | project / `aujust-supabase.env` | `NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY`、`SUPABASE_DB_URL`、`SUPABASE_ACCESS_TOKEN`。SQL の接続先・権限は次段で確認 |
| 学会 Supabase | `P/学会協賛メディア/web/.env.local`、aujust 側の `GAKKAI_SUPABASE_ACCESS_TOKEN` | project / `gakkai-supabase.env` | `SUPABASE_ACCESS_TOKEN`、`SUPABASE_ACCESS_TOKEN_ALT`、`SUPABASE_PROJECT_REF`、`SUPABASE_SERVICE_ROLE_KEY`、公開 URL / anon 名を検出。学会側では DB 接続 URL の変数名を検出していない。pg_cron 用 SQL 権限は未検証 |
| Vercel 本番デプロイ | 指定範囲に `VERCEL_TOKEN` は**未検出** | project / `vercel.env`（未収集・件数外） | `VERCEL_OIDC_TOKEN` は複数ファイルにあるが、デプロイ用 token の代用として配布しない。各チーム・プロジェクトの権限を別段で確認 |
| LINE 送信 | `~/.claude/tmp-aujust-dev.env` の `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_ID` / `LINE_CHANNEL_SECRET` | project / `line-send.env` | 一時ファイルなので正本・対象 bot を要確認。既存 `tools/line-group-send.mjs` が読むのは access token、`SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`。URL 名を aujust の `NEXT_PUBLIC_SUPABASE_URL` から対応づける。今回 `line-send.env` は未検出 |
| LINE 受信連携 | `D/claude-mobile/.env` | project / `line-ingest.env` | LINE_RENKEI / LINE_INGEST 系は送信用 token とは区別して用途確認 |
| Growi | `~/.claude/growi.env` | project / `growi.env` | `GROWI_API_TOKEN`、`GROWI_BASE_URL`、`GROWI_USER`、`GROWI_PASS`。既存 `tools/growi-manual.mjs` は同名 env を読む |
| 共通 Discord bot | `~/.claude/orgiast-discord-bot-token.txt` | project 案 / `discord-bot.env` | 内容未読。現行 ai manifest に txt が既に含まれる。今回は ai 配布を変更しないので、この既存 token の権限縮小は別移行が必要。既存 txt 読み取りツールも env 対応が必要 |
| Discord 管理 bot | `~/.claude/discord-admin.env` | project / `discord-admin.env` | `DISCORD_ADMIN_BOT_TOKEN`。共通 bot と同じと仮定しない |
| 案件 Discord bot | aujust、command-center、construction-manual-app、tanom-ai、メール処理アプリ等の `DISCORD_BOT_TOKEN` / 親フォルダの `AUJUST_DISCORD_BOT_TOKEN` | project / 案件別 `*-discord.env` | 値の同一性は比較していない。汎用変数名が同じでも別ファイルで分離する |
| DWD / Workspace | `P/aujust-sales-automation/.gcp/sheets-sa.json`、同プロジェクト env の `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` | workspace / `workspace-sa.env` | SA 本文未読。DWD 承認・対象ユーザー・Gmail 下書き/Drive scope は別段で確認。JSON ファイルと env の SA が同一かも未確認 |

Vercel CLI の候補 `~/AppData/Roaming/com.vercel.cli/Data/auth.json`、
`~/AppData/Local/com.vercel.cli/Data/auth.json`、`~/.local/share/com.vercel.cli/auth.json`、
`~/.config/vercel/auth.json` も存在を確認できなかった。これは当該パスでの未検出であり、別の保管先やサーバーに鍵が無いという判断ではない。
他 PC の keiri-hub に関する既存文書はこの PC の所在証拠として使っていない。

## PC 許可リストの運用

サーバー `ORGIAST_PC_TIERS_JSON`（pcId → 最大 tier）が正本。今回は env を変更しないため未設定時は全 PC が ai。
追加 tier は `ORGIAST_PC_SECRETS_JSON` の独立した PC 固有秘密で認証した場合だけ有効。
アカウント名・クライアントが送った tier・fleet の表示名だけでは昇格させない。

参照した rules main は `0efcce38d013ab0ba0c13bb17a98d388b564e84b`。
`tools/lib/kim-operated.mjs` はアカウント単位だが、[PR #1488](https://github.com/kimkon1011/orgiast-claude-rules/pull/1488)
の PC 別 `operator` → `notifyDiscordId` 上書きを優先する方針に合わせる。
秘密配布ではアカウント一覧へのフォールバックを採らず、PC ごとの確認を必須にする。

| PC 候補 | 台帳・PR の証拠 | 初期登録案 |
| --- | --- | --- |
| kim-PC / DESKTOP-2D0R4LI | fleet-pc-map の person=金功勇、実機照合の記録あり | workspace 候補。実際に保存済みの ASCII pcId を確認して 1 ID だけ登録 |
| kimko-PC / DESKTOP-PPD5V8I | person=金功勇、2026-10-09 の実機照合あり | workspace 候補。同上 |
| 作業用011 / cr-PC | person=金功勇、kim 宛 notifyDiscordId、cr-PC で enroll の記録あり | workspace 候補。登録済み pcId=`cr-PC` の現状を確認。日本語 hostname をそのまま登録しない |
| nishi-PC / DESKTOP-04U31RG | アカウント・実機対応はあるが明示 operator は未記入 | 追加配布保留。アカウントだけで登録しない |
| w018-PC / DESKTOP-N429M3V | kim と異なる notifyDiscordId | 追加配布しない。PC 操作者の確認が必要 |
| HP、増田さんの MacBook | 社員本人の記載あり | 追加配布しない。cr@ の共有を根拠にしない |
| DESKTOP-BDOAK99 | #1488 は operator=佐藤優奈、一方 main 台帳は作業用999 / kim 向けと記述が競合 | 未確認として追加配布しない。008/999 の表示名で推測しない |
| その他・未確認 PC | PC 本人性の根拠が不足 | ai のみ |

## サーバー仕様・次段への条件

- `ai ⊂ project ⊂ workspace` の累積 tier。既存 `ORGIAST_KEYS_JSON` / `ORGIAST_KEYS_JSON_EXTRA*` は従来配布を維持。
  新規は `ORGIAST_PROJECT_KEYS_JSON[_EXTRA*]` / `ORGIAST_WORKSPACE_KEYS_JSON[_EXTRA*]` に分離する。
- 共有鍵から任意 pcId の派生鍵を取得できる既存経路を考慮し、primary / legacy / enroll / 派生 PC 鍵では追加 tier を配らない。
  PC 固有秘密は独立したランダム鍵を別段で作り、既存 ai 配布を通さず確認済み実機の `keyserve.env` に設定する。
- 既存 PC の onboarding-sync（通常の日次 / SessionStart）で env の取得・更新が動く。
  新規インストールだけに依存しない。サーバー応答形式も変更しない。
- workspace SA は `workspace-sa.env` の `GOOGLE_SERVICE_ACCOUNT_JSON` へ **1 行 JSON** として格納する案。
  JSON 内の改行はエスケープを保持する。既存 env マージで安全に更新できる。
  `tools/lib/drive-auth.mjs` / `tools/gmail-draft.mjs` は現在 `GOOGLE_SA_KEY` のファイルパスを使うため、
  この env の消費対応または権限制限付き JSON 復元が次段で必要。配布コードのマージだけで Gmail が利用可能になったとは扱わない。
- ファイル作成・更新権限は既存 onboarding-sync の mode 0600 に従う。Windows の ACL 強化はこの変更に含めない。
- サーバー監査は pcId、tier、UTC 時刻、outcome のみ。値・本文は記録しない。
- 許可リストからの削除は次回配布を止めるだけで、端末内に取得済みの鍵は残る。
  社員席への転用・紛失時は端末内削除とリソース側の鍵失効・再発行まで行う。
- 本番 env 投入、各リソースの実操作、既存 bot token の ai からの移行は PR マージ後の別段。
  keyserve は手動レビュー対象。automerge ラベルを付けない。

## 名前だけの所在一覧

project / workspace 両欄は最小 tier 案。コピー間の値は比較していない。
`(file)` は変数名が無いファイルで、内容は開いていない。

| ファイル | project の変数名 | workspace の変数名 |
| --- | --- | --- |
| `D/claude-mobile/.env` | `DISCORD_BOT_TOKEN`、`LINE_INGEST_ALLOW_CHATS`、`LINE_INGEST_DEFAULT_PREFIX`、`LINE_INGEST_TOKEN`、`LINE_RENKEI_CHANNEL_ID`、`LINE_RENKEI_CHANNEL_SECRET` | — |
| `P/.env.local` | `AUJUST_DISCORD_BOT_TOKEN` | — |
| `P/aujust-deploy/.env.local` | `GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-os-phase0b-worktree/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-phase0a-merge/.env.local` | `GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-sales-automation/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-sales-automation/scratch/aujust-batch3-release/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-sales-automation/scratch/aujust-wt-batch2/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-sales-automation/scratch/aujust-wt-batch3/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-sales-automation/scratch/migration-tls/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/aujust-wt-dunning/.env.local` | `DISCORD_BOT_TOKEN`、`GAKKAI_SUPABASE_ACCESS_TOKEN`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `P/command-center/.env.local` | `DISCORD_BOT_TOKEN` | — |
| `P/construction-manual-app/.env.local` | `DISCORD_BOT_TOKEN` | — |
| `P/tanom-ai/.env.local` | `DISCORD_BOT_TOKEN` | — |
| `P/メール処理アプリ/.env` | `DISCORD_BOT_TOKEN` | — |
| `P/学会協賛メディア/web/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_ACCESS_TOKEN_ALT`、`SUPABASE_PROJECT_REF`、`SUPABASE_SERVICE_ROLE_KEY` | — |
| `~/.claude/discord-admin.env` | `DISCORD_ADMIN_BOT_TOKEN` | — |
| `~/.claude/growi.env` | `GROWI_API_TOKEN`、`GROWI_BASE_URL`、`GROWI_PASS`、`GROWI_USER` | — |
| `~/.claude/tmp-aujust-dev.env` | `DISCORD_BOT_TOKEN`、`LINE_CHANNEL_ACCESS_TOKEN`、`LINE_CHANNEL_ID`、`LINE_CHANNEL_SECRET`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` | `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON` |
| `~/.claude/orgiast-discord-bot-token.txt` | `(file)` | — |
| `P/aujust-sales-automation/.gcp/sheets-sa.json` | — | `(file)` |

## 参考検出（今回の配布案・件数には含めない）

以下は周辺アプリで検出した名前。今回指定された aujust / 学会の SQL 鍵と同一だとは扱わず、追加する場合は別途案件範囲を確定する。

| ファイル | 変数名 |
| --- | --- |
| `P/command-center/.env.local` | `SUPABASE_URL` |
| `P/construction-manual-app/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY` |
| `P/EOラーニング企画アプリ/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` |
| `P/event-shop-rental/web/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_DB_HOST`、`SUPABASE_DB_PASSWORD`、`SUPABASE_DB_URL`、`SUPABASE_PROJECT_REF`、`SUPABASE_SERVICE_ROLE_KEY` |
| `P/exhibition-japan/web/.env.local` | `NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_DB_URL`、`SUPABASE_SERVICE_ROLE_KEY` |
| `P/pma-wt-13/.env.local` | `DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`NEXT_PUBLIC_SUPABASE_ANON_KEY`、`NEXT_PUBLIC_SUPABASE_URL`、`POSTGRES_DATABASE`、`POSTGRES_HOST`、`POSTGRES_PASSWORD`、`POSTGRES_PRISMA_URL`、`POSTGRES_URL`、`POSTGRES_URL_NON_POOLING`、`POSTGRES_URL_NO_SSL`、`POSTGRES_USER`、`SUPABASE_SERVICE_ROLE_KEY` |
| `P/pma-wt-6/.env.local` | `DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`POSTGRES_DATABASE`、`POSTGRES_HOST`、`POSTGRES_PASSWORD`、`POSTGRES_PRISMA_URL`、`POSTGRES_URL`、`POSTGRES_URL_NON_POOLING`、`POSTGRES_URL_NO_SSL`、`POSTGRES_USER` |
| `P/tetsuko-unified/.env.local` | `DATABASE_URL`、`SUPABASE_PROJECT_REF` |
| `P/tetsuko-unified/web/.env.local` | `DATABASE_URL` |
| `P/購買部管理アプリ/.env.local` | `DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`POSTGRES_DATABASE`、`POSTGRES_HOST`、`POSTGRES_PASSWORD`、`POSTGRES_PRISMA_URL`、`POSTGRES_URL`、`POSTGRES_URL_NON_POOLING`、`POSTGRES_URL_NO_SSL`、`POSTGRES_USER` |

`VERCEL_OIDC_TOKEN` を検出した所在（配布案から除外）:

- `P/claude-watch-inbox/backend/.env.local`
- `P/EOラーニング企画アプリ/.env.local`
- `P/pma-wt-13/.env.local`
- `P/pma-wt-6/.env.local`
- `P/学会協賛メディア/web/.env.local`
- `P/購買部管理アプリ/.env.local`
- `~/.claude/tmp-aujust-dev.env`

`VERCEL_*` のデプロイメタデータや `SUBLINE_*` は今回の案件鍵として数えていない。
既存 manifest にある `anthropic.env` は今回追加・利用せず、Claude API を呼ぶコードも追加しない。

## 検証

keyserve は PC 派生鍵・enroll のある `main`（`e09c335`）を基点とした。
既定の `master` は古い実装で、そこにあった `_auth.js` も読んだ上で差分を確認した。
本番のローカル固有ファイルや未追跡ファイルは PR に取り込まない。

Windows 11 / Node.js v24.22.2 で `node --test`: **42/42 pass、fail 0、skip 0**。
`ORGIAST_RULES_TEST_DIR` に上記 rules checkout を指定し、既存の keyserve-auth / keyserve-status / onboarding-sync を
localhost と一時ホームだけで実行した。さらに現在の kim-PC の rules 作業フォルダにあるクライアントでも
結合テスト **1/1 pass** を確認した。各 tier の取得・新規書込・更新、SA JSON の復元、秘密値非出力を確認した。
本番 keyserve・Gmail・Vercel・Supabase・LINE・Discord へのリクエストは行っていない。
