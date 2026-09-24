# handoff-audit 再発検証: 「GAS の関数実行が要る」（2026-09-25 実測）

対象 TODO: `[handoff-audit:2a521d8efb465e3a] GAS の関数実行が要る — この handoff が再発していないかを
実物で検証し結果を記録する`
正本エントリ: `tools/handoff-audit-knowledge.json`

```json
{ "pattern": "GAS の関数実行が要る",
  "route": "clasp run / コマンドキュー経由で Claude 側から実行。『▶実行してください』は違反",
  "confidence": "high", "source": "§1.4" }
```

## 結論（3行）

1. **「▶実行してください」型の人手依頼は再発していない** — 直近 31 日の 450 transcript を走査して 0 件。
   最後の実例は 2026-05-19（ルール制定前）。
2. ただし**弱い形は 1 件出た** — 2026-09-24 session `6c7dca27` が「kim の手作業が要る可能性があります」と
   試行せずに投げ、監査 rule 3 で block された。**これが本 TODO の発生源**。
3. **route の文言は本案件では成立しない** — `clasp run-function` は Workspace ポリシーで使用不可、
   コマンドキューは nf-minpaku の GAS プロジェクトに未実装。実際に使えるのは **Web App ゲートウェイ**で、
   2026-09-25 に **kim の操作ゼロで通ることを実測**した。→ 「実行できるのに人に渡した」が正しい判定。

---

## 1. 再発の実測

### 1.1 transcript 走査（実物）

`~/.claude/projects/**/*.jsonl` のうち mtime > 2026-08-25 の **450 本**を走査。

| 見たもの | 件数 |
|---|---|
| 最後のアシスタント発話（＝handoff 本文）に人手への `▶実行` 依頼 | **0**（唯一の一致は本セッション自身のプロンプト echo） |
| `▶` を含む文（全ロール） | 181 |
| うち **assistant が人手に `▶実行` を求めた文** | **3 — すべて 2026-05-19 session `3017a52d`** |

2026-05-19 の逐語（ルール制定前）:

- `` `setupSpecialDays2026` を選んだ状態で **`▶ 実行`** ボタンをクリック。 ``
- `### 4. 「▶ 実行」をクリック`

これ以降、assistant が人手に ▶実行 を求めた文は **1 件も無い**。
`▶` の残りは (a) 利用者側プロンプト・memory・仕様書がルール文を引用したもの
（「『▶実行してください』は違反」）、(b) UI モック図、(c) テスト fixture
（`const handoff = '…▶実行してください…'`）で、いずれも実際の手渡しではない。

### 1.2 監査台帳

| 台帳 | 行数 | GAS/実行語を含む行 | うち block |
|---|---|---|---|
| `~/.claude/handoff-audit-ledger.jsonl` | 429 | 10 | **0**（すべて verdict=pass・violations 0） |
| `~/.claude/stop-gate-runner-ledger.jsonl` | 611 | 3 | **0** |

### 1.3 唯一の実例とその発生源

```
~/.claude/handoff-audit-nightly-ledger.jsonl
2026-09-24T18:01:59.226Z  sessionId=6c7dca27-9942-4635-8557-cafc7ec7a1e0  provider=deepseek
  verdict=block  violations=[rule 3 …]
  learned=[{"pattern":"GAS の関数実行が要る","route":"clasp run / コマンドキュー経由で Claude 側から実行。『▶実行してください』は違反"}]
  fix(rule 3)="Bは価格エンジン(コード変更＋GAS反映)であり、clasp push/clasp run/コマンドキューで
              Claude側から実行可能。試行結果がない「〜可能性」は不可。実行して結果で書く"
```

元 handoff の逐語（`6c7dca27` の最終アシスタント発話、2026-09-24T12:44:01.831Z）:

> B. 2〜6日前だけの床を新しく作る（推奨） | 直前だけ | 価格エンジンのコードを変えて反映が要ります。
> 過去には反映の途中で自動実行の安全チェックに止められた例があり、**kim の手作業が要る可能性があります**

`▶実行してください` という逐語ではないが、**試行せずに「可能性」で人へ投げた**点が同じ穴。
nightly の学習がこれを `GAS の関数実行が要る` として拾い、既知 route を付けて
`enqueueTodos` に流した結果が本 TODO。

**TODO id の導出を再計算で確認**: `sha256(JSON.stringify([NFKC(pattern), NFKC(route)]))[0:16]`
= `2a521d8efb465e3a`（一致）。

---

## 2. route の実物検証

### 2.1 `clasp run` はこのテナントでは使えない（正本に明記済み）

`rules/gas.md:14`:

> Workspace ポリシーで `clasp run-function` と ANYONE_ANONYMOUS Web App が使えないため、
> **最初の clasp push に必ず組み込む**:

