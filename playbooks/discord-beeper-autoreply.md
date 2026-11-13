# Discord DM・グループDM の自動返信

kim 2026-11-12 承認。DM・グループDMは `discord-beeper-autoreply` に移行する。旧 `discord-dm-drafts` の UI Automation や `-Switch` は使わない。旧タスクを停止・削除して重複を解消するのは運用切替時の作業で、登録スクリプトは既存タスクを変更しない。

Windows の Beeper Desktop と Node.js 22.13 以降を使用。対象は `discordgo.715210673642012733` の single/group のみ。LINE・WhatsApp・Messenger や別の Discord アカウントには送信しない。既読・未読・ミュートに関わらず一覧を読み、kim の最後の発言および処理済み台帳より新しい相手の発言を対象とする。グループは kim メンション・kim への返信を確認する。GET は既読を付けない。

```powershell
node tools/discord-beeper-autoreply.mjs once --dry-run
node tools/discord-autoreply.mjs once --dry-run
# 運用切替時のみ。今回の実装・検証では実行しない。
powershell -NoProfile -ExecutionPolicy Bypass -File tools/register-discord-beeper-autoreply.ps1
```

登録は Interactive/Limited、優先度4、5分間隔、run-hidden 経由。登録直後の即時起動はしない。CLI は `once` / `loop` / `--dry-run` をサポート。

返信判定はサーバーと同じ Gemini 等の他AI。Claude API は使わない。FYI・返信不要は送らず記録する。金額・日程・承認・方針など kim の判断、低信頼度、初対面、メッセージリクエスト、添付確認、読み取り失敗は自動送信せず判断待ち。返信先に `【AI自動返信】` から始まる本文を送り、Beeper で送信者と本文を読み戻す。1巡回5件・直近1時間30回の送信試行を上限にし、失敗も上限に数える。

台帳は `~/.claude/discord-beeper-autoreply/state.json`、履歴は `log.jsonl`。`sending` を送信前に永続化し、送信エラー・読み戻し失敗は `uncertain` として再送しない。送信後の読み戻し失敗は、既に送信された可能性があるため取り消せない。判断待ち DM を受けた kim が Discord で実態を確認する。`PAUSE` ファイルで停止する。`lock` は自動奪取しないため、異常終了時はプロセス終了と送信実態を確認してから削除する。

通知 outbox は台帳と一緒に保存する。Bot DM 失敗は kim-inbox にフォールバック。通知失敗は相手への返信を再送する理由にしない。サーバーのヘルス・エラー等は従来どおり kim-inbox のみ。

2026-11-12 実機の Beeper API は chat 828 の検品・請求金額確認と chat 1426 の浅沼さんのメッセージリクエストを既読で取得できた。後者は `capabilities.messageRequest` を持つ。API が返したチャットIDは Matrix room ID、メッセージIDはローカルIDであり、Discord の native channel/message ID や deeplink は見つからなかった。リンクは明示された Discord ID/URL → Beeper deeplink → 会話名の順で使う。内部IDから Discord URL を推測しない。

実装の検証では送信、Bot DM、通知、タスク登録を行わず、ネットワーク POST はモックテストだけで確認する。dry-run は実メッセージの読み取りと LLM 分類を行うが、送信・通知・処理済み台帳・ロックは変更しない。
