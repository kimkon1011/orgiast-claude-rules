# handoff-audit 検証記録: API キー/Client ID/impersonate メールの復元（2026-10-15 再検証）

対象 TODO: `[handoff-audit:0ab11a96de53cc66] API キー/Client ID/impersonate メールの復元 — この handoff が
再発していないかを実物で検証し結果を記録する（再発防止の経路: 過去 transcript・.env.local・production
bundle・keyserve から復元。user に再聞き禁止）`（`~/.claude/next-session.md`）

**id の素性（再計算で確認）**: `0ab11a96de53cc66` =
`sha256(JSON.stringify([NFKC(pattern), NFKC(route)]))` の先頭 16 桁。pattern =
`API キー/Client ID/impersonate メールの復元`、route = `過去 transcript・.env.local・production
bundle・keyserve から復元。user に再聞き禁止`（= `handoff-audit-knowledge.json` の
`API キー/接続文字列/ID が要る` の route。`node -e` で再計算し一致）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

---

## 1. 結論

| # | 問い | 判定 | 根拠 |
|---|---|---|---|
| C1 | この handoff（クレデンシャル/識別子の再聞き）は再発したか | **再発 0 件**（窓 2026-09-17〜2026-10-15） | §3（台帳 495 行・transcript 7,826 assistant turn を実走査。検出器 selftest 10/10） |
| C2 | 再発防止の route（ローカルソースからの復元）はこの PC で実行できるか | **できる**（復元は常に試せる） | §3。#065f2f08 は実際に `.env.local`・`~/.claspc.json`・`gh auth token` から 4/5 を復元した |
| C3 | 検出器は動いているか（0 件が見逃しでないか） | **動く**（陽性5・陰性5 全通過） | §2（`--selftest` 10/10）。陽性対照が通るので、この型が窓内に出れば検出される |

**0 件は「見逃し」ではない**。陽性対照（API キーを教えてください／Client ID を貼り付け／impersonate
メールを入力／クライアントシークレットをいただけますか／Webhook URL を教えていただけますか）が
すべて検出され、陰性対照（復元済みの報告・値の報告・他ベンダーの consent・ローテーション報告・
既存流用）がすべて除外されたうえでの 0 件（§2）。

---

## 2. 走査方法（読み取り専用・再実行可能）

本 PR で追加した `tools/handoff-audit-credential-reask-scan.mjs` を実走:

```
$ node tools/handoff-audit-credential-reask-scan.mjs --since 2026-09-17T00:00:00Z
since 2026-09-17T00:00:00.000Z
ledger {"total":495,"scanned":495}
transcript {"files":105,"filesScanned":105,"turnsScanned":7826}
hits 34   selftest 10/10
```

- 検出式: **クレデンシャル/識別子の名詞（CRED）∧ user に値を出させる依頼語（ASK）が ±80 文字で共起**。
  assistant の turn のみを対象（依頼する側を見る）。監査 TODO 文・knowledge の pattern 文は除外
  （TODO は毎セッションのプロンプトに入るため、数えると自己言及で膨らむ）。
- 窓の判定は **turn のタイムスタンプ**で行う（ファイル mtime ではない。古い turn が最近触られた
  ファイル経由で混入するのを防ぐ ＝ 実装中に一度踏んだ罠。テスト「窓の外は数えない」で固定）。
- 検出力の担保: `--selftest`（陽性5・陰性5）。報告前に全通過を確認（10/10）。
- 補助走査: `~/.claude/auto-session/runs/2026-10-15-5-credential-reask-scan.mjs`（同型・
  `projects-archive` も含む）でも走査 = 台帳 495 行・transcript 19,803 turn・53 hits。
  両走査の結論は同一（§3）。

**限界（過大に評価しない）**: 判定は 1 turn 内の近接共起を要求する。**turn をまたいだ再聞き
（片方の turn で「鍵が要る」、もう片方で「教えて」）は取りこぼす**。0 件は「その型が無かった」
であって「聞き直しが皆無だった」ではない。

---

## 3. 全ヒットの分類 — 34 hits（13 セッション）すべてが「正当な手渡し」または「偽陽性」