つまり route の前半「clasp run 経由で Claude 側から実行」は**この org では実行不能**。
一方 `tools/automation-routes.json:5` の `"GAS"` 配列には今も `"clasp run-function"` が残っており、
正本どうしが矛盾したまま。→ 監査 LLM が「使える道具」として再生産し続ける構造。

### 2.2 コマンドキューは nf-minpaku に入っていない

```
$ ls nf-minpaku-automation/gas/            # Setup.gs が無い（27 ファイル）
$ grep -l "installCommandQueue\|CMD_FOLDER_ID\|processCommandQueue" gas/*.gs
（一致 0 件）
```

`rules/gas.md:13` は「省略禁止・retrofit 禁止」と定めるが、このプロジェクトは
キュー導入前からある既存プロジェクトなので未導入。**「コマンドキューで実行できる」は
このプロジェクトでは偽**。

### 2.3 実際に使われている経路 = Web App ゲートウェイ（実測で通った）

`nf-minpaku-automation/gas/WebApiGateway.gs` の action ホワイトリストに実行系が揃っている:

```
case 'runDryRun':  result = remoteRunDryRun(); break;
case 'runJob':     result = remoteRunJob(); break;
case 'sendPrices': result = remoteRunJob(); break;   // alias
case 'setupAllTriggers': result = remoteSetupAllTriggers(); break;
case 'verifyAllRoomPrices': result = verifyAllRoomPrices(params.daysAhead || 30); break;
case 'generateDailyDigest': result = generateDailyDigest(); break;
```

クライアントは `nf-minpaku-automation/tools/gas-client.mjs`（`gas(action, params)`）。
認証情報の正本は `~/.claude/nf-minpaku/.gas-credentials.json`（リポジトリ外＝worktree 間で共有）。

**2026-09-25 本セッションでの実測**（読み取り専用アクション・kim の操作ゼロ）:

```
$ node -e "import('./tools/gas-client.mjs').then(m=>m.gas('getBuildInfo')).then(r=>console.log(r))"
{"ok":true,"features":{"runJobLock":true,"paceAdjust":true,"priceSendDays":180,
 "paceNoDiscountMinLeadDays":91,"selfTestPaceAdjuster":true}}
```

**HTTP 経由で GAS 関数が実行でき、ゲートウェイは生きている。**
したがって「GAS の関数実行が要る」は **Claude 側で実行可能**であり、人に渡す理由が無い。

### 2.4 例外（route 文言が書いていない仕様）

新規 GAS プロジェクトでは `setupOnce()` の ▶実行 **1 クリックだけは仕様**（`rules/gas.md:16`、
`skills/gas-project-setup/SKILL.md:8`「kim の手作業 = setupOnce の ▶実行 1クリックだけ」）。
現行 route の「『▶実行してください』は違反」はこの例外を書いていないため、
監査 LLM が**正当な 1 クリックも違反として数えうる**。

---

## 3. 併せて観測したこと（route 文字列の共有）

同じ route 文字列が別パターンにも付いている（nightly 台帳より）:

| pattern | route | 最終出現 |
|---|---|---|
| GAS の関数実行が要る | clasp run / コマンドキュー経由で… | 2026-09-24T18:01:59Z |
| セッション終了時の /clear 依頼 | **同一文字列** | 2026-09-21T18:03:19Z |

route が「道具名」から「手順文」に変わった後、LLM が既知 route をコピーする既知の型
（`docs/permanent-fix-design-only-handoff-route.md` の route 欄 `codex-do.mjs` と同型）。
route 文字列を **3 パターンで共有**しているため、単純に書き換えると
`enqueueTodos` の dedupe キー（route 単位）が動く点に注意。

---

## 4. 未確認（断定しない）

- 監査 LLM が route を選んだ根拠の一次記録は**無い**（プロンプトは保存されない）。
  「既知 route をコピーした」は台帳の一致からの推定であり、逐語の思考ログではない。
- 本記録の窓は **〜2026-09-24**。2026-09-25 以降の再発は判定不能（次セッションで追う）。
- 「▶実行」の語を含まない人手依頼（例: 「反映をお願いします」）は本走査の対象外。母数は 450 本のみ。

---

## 5. 推奨（次セッションの 1 手）

1. **route 文言の是正**（テスト付き単独 PR）:
   「**Web App ゲートウェイ（`tools/gas-client.mjs`）またはコマンドキュー経由で Claude 側から実行。
   `clasp run-function` は Workspace ポリシーで不可（rules/gas.md:14）。
   新規プロジェクトの `setupOnce` ▶実行 1クリックは仕様**」
   — route 文字列は 3 パターンで共有されているので、`enqueueTodos` の dedupe への影響をテストで固定する。
2. `tools/automation-routes.json` の `"GAS"` 配列から `clasp run-function` を外すか「不可」と注記する
   （`rules/gas.md:14` と矛盾したまま監査 LLM の材料になっている）。
