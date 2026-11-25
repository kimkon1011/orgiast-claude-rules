# handoff-audit 検証記録: permission 分類器で自動経路が止まった（2026-09-28 再検証）

対象 TODO: `[handoff-audit:064c3bab336385c6] permission 分類器で自動経路が止まった — この handoff が
再発していないかを実物で検証し結果を記録する`（`~/.claude/next-session.md`）

**結論: 読み取り経路では再発していない（6経路すべて拒否 0・本日実打ち）。** 唯一止まったのは
DWD（Google API）の読み取りだが、原因は**分類器ではなくサービスアカウント鍵がこの PC に無いこと**。
分類器の拒否記録も設定の実態も、2026-09-16 の前回監査（`handoff-audit:6118610912f4efc8`）から
**ブロックが起きにくい方向に変わっている**（defaultMode が auto → bypassPermissions）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

---

## 1. 本日の実測（2026-09-28・すべて本セッション）

分類器の判定はログに残らないため、**「実際に打って通ったか」を一次証拠**とした。

| # | 経路（読み取り専用） | 実行結果 | 拒否 |
|---|---|---|---|
| 1 | `node -e "fetch('https://www.googleapis.com/discovery/v1/apis')"` | `HTTP 200` | なし |
| 2 | `curl -s -o /dev/null -w "%{http_code}" https://www.googleapis.com/discovery/v1/apis` | `HTTP 200 in 0.32s` | なし |
| 3 | WebFetch `https://www.googleapis.com/discovery/v1/apis` | `kind=discovery#directoryList` / 138件以上を返した | なし |
| 4 | `node tools/google-property-check.mjs`（orgiast-claude-rules-work・DWD 読み取り） | **実行できた**（exit 2）→ 中身は `credential_missing` | なし（拒否ではない） |
| 5 | `node tools/check-room-texts.mjs`（nf-minpaku・Beds24 API 読み取り） | `取得 64724 字` / exit 0 | なし |
| 6 | `node tools/keyserve-status.mjs` | `keyserve: 成功 (HTTP 200)` / 12ファイル配布 | なし |

→ **2026-09-20 の実測（4経路すべて拒否なし）は本日も再現した。** 経路は増やして 6 経路。

## 2. 唯一止まったもの＝分類器ではない

経路4 の `google-property-check.mjs` は**実行自体は通った**（プロセスが走り、判定を返した）。
返ったのは `credential_missing`：

```
GOOGLE_SA_KEY: 未設定 / GOOGLE_SERVICE_ACCOUNT_KEY_B64: 未設定 / GOOGLE_APPLICATION_CREDENTIALS: 未設定
既定: ~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json → 存在しない
keyserve 配布ファイル一覧に Google SA 鍵は含まれない（12ファイル：各種LLM APIキー・Discordトークン等）
```

**これは「分類器が止めた」ではなく「資格情報が無い」。** 監査基準4のとおり、この PC では
GA4 / Search Console / GTM の有無は**未確認**（GTM の scope 云々を論じる以前の状態）。
2026-09-21 の別監査（credentials-restore）も「この PC に GCP SA 鍵は無い」で一致している。

## 3. 設定の実態が前回監査から変わっている（確認済み）

`~/.claude/settings.json` の推移をバックアップから実測（`permissions`）：

| 時点 | defaultMode | allow | ask | deny |
|---|---|---|---|---|
| 2026-09-15（前回監査の直前） | `auto` | 13 | 0 | 0 |
| 2026-09-18 03:35 バックアップ | `auto` | — | — | — |
| 2026-09-22 06:06 バックアップ | **`bypassPermissions`** | — | — | — |
| 2026-09-28（現在） | `bypassPermissions` | **93** | 0 | **34** |

- 切替は 2026-09-18 03:35 〜 2026-09-22 06:06 の間。全社ルール §1.14（kim 2026-09-17 決定
  「permission mode の既定は bypassPermissions」）と整合する。
- **現在の deny 34 件はすべて破壊的操作と秘密の読み取り**（`rm -rf` / `git push -f` / `gh repo delete` /
  `Read(**/.env)` 等）。**fetch / curl / node tools / WebFetch を塞ぐ deny は 0 件。**
- 前回監査が「まだ足していない」と書いた beds24 / airbnb / browser 系の allow は、93 件の中に**依然 0 件**
  （`beds24|airbnb|browser|verify-live` で実測。ヒット1件は作業ディレクトリ名を含む PowerShell コマンドで、
  当該ツールの許可ではない）。**それでも §1 の6経路は通っている**＝ allow ルールの有無は読み取り経路の
  通過条件ではない、という前回監査の結論を追認する。

→ 「auto-mode classifier が自動経路を止める」という**この handoff の前提そのものが、現在の設定では成立しない**。

