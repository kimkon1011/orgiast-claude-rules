# カフェ用015 PC設定訂正結果

## 変更ファイルと差分要約
1. `fleet-pc-map.json`
   - キー `"DESKTOP-63MQR3L"`（旧「作業用008」誤登録）を `"015CAFE"` に置き換え。
   - `hostname`: `"015CAFE"`
   - `remoteName`: `"カフェ用015"`
   - `aliases`: `["015CAFE", "DESKTOP-63MQR3L"]`
   - `_evidence`: 2026-11-14 操作者「このPCは015」明言に基づく訂正記録に更新。

2. `tools/lib/pc-number.mjs`
   - 正規表現を `作業用(\d{3})` から `(?:作業|カフェ)用(\d{3})` に変更（map 照合および hostname フォールバックの2箇所）。
   - 「カフェ用015」から PC 番号 `"015"` を正常抽出できるように修正。

3. `tools/lib/pc-number.test.mjs`
   - 実マップテストに `015CAFE` → `"015"`、`DESKTOP-63MQR3L` → `"015"` を追加。
   - モックテストに `カフェ用015` → `"015"` を追加。

4. `tools/fleet-selfcheck.test.mjs`
   - 宛先解決テストを `カフェ用015` → `015CAFE` に更新。
   - 旧 `作業用008` は aliases にて `DESKTOP-BDOAK99` へ解決することを確認。

5. `tools/notify-owner.test.mjs`
   - `KNOWN_MISSING_NOTIFY` リストの旧 hostname `DESKTOP-63MQR3L` を `015CAFE` に更新。

## テスト結果
- `tools/lib/pc-number.test.mjs`: 9 pass / 0 fail
- `tools/fleet-selfcheck.test.mjs`: pass
- `tools/notify-owner.test.mjs`: 45 pass / 0 fail
- `tools/session-wait-title.test.mjs`, `tools/fleet-mail-alias-delivery.test.mjs`, `tools/fleet-mail.test.mjs`: 202 pass / 0 fail

## コミット・PR着地状態
- ブランチ: `auto/20261114-pc015-cafe`
- コミット: `e931fbdc` `fleet-pc-map: 015CAFE をカフェ用015に訂正（旧008誤登録）`
- landing 予約: `~/.claude/github-landing-queue.txt` に追記済み。本機（015CAFE）は GitHub 認証未済（GitHub CLI login 未実行）のため、`gh-login-oneclick.ps1` 実行時または資格情報保有 PC で自動 push/PR 着地されます。
