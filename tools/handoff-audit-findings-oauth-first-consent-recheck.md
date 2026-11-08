# handoff-audit 検証記録: OAuth 初回同意の承認を user に依頼（2026-10-01 再検証）

対象 TODO: `[handoff-audit:8c97bb8b5e2e2968] OAuth 初回同意の承認を user に依頼 — この handoff が
再発していないかを実物で検証し結果を記録する`（`~/.claude/next-session.md`）

**id の素性（再計算で確認）**: `8c97bb8b5e2e2968` =
`sha256(JSON.stringify([NFKC(pattern), NFKC(route)]))` の先頭16桁。
pattern = `OAuth 初回同意の承認を user に依頼`、route = **本記録 §5 で更新した
`handoff-audit-knowledge.json` の 0 番目**（`Google 系プロパティ(GA4/Search Console/GTM)の有無確認`）の route。
つまりこの TODO は、あの route から機械生成されたもの。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

---

## 1. 結論

| # | 問い | 判定 | 根拠 |
|---|---|---|---|
| C1 | handoff は再発したか | **再発 0 件**（窓 2026-09-20〜2026-10-01） | §3（台帳 347 行・transcript 35,073 turn を実走査。検出器の対照 5/5） |
| C2 | route（DWD 照会）はこの PC で実行できるか | **できない**（資格情報が無い） | §2（5 経路すべて不在を実測） |
| C3 | GA4 / Search Console / GTM の有無 | **この PC では未確認** | §2・§4。route が動かないので推測で埋めない（監査基準 4） |

**C2 は「分類器が止めた」ではない。** プロセスは走り、判定を返している（`exit 2` = 設定エラー）。
止まっているのは資格情報の有無であって権限ではない。2026-09-28 の別監査
（`tools/handoff-audit-findings-permission-classifier-recheck.md` §2）が同じ結論を出しており、本記録はそれを追認する。

---

## 2. route の実行可否 — 5 経路で不在を確認（2026-10-01・すべて本セッション実測）

```
$ node tools/google-property-check.mjs           # ← 実行できた（拒否ではない）
SA key not found: C:/Users/uers/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json
EXIT=2
```

`exit 2` はツール自身の定義で「設定エラー（SA キーが無い）」。分類器の拒否でも HTTP エラーでもない。

| # | 探索した場所 | 結果 |
|---|---|---|
| 1 | 既定パス `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`（`DEFAULT_KEY` が指す先） | 存在しない。`~/Downloads` には `desktop.ini` と xlsx 1 件のみ |
| 2 | 環境変数 `GOOGLE_SA_KEY` / `GOOGLE_IMPERSONATE` / `GOOGLE_APPLICATION_CREDENTIALS`（プロセス・Machine・User の3スコープ） | すべて未設定 |
| 3 | keyserve（`node tools/keyserve-status.mjs`） | `成功 (HTTP 200)` / 配布 12 ファイル（各 LLM API キー・Discord トークン等）に **Google SA 鍵は無い** |
| 4 | `C:\Users\kimko` 配下の再帰探索（`sheets-sa.json` / `*sa.json` / `service-account*.json` / `.gcp` ディレクトリ） | 0 件 |
| 5 | Windows 資格情報マネージャ（`cmdkey /list`） | Google 系 0 件（Microsoft アカウント・`git:https://github.com`・DriveFS・teams・logicool のみ） |

### なぜ 5 経路も見たか（前回の失敗の型をなぞらないため）

2026-09-28 の別監査は「既定パスに無い」で止めかけた。その監査自身が §8 で
**「ツールの既定の探索パスだけを見て『無い』と判定するのは、『Claude 側ログの不在＝外部の不在』と
同じ型の誤り」** と記録している（`gh` は未認証に見えたが `git credential fill` でトークンが取れた事例）。
同じ轍を踏まないよう、既定パス以外に **環境変数3スコープ・keyserve 配布物・全再帰探索・資格情報マネージャ**
まで当たった。結果、この PC については「無い」と言い切れる材料が揃った（不在の断定ではなく、5 経路の実測）。

**依然として未確認の残る範囲**: 鍵の無い *他の* PC の状態（本記録は DESKTOP-PPD5V8I 1 台の実測）。

---

## 3. 再発走査 — 0 件（検出力つき）

route が動かない以上、「DWD で読めるから user 同意は不要」を **機械では示せない**。
そこで本監査は問いを分け、**「Claude が実際に user へ Google プロパティの OAuth 同意を手渡したか」**を
一次記録から数えた。これは route の実行可否に依存しない（資格情報が無くても数えられる）。

- 走査ツール: **`tools/handoff-audit-oauth-consent-scan.mjs`（本 PR で追加。読み取り専用・再実行可能）**
  ```
  node tools/handoff-audit-oauth-consent-scan.mjs --since 2026-09-20T00:00:00Z
  ```
  実走結果（2026-10-01）: `ledger.scanned=347` / `transcript.filesScanned=210` / `transcript.turnsScanned=35,073` /
  `hits=0` / `selftest 5/5 pass`。transcript は本セッション自身が書き足すので再実行ごとに turn 数は増える
  （2 回目の実走では 35,187）。件数が動くのは turn 数だけで、`hits` は 0 のままだった。
