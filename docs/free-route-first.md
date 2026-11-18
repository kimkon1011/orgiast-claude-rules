# 無料経路を先に確認する費用提案ゲート

`decision-research-gate` は既存の Stop runner から実行される。hook settings の追加は不要。
費用を伴う選択肢では無料・既存経路を比較の先頭に置き、同じ応答に
`[FREE-ALT-CHECKED: 調べた無料経路と実測結果（20文字以上）]` を付ける。
kim 自身の課金指示がある場合だけ `[PAID-OK: 「指示の引用」]` を使う。
マーカーは説明の形式を検証するもので、実測や承認の真偽を証明するものではない。
引用・過去の事実・不要と判断済みの説明は提案として扱わない。

## 日次写真依頼: 方式(b)

`reply-queue` には定型calendarに対するstanding approvalが無い。
receiptはapproved/edited状態から発行する有効期間60秒の証票で、
送信時には別途、本文・宛先・直近履歴に対応した30分以内のcontext markerも必要。
calendarの承認をBeeper送信receiptへ読み替えず、当日本文の個別承認を用いる。

`tools/lahaina-daily-post.mjs` が月間429を検知するとbotを翌月まで休止し、
`daily-beeper-approval.mjs` がlistChatsのtitle完全一致で宛先を解決する。
0件・複数一致・不完全なページングでは停止する。
毎日、当日本文をreply-queueへpresented状態で登録し、kim-inboxのaskに全文を積む。
日付と宛先をキーに重複排除する。Beeper停止やinbox失敗は非0終了し、成功扱いにしない。

受信箱に表示された番号（1件目なら「1 可」）へのkimの返答を確認したセッションが:

1. 宛先・当日本文・返答の対応を確認する。
2. `node tools/reply-queue.mjs decide <queue-id> --verdict approved --reason "実際のkimの返答"` で決定を記録する。
3. `node tools/daily-beeper-approval.mjs --send-approved <queue-id>` を実行する。

手順3はapproved状態と当日本文の完全一致を確認し、send-context-check、
最新履歴取得、正規issueReceipt、beeper-send、markSentの順に実行する。
未承認・変更本文・翌日への持越しは拒否する。履歴変化で戻されたqueued状態は再提示が必要。
送信結果が不確定ならuncertainとして止め、読み戻し確認が済むまで再送しない。
定期ジョブは承認・receipt発行・Beeper実送信を行わない。

## ローカル配置

既存の毎朝9時タスクの起動パスを維持し、ローカル`send-today.mjs`を
nightly-repoの`tools/lahaina-daily-post.mjs`のmainへ委譲する薄い入口にする。
calendar、sent、quota、runsは従来の`~/.claude/lahaina-daily-post/`を使用する。
calendar本文や認証情報はリポジトリへ複製しない。
検証は`--dry-run`と一時homeでのユニットテストのみ。本番グループへ送信しない。

## 同型の横展開: 11箇所

| ファイル | 箇所数 | 修正 |
|---|---:|---|
| tools/lane-doctor.mjs | 4 | payment修復案、非Gemini残高通知、Gemini通知、payment案内を無料・既存枠の実測優先へ |
| tools/cost-improve-loop.mjs | 3 | Genspark残高判断、provider_unhealthy注記、balance_low注記 |
| tools/lib/lane-health.mjs | 1 | payment_requiredの対処案 |
| tools/provider-balance.mjs | 2 | 自動補充故障と残高注意通知を無料・既存枠確認優先へ |
| tools/lahaina-daily-post.mjs | 1 | 月間枠待ちの沈黙停止をBeeper承認キューへ |

検索対象はtools配下のquota/429/枠切れ/残高不足と、有料/課金/入金/チャージ/upgrade。
既にBeeper案内のあるline-group-send、エラー分類だけのcodex-do/llm-fallback、
有料出品の事実を表示するmakimono-search、既存有料契約への再ログイン案内は変更対象外。
