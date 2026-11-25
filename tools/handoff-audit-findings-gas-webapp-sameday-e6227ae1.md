# handoff-audit e6227ae10112570a 再発検証（GAS ウェブアプリの修正→テスト→PRマージ→版公開を当日に終える／人へ渡さない）

検証日: 2026-10-25 / 走査窓: 2026-10-23T18:02:07Z（週次監査が本パターンを学習した時刻）〜 2026-10-25T00:00Z 頃
送信・権限変更・kim への DM なし。既存の承認範囲のみ。本番データの書き込みなし。

## 結論（3点）

1. **再発 0 件。** 窓内の台帳 138 行（`handoff-audit-ledger` 67 / `stop-gate-runner-ledger` 71）と
   assistant turn 1,130（21 ファイル）を2種類の検出器で走査し、GAS の実行・反映を人／別 PC へ渡した turn は **0**。
2. **ただし「0 件」は行動が変わった証拠ではない。** 同じ窓で GAS 語彙（`GAS|clasp|CommandQueue|booth-cmd|版公開|公開配備|script.new|Apps Script`）を
   含む assistant turn が **0** で、**窓内に GAS の作業自体が発生していない**。よって本件は
   **「再発なし（母数 0）」＝未確認**として扱い、「直った」とは断定しない。
3. 経路の前提は 2026-10-25 に再実測した。**route の「clasp も未導入（`~/.clasprc.json` 無し）」は陳腐化**していたため
   `handoff-audit-knowledge.json` を実測に合わせて是正した（clasp 3.4.1 導入済み・`~/.clasprc.json`(cr@) あり。
   しかし `clasp run` は依然「所有者以外不可」なので、**人の手は DWD スコープ追加の1回だけ**という結論自体は維持）。

---

## 1. 原文（どのセッションから学んだパターンか）

`~/.claude/handoff-audit-nightly-ledger.jsonl:33`（2026-10-23T18:02:07.739Z / session `1deb58a9` / **verdict=pass**）の
learned[0] が本パターン。由来セッションの台帳逐語（`handoff-audit-ledger.jsonl`）:

- 2026-10-22T23:46:33Z: 「実装を委譲しました（worktree `booth-wt-tools`…）。完了したら差分とテストを確認し、PR→マージ→版作成→公開配備→公開画面の構文検査まで進めます」
- 2026-10-22T23:54:25Z: 「**当日アプリを直して公開しました。今の公開画面は @80 です。** … PR #67 をマージし、版80を作って公開しました」
- 2026-10-23T02:41:12Z: 「残っていたスマホ表示の確認も終わり、問題はありませんでした。… 次に kim がすること: なし」

→ これは**成功例**（同日完結・人の操作ゼロ）。監査はこの型を「当日完結の型」として学習し、
崩れたとき（人へ渡す／翌日送り）を検出する TODO を積んだ、という関係。したがって本検証の主題は
「GAS ウェブアプリの修正〜版公開を、人へ渡したり翌日へ先送りした turn が窓内に無いか」である。

## 2. 走査（一次記録）

### 2.1 リポジトリの検出器（読み取り専用）

```
node tools/handoff-audit-gas-execution-scan.mjs --selftest           # 12/12 pass
node tools/handoff-audit-gas-execution-scan.mjs --since 2026-10-23T18:02:07Z
```

| 対象 | 総数 | 窓内 | ヒット |
|---|---|---|---|
| `handoff-audit-ledger.jsonl` | 1,831 | 67 | 0 |
| `stop-gate-runner-ledger.jsonl` | 1,332 | 71 | 0 |
| transcript（`~/.claude/projects/**/*.jsonl`） | 317 ファイル | 21 ファイル / assistant turn 1,130 | 0 |

### 2.2 広い語彙での再走査（自作・同じ窓）

