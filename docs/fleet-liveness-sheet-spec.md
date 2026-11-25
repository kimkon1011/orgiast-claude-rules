# 仕様: 生存判定の結果をフリートシートに書く

kim 指示 2026-08-28「残り4台は 2026-08-19 の webhook 削除で止まったまま → **これも状況をスプレッドシートに書くようにして**」。

現状 `tools/fleet-liveness.mjs` の判定（生存 / Discordにだけ届かない / 壊れて停止 / 報告実績なし / 手入力のみ / 未確定）は
**Discord にしか出ていない**。シートを見ても「なぜ空欄なのか」が分からない。シート側に状態を持たせる。

対象シート: 「オージャスト クラウド契約・プロジェクト台帳」（`https://docs.google.com/a/orgiast.jp/spreadsheets/d/1soai_gMbH0C-67J8680Y26Y7KJWkV87sFZxCgDQ2BbI/edit`、`FLEET_SHEET_URL` の既存 Web App）。
**PC管理表（備品管理表）ではない。**

## 追加する列（既存のオプショナル列の仕組みに乗る）

`gas/fleet-status-sheet/UpsertLogic.gs` の `FLEET_OPTIONAL_HEADERS_` と同じ方式で、
**無ければ右端に追加**する。既存の列順は変えない。

| キー | ヘッダ | 内容 |
|---|---|---|
| `livenessState` | `稼働状態` | `生存` / `Discord不通` / `停止` / `報告実績なし` / `手入力のみ` / `要確認` |
| `livenessReason` | `状態の理由` | `fleet-liveness` の reason 文をそのまま |
| `livenessCheckedAt` | `状態確認日(JST)` | `YYYY-MM-DD HH:mm` |

## 書き込みの絶対条件

- **この3列以外に一切書かない**（許可リスト方式。`PcInventoryLogic.gs` と同じ流儀）。
  特に **A〜E列（人間の手入力）と O列『整合性(自己申告↔検知)』（kim の手書き）には絶対に書かない**。
- 行の突合は既存 `fleetPlanUpsert` と**同じ規則**にする:
  第1キーは **F列（機械生成ラベル）の完全一致**、次に **D列（自己申告PC名）一致かつ F列が空**。
  **「D列一致だが F列に別ラベルが入っている行」は絶対に触らない**（他PCの行を奪うため）。
- 突合できなかった項目は**行を作らない**。戻り値の `unmatched` に名前を入れて返す
  （勝手に追記すると重複行が増える。増やすかどうかは人が決める）。
- 1リクエストで複数行を更新する。**部分的に失敗しても全体を落とさず**、
  更新できた行数と `unmatched` を返す。

## 実装

### GAS
- `gas/fleet-status-sheet/LivenessLogic.gs`（純ロジック）
  `fleetPlanLiveness(headers, rows, payload)` → `{ updates: [{rowIndex, values}], unmatched: [name] }`
  `payload.items = [{ names: [...], state, reason }]`、`payload.checkedAt`。
  `names` はラベル/シート表記/別表記の候補配列（`fleet-pc-map.json` の aliases を含む）。
- `gas/fleet-status-sheet/Liveness.gs`
  `upsertFleetLiveness(payload)` — LockService、ヘッダ解決、`fleetPlanLiveness` の結果だけを書く。
  **書き込んだ列見出しを `written` として返す**（本番で許可リストが守られたことを検証するため）。
- `gas/fleet-status-sheet/WebApp.gs` の `doPost` に `kind: 'liveness'` を追加（既存 `FLEET_TOKEN` 認証）。
  既存の分岐は変えない。

### Node
- `tools/fleet-liveness.mjs` に `--post-sheet` を追加。
  分類結果を `{token, kind:'liveness', checkedAt, items:[{names,state,reason}]}` として POST する。
  `state` は上表の日本語に変換する純関数 `toSheetState(state)` を export しテストする。
  `names` は `fleet-pc-map.json` の別表記を含めて渡す。
  既定（フラグ無し）の挙動は今までどおり変えない。`--post`（Discord）とは独立。
- `.github/workflows/fleet-triage.yml` の実行を `--post --post-sheet` にする。

## テスト

`tools/liveness-logic.test.mjs`（`LivenessLogic.gs` を Node から読み込む。既存 `pc-inventory-logic.test.mjs` と同じ流儀）:

- 許可3列だけが書かれ、**A〜E相当と O列に1つも書かれない**こと（列順をシャッフルしても成立）
- F列完全一致で更新されること
- **D列一致だが F列に別ラベルがある行は触らない**こと（最重要の回帰）
- 突合できない項目が `unmatched` に入り、行が増えないこと
- 既存の `fleetPlanUpsert` のテストが壊れていないこと

`tools/fleet-liveness.test.mjs` に `toSheetState` のテストを追加（6状態すべて）。

## やらないこと

- 3列以外への書き込み
- 突合できない項目の自動追記
- 既存の行マッチング規則の緩和
- 新しい鍵・新しい認証