- 窓: `2026-09-20T00:00:00Z` 〜 `2026-10-01`（route が「2026-09-20 実測」と書いている起点）
- 判定式: **Google プロパティ語 ∧ OAuth 同意語 ∧ 他ベンダーでない**

| 走査元 | 対象 | 件数 |
|---|---|---|
| `~/.claude/handoff-audit-ledger.jsonl`（監査が `fired` と判定した turn） | 窓内の行 | **347**（全 545 行） |
| `~/.claude/projects/*/*.jsonl`（生 transcript） | 窓内 mtime のファイル / turn | **210 ファイル / 35,073 turn**（全 513 ファイル） |

**結果: 0 件。**

### 検出力（「0 件」が「見逃し」でないことを先に示す）

走査結果だけでは 0 件が「検出できなかった」のか「本当に無かった」のか区別できない。
`--selftest` で陽性対照 2 件・陰性対照 3 件を通した:

```
$ node tools/handoff-audit-oauth-consent-scan.mjs --selftest
ok   P1 GA4 の同意を依頼                (want=true  got=true)
ok   P2 Search Console を開いて許可して  (want=true  got=true)
ok   N1 GitHub device flow              (want=false got=false)
ok   N2 codex login                     (want=false got=false)
ok   N3 GA4 の数値報告（手渡し無し）     (want=false got=false)
selftest: 5/5 pass
```

対照はテストにも固定した（`tools/handoff-audit-oauth-consent-scan.test.mjs`・5 件 pass）。
陽性対照が無いと「0 件」が無意味になり、陰性対照が無いと常時 true の検出器を見逃す。

- 陽性対照が通るので、**この型の handoff が窓内に現れていれば検出されていた**。
- 陰性対照（他ベンダーの OAuth）が落ちるのは設計どおり。GitHub device flow と codex login の
  同意は DWD では代替できず、**正当な手渡し**なので対象外。台帳には実際に 2026-09-30 の
  GitHub device flow 同意（`3c1c923f`）が入っており、それが正しく除外されている。

**残る限界（過大に評価しない）**: 判定は 1 turn 内の共起を要求する。**「OAuth 同意が要る」と
「GA4 を読みたい」が別 turn に分かれた手渡しは取りこぼす**。補助として「Google プロパティ語 ∧
user への依頼語 ∧ 他ベンダーでない」の緩い走査も別途打ったが、窓内の該当は 0 件だった
（唯一の一致は 2026-09-17 の Airbnb エクストラネットの話で、窓外かつ対象外）。

---

## 4. 未確認（推測で埋めない）

| # | 未確認事項 |
|---|---|
| U1 | この PC から GA4 / Search Console / GTM が見えるか（SA 鍵が無く照会不能＝**未確認**）。 |
| U2 | GTM の DWD scope（`tagmanager.readonly`）が今も未登録か。**鍵が無いのでスコープ以前**の状態。 |
| U3 | 鍵を持つ PC での再現（本記録は DESKTOP-PPD5V8I 1 台。2026-09-20 の GA4 ok / GSC ok は別 PC の実測）。 |
| U4 | 再発走査は「1 turn 内の共起」を見る。turn をまたぐ手渡しの見落とし率は測っていない（§3 限界）。 |

---

## 5. 恒久策 — knowledge の route を更新した（本記録で実施）

**なぜ必要か**: 監査 TODO は route から機械生成される。route が「鍵のある PC を前提にした手順」のまま
だと、**鍵の無い PC のセッションが毎回「route を実行できない」で空回りする**。実際、本 PC では
2026-09-28 の別監査と本日の 2 回、同じ「鍵が無い」に着地している。

`tools/handoff-audit-knowledge.json` の 0 番目の `route` に、次を追記した:

1. **前提**: この照会は SA 鍵のある PC でしか動かない。鍵の無い PC では `exit 2` で終わり、
   GA4 / GSC / GTM は「未確認」で止める（推測で埋めない）。探索すべき 5 経路も明記。
2. **鍵の有無に関わらず再発監査はできる**（`tools/handoff-audit-oauth-consent-scan.mjs` の走査。本日の実測値を併記）。

あわせて走査ツール本体 `tools/handoff-audit-oauth-consent-scan.mjs` とその対照テスト
`tools/handoff-audit-oauth-consent-scan.test.mjs` を追加した。次にこの型の監査が来たときは、
鍵の有無を調べる前に 1 コマンドで再発の有無を数えられる。

route 文は `buildPrompt` がそのまま引用させ、未知 route は nightly が捨てる＝**監査の唯一の正本**なので、
ここを直すのが唯一効く恒久策（2026-09-28 の permission 分類器監査 §5・§7 と同じ判断）。

**kim に新しい作業は発生しない。** 鍵を置けば route が使えるようになる、という情報のみ（任意・急ぎではない。
2026-09-20 に GA4 / Search Console は読めている）。

---

**次に kim がすること: なし**