| セッション (日付) | 一致箇所 | 分類 | 理由 |
|---|---|---|---|
| cdc529a3 (10-13) | 「一覧から、クライアント ID…」 | **正当** | DWD/Admin Console の 1 アクション（API 不可）。Client ID の値は **Claude が提示**しており user から聞いていない |
| e308c0a6 (09-23〜24) | 「貼り付け: `assign@orgiast.jp`」 | **正当** | Workspace Admin Console のメールエイリアス付け替え（API 不可）。貼るのはメールアドレスの識別子であって値ではない |
| bdde3c6f (10-03) | 「手順5｜API キー…」 | **正当** | Anthropic Console のアカウント新規作成・支払い・キー発行＝rule 3 の 4 理由（アカウント作成/支払い） |
| d093c4d0 (10-03) | SA メールを共有欄に貼り付け | **正当** | シート共有の権限付与。Drive コネクタ・clasp・SA 代理の 4 経路を試して全滅した後の 1 アクション。値は SA のメール（識別子） |
| f02b974b (10-04) | 「ANTHROPIC_API_KEY…Console で 1 つ作る」 | **正当** | 既存キーは `.env.local` から流用済み。依頼は cr 名義の**新規**キー発行（Console UI）＝アカウント/コンソール操作 |
| 065f2f08 (10-04) | 「user の操作はコピー→…1クリックのみ」 | **正当** | 4/5 の secret は `.env.local`・`~/.clasprc.json`・`gh auth token` から**復元**。`DISCORD_BOT_TOKEN` は当時原本が本 PC に不在（`orgiast-discord-bot-token.txt` は 10-10 作成）で発行元が Discord Portal＝owner 操作 |
| 0a1bf1f3 (10-02) | 「サービスアカウントへの編集権限付与…こちらで行います」 | **偽陽性** | Claude が自分で実施すると宣言し、確認だけ求めている（値の依頼なし） |
| e4f0f775 (10-03) | 「…`***` に置き換えてから送ってください」 | **偽陽性** | 古川さんに**ソースコード**の共有を依頼。秘密は**伏せろ**と指示＝依頼の向きが逆 |
| e39566cd (10-06) | 「獲得リーダーはどなたですか」「Discord ID を調べて gh secret set」 | **偽陽性** | 聞いているのは**業務事実（人名）**。ID 検索と secret 投入は Claude が行う＝値は聞いていない |
| 8769a59d (10-14) | 「このPCにはサービスアカウント…」 | **偽陽性** | 能力の報告文（rule 12 系）。依頼語が無い |
| 79f3d8d8 (10-12) | 「シークレットウィンドウで…」 | **偽陽性** | `シークレット`＝incognito。CRED 語の誤マッチ |
| 8114011b (10-13) | 「…スクショでも構いません」「シークレット手順」 | **偽陽性** | 症状の**質問**（診断）と incognito 手順 |
| ac13f80d (10-14) | 「シークレットウィンドウで開いてください」 | **偽陽性** | 同上（incognito） |

**真の「クレデンシャルの再聞き」＝ 0 件。** 正当な手渡しはすべて rule 3 の 4 理由（OAuth 初回同意／
支払い／アカウント作成・ログイン／物理操作）または API 不可の Admin Console 操作に該当し、
`[HANDOFF-OK]`／`[手渡し判定]` が本文に付いている。**復元可能な値（既存キー・SA 鍵・トークン）を
聞き直した例は窓内に無い。**

---

## 4. 偽陽性の型（検出器の限界として既知。恒久策は人手分類）

1. **`シークレット` = incognito**: 「シークレットウィンドウ」が CRED 語に誤マッチ（4 セッション）。
2. **`gh secret` / `.env`(名称)**: secret という語が識別子名として出るだけ。
3. **サービスアカウントのメールアドレス**: 共有欄に貼るのは識別子で、秘密の値ではない。
4. **業務事実の質問**: 「獲得リーダーは誰か」等。値ではなく社内の呼び方。
5. **他者への提供依頼**: 古川さんにソースを送ってもらう（秘密は伏せろと指示）。

→ いずれも「Claude が user から**秘密の値そのもの**を聞き直した」型ではない。検出器は候補列挙までを
担い、最終分類は人手で行う設計とした（`--selftest` で陽性/陰性の両方向を固定済み）。

---

## 5. 恒久策

- **再発監査を 1 コマンドに固定**: `tools/handoff-audit-credential-reask-scan.mjs`（読み取り専用・
  再実行可能）＋対照テスト `tools/handoff-audit-credential-reask-scan.test.mjs`（7 件 pass）を追加。
  次にこの型の監査が来たら `--since` を付けて 1 コマンドで数えられる。
- **knowledge に再検証を記録**: `handoff-audit-knowledge.json` の `API キー/接続文字列/ID が要る` の
  `source` に本再検証（0 件・走査手順）を追記。route 本文は正しいため変更しない（id の安定を保つ）。

`kim に新しい作業は発生しない`。

---

## 6. 未確認（推測で埋めない）

| # | 未確認事項 |
|---|---|
| U1 | turn をまたいだ再聞きの見落とし率（§2 限界）。 |
| U2 | `projects-archive` 側の生 transcript のうち、turn 時刻を持たない行（mtime で近似）は厳密に窓判定できていない。 |
| U3 | 他 PC・他アカウントの transcript（本記録は DESKTOP-PPD5V8I の `~/.claude/projects` の実測）。 |

---

**次に kim がすること: なし**
