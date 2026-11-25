# 仕様: フリート生存判定を「理由付き」にする

## なぜ

2026-08-27 の実測で、現状の生存digest が **3つの別の状態を「72h超/未報告」に混ぜている**ことが分かった。
混ぜているせいで「14台無音」という数字が数週間そのまま残り、何を直せばいいのか誰にも分からなかった。

実測（同日・同時刻）:

| 経路 | 見えたPC |
|---|---|
| Discord 報告チャンネル（直近7日） | `kim-PC` **のみ** |
| Discord 報告チャンネル（直近30日） | `kim-PC` / `HP`(9.0日前) / `macBook`(9.3日前) / `owner-PC`(8.1日前) / `百瀬かなうのMacBook Air`(7.6日前) |
| フリートシート（GAS doGet） | `kim-PC`(24h以内) / **`古川龍慶のノートブックコンピュータ`(24〜72h)** ／ 他15台は空 |

判明したこと:

1. **シートにしか出ないPCがある**（`古川龍慶のノートブックコンピュータ`）。
   = **生きているが Discord にだけ報告できない**。webhook が 2026-08-19 に削除され、
   kim機だけ 8/25 に自動復旧し、他機は死んだURLを持ったままなので当然こうなる。
   → **Discord の沈黙は「PCが死んだ」ではない。**
2. **Discord に出た4台は全部 8/18〜8/20 に止まっている** = webhook 削除日と一致。
   これは「壊れて停止」であり「未導入」ではない。
3. **一度も両経路に出ないPCは「未導入」か「電源が入っていない」**。
   電源が入っていないPCはどう直しても報告しない。これはバグではない。

## 作るもの

`tools/fleet-liveness.mjs` と `tools/fleet-liveness.test.mjs`。
既存の `fleet-triage-report.mjs`（シートのみ）は消さない。こちらは**2経路を突き合わせて理由を出す**。

### 入力
- Discord: 既存 `tools/fleet-discord-audit.mjs` の `auditFleet()` / `extractIdentity()` と
  `tools/discord-digest.mjs` の `fetchMessages()` を **import して再利用**する。自分で HTTP を書くな。
- シート: 既存 `tools/fleet-triage-report.mjs` がシートを読む処理を**純関数として切り出して export** し、
  こちらから呼ぶ。切り出しに伴って `fleet-triage-report.mjs` の既存の挙動・出力・テストは変えないこと。
  `FLEET_SHEET_URL` / `FLEET_SHEET_TOKEN` は既存どおり `~/.claude/fleet-sheet.env` 由来。

### 判定（純関数 `classifyFleet({ discord, sheet, now })` として export しテストする）

PCごとに次の `state` と `reason` を必ず1つ返す。判定順に評価する。

| state | 条件 | reason 文言の例 |
|---|---|---|
| `alive` | どちらかの経路に24h以内の報告がある | `24h以内に報告あり（Discord/シート）` |
| `discord-mute` | シートに24〜72h以内の報告があるが Discord には72h超/皆無 | `シートには届いている。Discord webhook が死んでいる疑い（2026-08-19 の削除が原因）` |
| `broken` | 過去に報告実績があり、最終報告が72h超 | `<最終報告日> に停止。以後の報告なし` |
| `never` | どちらの経路にも報告実績が一度も無い | `報告実績なし（未導入 / 電源が入っていない のどちらか。区別不能）` |

**`never` を「無音」「異常」として数えないこと。** 電源が入っていないPCはバグではない。
出力では `alive` / `discord-mute` / `broken` / `never` を**別の見出しで分けて**出す。

### 出力

- 既定は人が読める Markdown。`--json` で機械可読。
- 見出しは「✅ 生存」「📡 Discordにだけ届かない」「🚨 壊れて停止」「◻️ 報告実績なし（未導入/電源off）」。
- `broken` の各行に**最終報告日**を必ず入れる（いつ壊れたかが分かれば原因に当たれる）。
- 末尾に **次にやること** を機械的に出す:
  - `discord-mute` と `broken` が1台以上 → 「該当PCで Claude Code を開けば
    keyserve が新しい webhook を配る（.ps1 のままのPCは2セッション必要）」
  - `never` のみ → 「対処不要。導入状況は人が確認する」
- Discord 通知は `--post` を付けたときだけ行う（既定は標準出力のみ）。
  `--post` 時の宛先は既存の `DISCORD_COST_WEBHOOK` 解決を再利用する。
- **メールアドレスは既定でマスクする**（この出力は Discord に流れる可能性がある）。

### 取得失敗時

- どちらかの経路が取れなかったら、**取れた方だけで出し、取れなかった経路を明示**する
  （`⚠️ シートの取得に失敗（理由）。Discord 側のみで判定しています`）。
- **両方失敗したら `process.exitCode = 1`** にして黙って success にしない。
  片方だけの失敗で 1 にはしない。

## テスト

`classifyFleet` を fixture で検証する。ネットワークに出ない。`now` を注入して固定日付で判定する。
最低限このケースを含める:

- シートのみ24〜72h → `discord-mute`
- Discord のみ9日前 → `broken`（最終報告日が reason に入ること）
- 両方24h以内 → `alive`
- 両方に実績なし → `never`（かつ「無音」として集計されないこと）
- 片方の取得失敗（null を渡す）→ もう片方だけで判定し、失敗を明示すること
- 両方 null → exitCode 相当のフラグが立つこと（純関数側は判定結果に `unavailable: true` を返す等）

## やらないこと

- `fleet-triage-report.mjs` の既存出力・スケジュール（毎日09:23 JST の GH Actions）を壊すこと
- 新しい鍵・新しい webhook・新しい認証の追加
- `never` を異常として数えること
- HTTP 取得の再実装（既存 export を使う）
