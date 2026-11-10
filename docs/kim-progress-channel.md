# kim 進捗チャンネル仕様

> 制定: 2026-11-10 kim 指示「discord に通知しない。多すぎて見れないから全体が止まる。セッションに入れ込む。全アカウント全PCで汎用ルール化」
> 正本: このファイル。ONBOARDING/CLAUDE.md の該当行はこのファイルを参照する 1 行にする。

## 1. 原則

kim 宛の通知（進捗まとめ・完了通知・判断待ち・配送警告・社外返信待ち）は **Discord に一切送らない**。
届け先は **kim-inbox（~/.claude/kim-inbox/）のみ**。例外はない。

許可リスト（`config/kim-discord-allowlist.json`）は廃止とする。ファイルは互換性のため残すが `entries` は常に空で、
テストが空であることを要求する。`discordAllowed()` は常に false を返す。

## 2. kim-inbox の表示（SessionStart・UserPromptSubmit）

hook で注入される kim-inbox コンテキストは **合計 6KB 以下** に収め、**1 画面で読める** こと。

### 2.1 構成（先頭からこの順）

```
【進捗まとめ】
a) kim の判断待ち 上位 5 件（1 件 1〜2 行）
   - 何を決めるかだけ書き、返答コマンドは不要。答えは会話でよい。
b) 昨日〜今日の完了（席名＋案件名、最大 5 件）
c) 止まっている（最大 3 件）
   - 自動進行の check でエラー語（hub不達・timeout・EBUSY・403 等）が 2 回連続したら原因を1行添える。
d) 件数行
   - ask N／info N／返事待ち N
```

### 2.2 件数超過時の優先順位

- ask（判断待ち）> 完了 > 止まっている > info
- 同じカテゴリ内は未表示の古いものが優先
- ask は上限 5 件まで。それを超える ask は件数のみ表示
- info は上限 3 件まで。判断待ち以外は件数行に圧縮

### 2.3 削減ルール

- ask 300 件・info 300 件の合成台帳でも 6KB を超えないことをテストで確認する
- 各アイテムは 1〜2 行（140 字以内）。ask の本文は最初の 1 行のみ
- フッターは `一覧: node tools/kim-inbox.mjs --list --open` のみ
- インラインコマンド（`→ node tools/kim-inbox.mjs --answer ...`）は表示に含めない
  （kim は会話で回答すれば Claude が内部で処理する）

## 3. 朝の進捗まとめ（digest）

各席の `auto-progress-digest` は Discord ではなく **kim-inbox に 1 日 1 件** で届ける。

### 3.1 統合ルール

- 既存の `dailyProgress` / `progressDay` / `replaceExisting` 機構を使う
- 席ごとに別アイテムにせず、同一日付キーに統合する（fleet 経由で届く他席分も）
- `dedupeKey: auto-progress-daily:<JST日付>` で統合
- 前回から変化がない digest は上書きしない（`replaceExisting` + 同一テキスト判定）

### 3.2 配送経路

- kim 宛の digest 配送は `notifyOwner` → `routeOwnerDm` → `deliverKim` → `addItem`（inbox）の経路
- `deliverKim` の Discord 分岐は kim に対して使われない（削除済み）
- 配送記録（sent.jsonl）の `channel` は `kim-inbox` または `session-inbox` のみ

## 4. 完了通知

完了通知（`auto-progress-done-inbox.mjs`）の Discord ミラーは削除する。
完了通知は kim-inbox の `auto-progress-done` ソースアイテムとしてのみ届ける。

## 5. unregistered-promise-gate

「このセッションで」「1分ごと」等のセッション内待機だけを `応答の「この後の自動進行」` に書いた場合、
台帳に同じ内容の check 行（`--add-check`）が無ければ Stop ゲートで差し戻す。

### 5.1 停止検出

auto-progress の check でエラー語（hub不達・timeout・EBUSY・403 等）が stderr に
**2 回連続** 出現したら「止まっている（原因: <stderr 1 行>）」として 1 画面の c) に載せる。

## 6. ファイル変更一覧

- `tools/notify-kim.mjs`: kim 宛 Discord 分岐削除。`deliverKim` の Discord DM コード（kim 非該当の経路のみ維持）。
- `tools/lib/auto-progress-done-inbox.mjs`: Discord ミラー削除（現状なし。確認のみ）。
- `tools/lib/owner-dm-policy.mjs`: `routeOwnerDm` の kim 向け経路を `deliverKim` → inbox のみに簡略化。
- `tools/lib/kim-discord-allowlist.mjs`: 常に空を返す状態を維持（テストで要求）。
- `config/kim-discord-allowlist.json`: entries は常に空（テストで要求）。
- `tools/auto-progress-digest.mjs`: kim 宛 digest の channel を inbox のみに。
- `tools/kim-inbox.mjs`: SessionStart 注入の 1 画面化・6KB 上限。
- `tools/kim-inbox.test.mjs`: 6KB 上限テスト追加。
- `tools/kim-no-dm.test.mjs`: (a) ONBOARDING 読み取り (b) fetch ゼロ (c) digest channel (d) 6KB。
- `tools/kim-awaiting.mjs`: SessionStart 表示を件数＋上位 3 件に。

## 7. 関連ファイル

- `ONBOARDING.md` §1.15: `docs/kim-progress-channel.md` を参照する 1 行に変更
- `CLAUDE.md`: 同上