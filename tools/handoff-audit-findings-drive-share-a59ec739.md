# handoff-audit 検証記録: 「Drive の共有設定（SA への権限付与）」（2026-10-23 再検証）

対象TODO: `[handoff-audit:a59ec7396063a0c4] Drive の共有設定（SA への権限付与） — この handoff が
再発していないかを実物で検証し結果を記録する`（`~/.claude/next-session.md` 残TODO 9）

**id の素性（再計算で確認）**: `a59ec7396063a0c4` = `sha256(JSON.stringify([NFKC(pattern), NFKC(route)]))` の先頭16桁。
pattern = `Drive の共有設定（SA への権限付与）`、route = `SA 直では quota 0 で失敗。DWD で kim を impersonate（subject）して作成`
（`tools/handoff-audit-knowledge.json` の「Drive にファイル/Sheet を作る」の route と同文）。
`node -e` で両者から再計算し一致を確認した（2026-10-23）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみ。

---

## 1. 結論

| # | 問い | 判定 | 根拠 |
|---|---|---|---|
| C1 | 事象後、同じ手渡しは再発したか | **0 件**（窓 2026-10-21T06:15Z〜2026-10-23T03:20Z） | §2（台帳 828 行・transcript 17 ファイル / 871 turn・自動セッション summary 19 ファイルを実走査、検出器 selftest 10/10 ＋ 実データ陽性対照 15 件） |
| C2 | 検出器は本当に検出できるか | **検出できる**（実データで陽性対照を確認） | §3（同じ窓を 06:00Z からに広げると、当該インシデント 15 件を検出） |
| C3 | route（DWD で kim を impersonate）はこの PC で実行できるか | **この PC では実行できない（資格情報が無い）＝未実行** | §4（5 経路を実測。鍵が無いので DWD も SA 直も打てていない） |
| C4 | 元の手渡しは解消したか | **解消済み（Claude 側ログで確認）** | 2026-10-21T06:33:12Z の記録「5つすべてを、SA から読めるようになりました」「計算開始で元データの読み込みは全部成功」 |

**C3 は「分類器が止めた」ではない。** 鍵ファイルがこの PC に無い、という資格情報の不在（5 経路の実測）。
他の PC（kim-PC 等）に鍵があるかは未確認で、本記録はこの 1 台の実測。

---

## 2. 再発走査（一次記録・2026-10-23 実走）

走査ツール: **`tools/handoff-audit-drive-share-scan.mjs`（本 PR で追加。読み取り専用・再実行可能）**

```
node tools/handoff-audit-drive-share-scan.mjs --since 2026-10-21T06:15:00Z
```

| 走査元 | 対象 | 件数 |
|---|---|---|
| `~/.claude/handoff-audit-ledger.jsonl` | 全行 / 窓内 | 828 / **417** |
| `~/.claude/projects/**/*.jsonl` | 全ファイル / mtime 窓内 / assistant turn 窓内 | 49 / 17 / **871** |
| `~/.claude/auto-session/runs/*.summary.md` | 全ファイル / 窓内 | 28 / **19** |
| **一致** | | **0** |
| selftest（陽性5・陰性5） | | **10/10 pass** |

- 判定式: **権限付与を表す共有語**（`共有設定` `閲覧者で共有` `編集者として共有` `権限を付与` `アクセス権`
  `〜さん／メールアドレスに…共有`）∧ **相手への依頼語**（`ください` `してもら` `お願い` `依頼` `頼む` 等）の ±80 文字共起。
- 除外: 監査 TODO 文（`[handoff-audit:` を含む）・完了報告（`共有しました` `共有済み` `共有されています`
  `共有の確認` `共有モジュール` 等）・Claude 自身のツール実行（`drive-share.mjs … --to/--id`）・knowledge の route 文。
- 走査は Claude の発話（assistant turn）だけを数える。user の依頼文や古い turn を拾わないよう、
  ファイル mtime だけでなく **turn 自身の timestamp** でも窓を切る（初版は mtime だけで 34 件の偽陽性が出たため）。

**限界**: 1 turn 内の近接共起しか見ないため、turn をまたいだ手渡しは取りこぼす。0 件は「その型が無かった」であって
「手渡しが皆無だった」ではない。

---

## 3. 検出力の対照（実データ）