## 4. 再発していないことの弱い証拠（過大に評価しない）

- `~/.claude/auto-session/runs/2026-09-25〜27-1.json` に拒否・ブロックの記録 0 件。
- `~/.claude/logs/*.log` に `blocked by classifier` 0 件。
- ⚠️ **ただしこれは弱い**。Claude Code は分類器の拒否をファイルに残さない。
  「ログが無い」は「ブロックが無かった」証拠にならない（監査基準4）。
  強度があるのは §1 の**実打ち**であって §4 ではない。

## 5. この handoff が繰り返し再生成される理由（確認済み）

`tools/handoff-audit-knowledge.json` に
`{"pattern":"permission 分類器で自動経路が止まった","route":"…分類器で止まるなら『未確認』と書く…"}`
が **confidence: high** で常駐している。監査は「route に分類器の語を含む知識」から TODO を作るため、
**実測で再発が否定されても TODO 自体は毎回生まれる**。2026-09-16 の監査（id `6118610912f4efc8`）と
本日（id `064c3bab336385c6`）は同じ知識項目から出た**同一 TODO の2回目**。

→ 恒久策は「許可ルールを足す」ではなく、**この知識項目の route に実測日を入れて曖昧さを消す**こと。
本記録で route を更新した（§7）。

## 6. 未確認（推測で埋めない）

| # | 未確認事項 |
|---|---|
| U1 | 本セッションが `bypassPermissions` で動いているか。起動元（auto-session runner）が渡す mode は本セッションからは観測できない。§1 の実打ちは「この経路が通った」ことの証拠であって mode の証拠ではない。 |
| U2 | GA4 / Search Console / GTM の有無（SA 鍵が無いため照会不能＝未確認）。 |
| U3 | 他の PC でも同じ結果か。本記録は DESKTOP-PPD5V8I の 1 台のみの実測。 |
| U4 | 破壊的操作（Production Deploy / Merge Without Review 等）が今も拒否されるか。**本監査では試していない**（試すべきではない）。 |

## 7. kim に1回だけ提案（恒久策）

やることは1つだけ。**§5 の知識項目の route は本記録で更新済み**なので、追加の作業は不要。

1. **【任意・1クリック】GA4 / Search Console を Claude 側から読めるようにする**
   この PC にサービスアカウント鍵が無いため、現状は「未確認」しか書けない。鍵を
   `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json` に置くだけで
   `node tools/google-property-check.mjs` が自動で読む（**追加の設定作業は不要**）。
   ※ただし 2026-09-20 実測では別経路で GA4/Search Console は読めていた。**急ぎではない。**

2. **settings.json の許可ルール追加は提案しない。** deny 34 件は破壊的操作と秘密の読み取りのみで、
   読み取り経路を塞ぐものは 0 件。**足す必要が無い**（§3）。むしろ deny を緩める提案は §1.1 🛑上限に触れる。

**次に kim がすること: なし**

---

## 8. 途中で一度「PR 不可」と誤判定した（記録として残す）

自動セッションの定型指示は「PR を作り CI green を確認して `gh pr merge --squash`」まで求める。
本監査は最初これを**「この PC では PR を作れない」と結論しかけた。誤りだった**ので経緯を残す。

| 段階 | 実測 | 判定 |
|---|---|---|
| 1 | `gh auth status` → `You are not logged into any GitHub hosts` | 「不可」と即断（**誤り**） |
| 2 | `~/.config/gh/hosts.yml` 無し / `GH_TOKEN`・`GITHUB_TOKEN` 未設定 | 誤りを補強してしまった |
| 3 | **repo 自身のゲートを読む** → `tools/gh-handoff-gate.mjs` に「gh 未認証は手渡しの理由になりません。`git credential fill` の password を GH_TOKEN に入れて自分で作ってください」と明記 | 前提が崩れた |
| 4 | `GH_TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' \| git credential fill \| sed -n 's/^password=//p') gh auth status` → `✓ Logged in to github.com account seisaku-team-org (GH_TOKEN)` / scopes: `gist, repo, workflow` | **PR 作成は可能** |

- **教訓（監査基準4の裏返し）**: 「gh が未認証」は**認証情報が無いことの証拠にならない**。
  資格情報は **Windows 資格情報マネージャに在り、`git credential fill` で取得できる**。
  ツールの既定の探索パスだけを見て「無い」と判定したのが誤りの正体で、これは
  「Claude 側ログの不在＝外部の不在」と同じ型の誤り。
- 手渡し（kim に `gh auth login` を頼む）に逃げなかったことが今回の分岐点だった。
  repo のゲートが先にこの経路を明文化していたにもかかわらず、**最初はそれを読んでいなかった**。