GAS 側の語彙を `GAS|Apps Script|clasp|script.new|CommandQueue|booth-cmd|版公開|公開配備|ウェブアプリ|Web App`、
人手側を `人に|人手|手作業|お願い|してください|してもら|代行|待ち|待って|次回|明日|先送り|後日|kim が|kim に|担当者|別PC`
に広げ、120 文字以内の共起を数えた（`handoff-audit-deferral-ledger.jsonl` も対象）。
結果は **0 件**（transcript 21 ファイル / 1,130 turn）。

### 2.3 正のコントロール（検出器が動くことの確認）

同じスクリプトを `--since 2026-10-01T00:00:00Z` で回すと **317 ファイル / 19,973 turn から 171 件**を検出する
（例: 2026-10-09 `05d575bd`「この PC の clasp が待ち受けて自動で受け取る… 次に kim がすること」）。
＝ 0 件は「検出器が壊れて何も拾わない」のではなく、**窓に該当が無い**。

### 2.4 母数（§結論2の根拠）

同じ窓で GAS 語彙を含む assistant turn は **0**（21 ファイル中 0 ファイル）。
したがって「人が渡されなかった」ではなく「GAS の作業が窓内に無かった」。次回 GAS 作業が起きた回で再走査が要る。

## 3. 経路の再実測（2026-10-25・すべて Claude 側で実行）

| 主張 | 実測 | 判定 |
|---|---|---|
| `booth-cmd.mjs` でコマンドキューへ投入できる | `~/.claude/tools-local/booth-cmd.mjs` 存在（2026-10-19 作成） | 経路は存在（キュー稼働の再実測は今回していない） |
| clasp は未導入 | `clasp 3.4.1` 導入済み（`~/AppData/Roaming/npm/node_modules/@google/clasp`）、`~/.clasprc.json` あり。id_token の email = **cr@orgiast.jp**（2026-10-24 04:07 取得） | **route が陳腐化 → 是正** |
| `clasp run` は所有者以外不可 | `clasp run listFailureCounters` → exit 0・`Unable to run script function. Please make sure you have permission to run the script function.`（2026-10-25 実測） | route の記述は正しい（「不可」ではなく実試行で確認） |
| DWD に `script.projects` / `forms.body` が無い | SA `aujust-sheets-reader@…` で DWD `sub=kim@` のトークン要求: `script.projects` = **401 unauthorized_client** / `forms.body` = **401 unauthorized_client** / 対照 `spreadsheets.readonly` = **200** | 正しい（2026-10-21・10-24 の実測を再現） |

→ **人の手として残るのは「管理コンソールで DWD に script.projects / forms.body を追加」の1回だけ**。
cr@ の clasp 初回 OAuth 同意は 2026-10-24 に済んでいるため、これを人へ再依頼してはいけない。

## 4. 修正（C4）

- `tools/handoff-audit-knowledge.json` の「GAS の関数実行が要る」route を実測に合わせて更新:
  「clasp も未導入（`~/.clasprc.json` 無し）」→「clasp は 2026-10-24 導入済み・`~/.clasprc.json`(cr@) あり。
  `clasp run` は 2026-10-25 再実測でも所有者以外不可。残る人の手は DWD スコープ追加の1回だけ」。
  - 注意: TODO id は `hash(pattern, route)` なので **route を変えると本パターンの TODO id が変わる**。
    次回の夜間監査で同パターンが再学習された場合、新しい id の TODO が1本積まれる（既知の挙動）。
- 検出器の語彙は変更していない（再発 0 件・誤検出の実例も無いため、根拠なく足さない）。

## 5. 残件

- **次に GAS 作業が起きたセッションの後に再走査**する（本窓は母数 0 のため、行動変化の証拠にならない）。
  コマンドは §2.1 の1行（`--since` をその時点に置き換える）。
- `booth-cmd` のキュー稼働（result ファイル生成）は今回再実測していない。必要になった回に、
  読み取り専用コマンド1件の投入で確認する（既存の承認範囲内）。

## 6. 検証ゲート

`node --test tools/handoff-audit-nightly.test.mjs tools/handoff-audit-gate.test.mjs` を本変更後に実行し、
route 一意性テストを含めて緑であることを確認する（結果は PR 本文に記載）。