同じ走査を窓の起点だけ 06:00Z に戻すと、当該インシデントが **15 件** 出る（`--since 2026-10-21T06:00:00Z`）。
代表 2 件（逐語）:

> 2026-10-21T06:11:28.694Z / b822034d: 「Drive で照会したところ、2つとも所有者は kim@orgiast.jp で、cr@ はドメイン閲覧者でした。
> **共有の設定を変えられるのは kim さんだけです。** Bot トークンも kim さん側での発行が要ります。」

> 2026-10-21T06:14:48.606Z / 4d7e4383: 「| 元データの共有 | ドライブの共有設定 | … アプリ用のサービスアカウントには共有されていない |
> … ・人事評価集計シートと前期 backup フォルダを、furikomide-ta@freeebankde-ta.iam.gserviceaccount.com に閲覧者で共有
> ・社内 Discord Bot のトークンを… kim さんへの依頼文は、次の内容で私から Discord の DM で送れます。」

→ 検出器は「この型」を実データで捕まえる。窓を 06:15Z にすると 0 件なので、
**06:14 の依頼以降、同型の手渡しは作られていない**。

## 4. route の実行可否（2026-10-23・この PC = HP / cr@orgiast.jp）

| # | 探索 | 結果 |
|---|---|---|
| 1 | 既定パス `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json`（`tools/lib/drive-auth.mjs` の `defaultDriveKeyPath`） | 存在しない（`ls`: No such file） |
| 2 | `C:\Users\test` 配下の再帰探索（maxdepth 8、`node_modules`/`.git` 除外）で `*-sa.json` / `service-account*.json` / `*.gcp` | **0 件** |
| 3 | 環境変数 `GOOGLE_SA_KEY` / `GOOGLE_IMPERSONATE`、`~/.claude/settings.json` の `env` | すべて未設定（`env` は `{}`） |
| 4 | keyserve（`node tools/keyserve-status.mjs`） | `失敗 (HTTP 401)` / 配布ファイル 0（未 enroll） |
| 5 | `~/Downloads` の実体 | SA 鍵は無い（インストーラ・CSV のみ） |

**この PC では DWD トークンを発行できないため、route の「DWD で kim を impersonate して作成」も
「SA 直の quota 0」も実打ちしていない（未確認）。** 推測で「動く／動かない」を書かない。

補足: 元 handoff の共有依頼は **Vercel 上の経理ハブの SA**（`GOOGLE_SERVICE_ACCOUNT_KEY_B64`、
`src/lib/shoyo/sources.ts` は `google.auth.JWT` で subject 無し）に対するもので、Claude 側の DWD では代替できない種類。
knowledge の route 文が指す「作成」は Claude が Drive にファイルを作る場面であり、両者を混同しないこと。
この限定は route 文には書かれていない（下記 §5）。

---

## 5. 推奨（次セッションの 1 手）

- **A.（記録のみ・追加権限ゼロ）** 本 findings とスキャナを main に残し、次回以降は
  `node tools/handoff-audit-drive-share-scan.mjs --since <前回日時>` で再発を機械確認する。
- **B.（別 PR・要テスト固定）** `tools/handoff-audit-knowledge.json` の「Drive にファイル/Sheet を作る」route を
  「SA 直では quota 0 で失敗。DWD で kim を impersonate（subject）して作成」から
  「**Claude が Drive に作る／読む場面**は SA 直では quota 0 で失敗するので DWD で kim を impersonate する。
  **外部アプリ（Vercel 等）の SA に読ませる場面**はその SA への共有が別途必要（DWD では代替できない）」に限定する。
  route を書き換えると dedupe キー `hash(pattern, route)` が動き TODO id が変わるため、
  `enqueueTodos` のテストで固定したうえで単独 PR にする（今回は変更していない）。
- **C.** この TODO 行は id を残したまま完了にする（id を消すと重複判定が外れて再生成されうる）。

## 6. 未確認（断定しない）

- この PC 以外（kim-PC 等）に SA 鍵があるか、そこで DWD route が通るか。
- 2026-10-21 06:14 の依頼を kim がどう実施したか（Discord DM か、手動共有か）。06:33 の記録では
  「SA から読めるようになった」ことだけが Claude 側ログで確認できる。
