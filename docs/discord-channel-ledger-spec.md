# Discordチャンネル台帳

Discord Bot がギルドの全チャンネルを取得し、GAS Web App の `discord-channels` 経路で「Discordチャンネル」タブへ同期する。

- 突合キーはチャンネルIDのみ。名称変更は同じ行を更新する。
- 機械が更新できる列は許可リストで限定し、`【手入力】` 列には書き込まない。
- Discordから消えたチャンネルは行を残し、状態を「削除/非表示」にする。
- 全タブの「担当」「備考」相当列は `ensureManualColumns` で右端に補う。同義列があれば追加しない。
- PCログインと拡張機能監査の夜間置換では、複合キーが一致する手入力値を新しい行へ引き継ぐ。引継先のない値は `droppedManual` で報告する。

Nodeツールは `~/.claude/orgiast-discord-bot-token.txt` と `~/.claude/fleet-sheet.env` を使用する。`--dry-run` はGASへPOSTせず、トークンを含まない収集結果だけを表示する。
