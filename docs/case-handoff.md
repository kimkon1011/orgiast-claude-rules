# 案件の会話引き継ぎ

案件ID・案件一覧の名称を検出して、kim 操作アカウントのセッションを案件に紐付ける。`/case` で明示指定、`/case-resume` で別席から続行する。最初に読むのは STATE（4,096 UTF-8 bytes以下）と直近10セッションのLOG（合わせて6,144 bytes以下）。詳細は `sync` 後にローカルの transcripts を Grep する。

## 保存と復旧

UserPromptSubmit / SessionStart は案件一覧の1日キャッシュを使い、再開案内と直近30分の別席警告だけを表示する。Stop は未送信分をディスクへ先にキューし、送信成功から10分の間隔で送る。SessionEnd と `flush <sessionId>` は間隔を待たず送る。SessionEnd の短い終了猶予を超える通信は、親の終了後も生存する非表示の単発workerに渡す。workerは同時起動をローカルロックで防ぎ、1回の処理を時間制限する。

全文は user / assistant のテキスト。ツールは名前・主要引数（4KBまで）・結果の先頭500文字。添付のバイナリは複製せず、既知のパスとDrive IDを残す。秘密情報除去は memory-share と共通のlib。送信失敗・要約失敗はキューを消さず、次回のhook／`retry` で同じ sessionId・最終uuidを再送する。壊れたJSONLや消失したチェックポイントは無言で飛ばさない。

保存先は Drive ハブ `claude-common-rules` の `case-sessions/<案件ID>/`。SA/DWDは memoryserve のサーバにのみ設定し、クライアントは既存のkeyserve HMAC認証を使う。APIは `GET /api/case-log`（catalog/resume/transcripts/transcript）、`POST`（touch/append）。要約には既存 llm-ask の gemini / deepseek を使用し、それ以外のAIへフォールバックしない。

## 同時保存と設計判断

- 案件キーは指定の `\d{6}[A-Z]{2,6}` に加え `C\d{4,}` を受け付ける。2026-10-29の実物では案件一覧の49件が旧形式で、新形式だけでは案件名照合が0件となったため。IDは案件一覧の値を変換せず使用する。
- 指定された `TEST000000ZZ` は正規表現に合わないため、検証キーは `000000ZZ`、表示名を `TEST000000ZZ` とする。
- Drive v3のIf-Matchは実測で無視された。v2のmetadata ETag＋条件付きPUTでは古い版が412で拒否されることを確認した。metadata→本文→metadataで読み取りの一貫性を確認し、競合時は再読込する。
- `.case-registry.json` に事前発行したファイルIDを保存し、同名フォルダの同時作成を防ぐ。`.case-meta.json` は適用済み断片・要約・席情報の正本。STATE/LOGの派生ファイルは世代番号が古い書き込みを拒否する。全文を先に保存し、要約成功と読み戻しまで確認してからクライアントのuuidを進める。
- memoryserve の依存する共有libと llm-ask は `scripts/vendor-rules.mjs` で固定する。夜間の memory-publish は配備前にサーバのclean mainをfast-forwardし、古いcheckoutから新APIを消す事故を防ぐ。

## 配布・検証

既存の `setup --converge` が4イベントのhookを登録・検査・修復し、onboarding-syncが2つのskillを配布する。会話の本文はhookから注入しない。

2026-10-29、kim-PCの実セッションをローカルAPI実装→本番keyserve認証→本番Drive→実AIで往復。user本文2件→Drive2件、STATE 727 bytes、cold resume 843 bytes。49案件の名前キャッシュを実読。再送による重複なし。テスト用Driveフォルダの削除404とregistry削除を確認。本番配備後にも同じセッションで往復し、user本文2件一致、STATE808 bytes、cold resume924 bytes、再送重複なし、テスト削除済みを確認。既存memory配信1,000件の世代・件数も維持。サーバPR #1 はマージ済み。
