## 変更内容

- fleet-pc-map の旧 `DESKTOP-63MQR3L = 作業用008` 誤登録を `015CAFE = カフェ用015` に訂正
- 現hostnameと旧hostnameを同一機体の aliases として保持
- セッション先頭番号の解決対象に `カフェ用NNN` を追加
- 実マップ、旧hostname、既存の作業用番号、通知・fleet roster の回帰テストを更新

## テスト

- `node --test tools/lib/pc-number.test.mjs tools/session-wait-title.test.mjs tools/fleet-selfcheck.test.mjs tools/fleet-mail-alias-delivery.test.mjs tools/notify-owner.test.mjs`
- 145 pass / 0 fail
- `fleet-pc-map.json` JSON parse: valid
- `git diff --check`: pass
