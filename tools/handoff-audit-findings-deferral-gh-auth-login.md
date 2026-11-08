# handoff-audit 検証記録: `gh auth login` 先送り文（f9375a89 / P3）の再発検証と根本原因（2026-10-17）

対象: `[handoff-audit:a2ca500e28ceee03] 恒久修正の先送り文を検出（2026-10-15T09:08:21.719Z / f9375a89 / P3）`
原文: 「次に kim がすること: 恒久策として本PCで \`gh auth login\` を1回（これで移送自体が不要になります）。移送を続ける場合は先に受信PCの C…」
検出器: `tools/permanent-fix-deferral-scan.mjs`（`handoff-audit-nightly` が毎晩実行）
検証環境: DESKTOP-63MQR3L / `C:\Users\kimko\.claude\auto-session-repo-fallback-20261017-003203`（HEAD = `origin/main` = `7fea873`）

## 結論（3点）

1. **原文の型は再発していない。** `--since 2026-10-16T00:00:00Z` で 3 台帳すべてヒット 0。
   同 window には新規 49 行があるので「0 件」は空振りではない（§1）。
2. **ただし同型は検出対象の後にも 2 件出ていた。** `gh auth login` の先送りは
   2026-10-14〜10-15 に計 4 件追加発生し、最後は `2026-10-15T17:09:28.455Z`。以後 1.5 日間ゼロ（§2）。
3. **根本原因を実測で特定した。原文は「この PC では実行不能な指示」だった。**
   `gh` バイナリが無く、`git credential fill` も `git push` もハングする（§3）。
   指示文の側を実測に合わせて直した（§4）。

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

---

## 1. 再発の有無（実物の台帳を全走査）

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-10-16T00:00:00Z
```

| 台帳 | hits / total | 内訳 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | **0** / 324 | — |
| `handoff-audit-ledger.jsonl` | **0** / 442 | — |
| `handoff-audit-nightly-ledger.jsonl` | **0** / 1 | — |

- `stop-gate-runner-ledger.jsonl` の `2026-10-16T00:00Z` 以降は **49 行**（先頭 `00:03:54.105Z` / 末尾 `15:39:32.489Z`）。
  台帳は 10-16 分もしっかり書かれており、**「0 件」は行が無いことによる空振りではない**。
- したがって原文の型（`次に kim がすること:` に恒久策の先送り）は、**直近 1.5 日間は一度も書かれていない**。

## 2. 同型の発生推移（`--since 2026-10-14T00:00:00Z` / `P3` 5 件・`P2` 1 件）

| ts (UTC) | session | excerpt（要部） |
|---|---|---|
| 2026-10-14T16:30:44.708Z | `3ba6f672` | 次に kim がすること: 本PCで `gh auth login` を1回実行する（または GitHub トークンを keyserve へ登録） |
| 2026-10-14T18:30:18.122Z | `1449168b` | このPC（cafe015-PC）で1回 `gh auth login` を実行するか、GitHub トークンを keyserve に登録してください |
| **2026-10-15T09:08:21.719Z** | **`f9375a89`** | **（本記録の検出対象）恒久策として本PCで `gh auth login` を1回** |
| 2026-10-15T16:51:10.095Z | `e738f943` | この PC で `gh auth login`（または GCM に GitHub 資格情報を登録）を1回実行する |
| 2026-10-15T17:09:28.455Z | `462a3318` | なし（次セッションが自動で着地確認）。恒久策として `gh auth login` を本PCで1回だけ実行すると移送が不要になります |
| 2026-10-15T17:34:52.780Z | `18464345` | （別件・`P2`）司法書士宛の下書きメール送信／準備書 Doc の4箇所貼り替え |

- **検出対象（09:08Z）より後にも 2 件（16:51Z / 17:09Z）出ている。** 「1 件検出＝1 件だけ」ではなく、
  **同一の詰まりが繰り返し先送りされていた**ことが分かる。
- 17:34Z の別件を除けば、最後の `gh auth login` 先送りは `2026-10-15T17:09:28Z`。

## 3. 根本原因（この PC の実測）

同じ詰まりが 5 回書かれたのは、**指示文が「この PC では実行できない経路」を唯一の手段として書いていた**ため。

| # | 実測したこと | コマンド | 結果 |
|---|---|---|---|
| R1 | `gh` が無い | `Get-Command gh` / `where gh` / 標準 4 パス（`%ProgramFiles%\GitHub CLI\gh.exe` ほか） | **`gh NOT on PATH`／4 パスすべて無し＝未インストール** |
| R2 | `git credential fill` が返らない | `printf 'protocol=https\nhost=github.com\n\n' \| timeout 20 git credential fill` | **exit 124（ハング）／stdout 0 バイト** |
| R3 | `git push` も通らない | `timeout 40 git push --dry-run origin HEAD:refs/heads/auto/probe-nonexistent` | **exit 124（ハング）** |
| R4 | 保存済み資格情報が無い | `GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never timeout 30 git push --dry-run …` | **exit 128 `could not read Username for 'https://github.com': terminal prompts disabled`** |
| R5 | 平文資格情報も無い | `ls ~/.git-credentials` | **No such file or directory** |

- `credential.helper` は `manager`（Git Credential Manager）。**github.com の資格情報が保存されておらず、
  対話 UI 待ちで無期限に止まる**（R2/R3）。GCM に対話を禁じると即座に資格情報なしで落ちる（R4）。
- したがって原文の「本PCで `gh auth login` を1回」は **そもそも `gh` が無いので実行不能**であり、
  併記されていた代替（`git credential fill` の password を `GH_TOKEN` へ）もこの PC では成立しない。
- この 2 つを唯一の手段として書いた指示文が `tools/auto-session.mjs` の `buildPrompt()` と
  `tools/gh-handoff-gate.mjs` の `formatReason()` にあり、**毎セッション同じ先送り文を再生産していた**。

## 4. 恒久修正として当ターンで入れたもの

先送りを「人に渡す文面」ではなく「指示文の欠陥」として直した。実装は `codex-do.mjs`（Codex）へ委譲し、監督は設計・レビュー・検証を担当。

| ファイル | 変更 |
|---|---|
| `tools/auto-session.mjs`（`buildPrompt()`） | PR 規約の末尾を実測準拠に置換。`command -v gh`/`where gh` で gh の有無を先に確認／`git credential fill` は**タイムアウト必須**で exit 124 は「資格情報なし」の証拠／通らなければ `gh auth login` を人に頼む文面を書かず、Codex が生きている受信先（例 w018-PC）へ fleet-mail `--exec codex` 便で移送／**「次に kim がすること」に恒久策の先送りを書かない**。automerge 部分と `gh pr merge --squash` のフォールバックは保持 |
| `tools/gh-handoff-gate.mjs`（`formatReason()`） | 同 3 点を追記。`judge()` の判定ロジックは不変（テストが固定） |
| `tools/auto-session.test.mjs` | 追加テスト（`+12`） |
| `tools/gh-handoff-gate.test.mjs` | 追加テスト（`+11`） |

検証（実測）:

- `node --test tools/auto-session.test.mjs tools/gh-handoff-gate.test.mjs` → **151/151 pass / 0 fail**
- `node --test tools/*.test.mjs` → 5068 tests / pass 5046 / **fail 12**
  - 12 件はすべて `tools/fleet-mail-v2.test.mjs`（**本変更で触っていないファイル**）。
    `origin/main`（`7fea873`）を `git worktree add --detach` で pristine 展開して同ファイルを単独実行 → **同じ 12 件が落ちる**（119 tests / pass 107 / fail 12）。
    ＝ **既存の赤であり、本変更由来ではない。**
  - フル実行時のみ落ちた `tools/distribution-coverage.test.mjs` の 1 件は、同ファイル単独実行で 7/7 pass。
    フル実行中の他テストが残す `tools/drive_mirror_test_repo_conflict` を `readdirSync` して ENOENT になる**テスト汚染**だった（本変更と無関係）。

## 5. 未確認（推測で埋めない）

| # | 未確認事項 |
|---|---|
| U1 | 本修正の main への着地。**この PC からは push できない**（§3 R2〜R4 の実測）ため、ローカルブランチ `auto/20261017-gh-auth-deferral` にコミットしたところで止まっている。着地には push 可能な PC（または `--exec codex` 便）が要る。 |
| U2 | 今晩の夜間監査が本記録の文面を新たな `P3` として拾わないか（引用ガードの効き方は実台帳でしか確認できない）。 |
| U3 | 他 PC（`gh` があり credential helper が生きている PC）で同じ置換文が不利益にならないか。置換は**追記的**で、従来の credential fill 経路も残しているため後退にはならないと判断したが、実機確認はしていない。 |

## 6. 恒久策として残る唯一の人の操作（任意・1 回だけ）

この PC に GitHub 資格情報を入れる方法は 2 つあり、どちらも**人が 1 回だけ**行う。ただし本記録の範囲では**どちらも必須ではない**
（移送は Codex が生きている宛先への fleet-mail 便で代替できる）。

| 案 | 手順 | 得られるもの | 手間 |
|---|---|---|---|
| A. GitHub CLI を入れる | `winget install --id GitHub.cli`（管理者不要のユーザー単位）→ `gh auth login` | `gh pr create` / `gh pr merge` が直接使える | インストール＋ブラウザ認可で 2 操作 |
| B. PAT を 1 本作って配る | GitHub で fine-grained PAT を発行 → keyserve へ登録（`~/.claude/*.env` の配布に乗る） | `GH_TOKEN` 経由で `gh` 無しでも `git push` / API が通る。全 PC に自動配布される | PAT 発行＋登録で 2 操作 |

**推奨は B**（`gh` のインストールが要らず、既存の keyserve 配布に乗るため他 PC にも同時に効く）。
ただし keyserve への登録路は本記録では実測していない（U1 と同じく未確認）。

---

作成: 2026-10-17 / 検証: `tools/permanent-fix-deferral-scan.mjs`・`node --test`・`git worktree` による pristine 比較

---

## 追検証（2026-10-17 / DESKTOP-63MQR3L・`1449168b` を対象に）

対象 `[handoff-audit:a1737a575ff7e67f]`（`2026-10-14T18:30:18.122Z / 1449168b / P3`）は
本記録 §2 の表の2行目＝**同一型**（「このPC（cafe015-PC）で1回 `gh auth login` を実行するか、
GitHub トークンを keyserve に」）。検出器・台帳を実物で再走査した。

### 再発なし（空振りでないことの確認つき）

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-10-15T18:00:00Z
```

| 台帳 | hits / total | 窓内の行数 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | **0** / 326 | 67（`18:00:13Z`〜`10-16T15:53Z`） |
| `handoff-audit-ledger.jsonl` | **0** / 491 | 97（`18:00:12Z`〜`10-16T15:53Z`） |
| `handoff-audit-nightly-ledger.jsonl` | **0** / 1 | — |

窓内に計 164 行があるので「0 件」は行が無いことによる空振りではない。
同条件で歴史窓 `--since 2026-10-14T00:00:00Z --until 2026-10-15T18:00:00Z` を回すと **6 件**
（P3:5 / P2:1）を再検出し、対象 `2026-10-14T18:30:18.122Z 1449168b` も含まれる
＝**検出器は生きており、直近の 0 件は本物**。最後の `gh auth login` 先送りは `2026-10-15T17:09:28Z`。

### このPCも同じ詰まり（実測・修正文書の前提を裏づけ）

| 実測 | コマンド | 結果 |
|---|---|---|
| `gh` が無い | `command -v gh` / `where gh` | 該当なし（未インストール） |
| 資格情報が無い | `GCM_INTERACTIVE=never GIT_TERMINAL_PROMPT=0 git credential fill` | **exit 128**「could not read Username」 |
| ハングする | `timeout 15 git credential fill` | **exit 124** |
| 保管なし | `cmdkey /list`（github） | エントリなし |
| SSH 不可 | `ssh -T git@github.com` | Permission denied (publickey)／`~/.ssh` に鍵なし |
| push 不可 | `GIT_TERMINAL_PROMPT=0 git push -u origin <branch>` | **exit 124（ハング）** |
| 取得は可 | `git fetch origin main` | 成功（公開リポジトリ） |

→ `gh auth login` を kim に頼む文面は、この PC でも **実行不能な唯一の経路**を指していた（原文の型の再発条件そのもの）。

### 書込み時の恒久策を追加（この型を配信前に止める）

夜間検出は**翌晩**なので、先送りは kim へ配信済みでしか気づけない。同じ定義を
配信前の Stop ゲートに移した:

- `tools/next-action-gate.mjs` に `NEXT-ACTION-DEFERRAL` を追加（`93202e7`）。
  規則A＝`次に kim がすること` に 恒久策/恒久化/恒久的/次セッション/次回セッション/後日/先送り。
  規則B＝同値に 実装/修正/改修/修復/作り直 かつ本文に着地語（着地/マージ/PR/push/ブランチ/main に）。
- 検証: `tools/next-action-gate.test.mjs` 41 pass（新規6件）。実文 `1449168b`・`462a3318` で block を実測、
  正当な人専用タスク（印刷所へ電話）と物理操作（修正版PDFを印刷して同封）は pass のまま。
  `tools/*.test.mjs` の fail 12 は既知の既存赤 `tools/fleet-mail-v2.test.mjs`（`origin/main` と同数）。

### 残り（この PC から着地できない）

`auto/20261017-gh-auth-deferral`（`origin/main` = `7354040` に rebase 済み・2コミット）は
**未push**。この PC には push 経路が無い（上表）。fleet-mail の `--exec codex` 便も
`looksLikeInstallRequest` ガード（exit 5「全PCの設定変更は setup --converge 経由」）と
本文 20,000 文字上限（patch が 28KB）で今回は積めなかった。
→ 資格情報のある PC（例: w018-PC／kim-PC）での `git am` + push + PR が必要（残TODOに記録）。

## 追検証（e738f943 / handoff-audit:753a8077c03f51bc・2026-10-18）

- 走査: `node tools/permanent-fix-deferral-scan.mjs --since 2026-10-15T16:51:11Z`
  → stop-gate-runner-ledger 365行中 hits=2（P2:1 = 2026-10-15T17:09:28Z 462a3318 / P3:1 = 2026-10-15T17:34:52Z 18464345）。
  いずれも修正着地（PR #829 = commit 6bf3194、2026-10-16T18:52Z マージ）より前の別セッションで、e738f943 原文の再出現ではない。
  2026-10-16 / 10-17 / 10-18 は 0 件。handoff-audit-ledger 719行 0件、handoff-audit-nightly-ledger 2行 0件。＝再発なし。
- 検出器の生存: `--since 2026-10-14T00:00:00Z --until 2026-10-15T18:00:00Z` → 6件（P3:5 / P2:1）を再検出し、e738f943 の行も含まれる。0件は空振りではない。
- 書込み時ゲート: e738f943 の原文フッター（3行・`SESSION_PHRASES.pending`）を `judgeNextAction` に渡すと `block` / `NEXT-ACTION-DEFERRAL`。実測（2026-10-18）。
- 既知の穴: フッターを書かない200字未満の短い応答は `short-response` で素通りする（既存 §5 U2 のまま。本修正の対象外）。
- 着地状況: 修正は origin/main に着地済み（`git merge-base --is-ancestor 6bf3194 origin/main` = exit 0）。origin/main の `tools/auto-session.mjs` は「`gh auth login` を kim に頼まず … `--exec codex` 便で移送」の修正版で、ライブの `C:\Users\kimko\.claude\nightly-repo\tools\auto-session.mjs` とも一致。
- 1クリック経路: `C:\Users\kimko\.claude\tools\gh-login-oneclick.ps1` は UTF-8 BOM 付き（先頭 ef bb bf）で、デスクトップ `GitHub認証（1回だけ）（ダブルクリック）.cmd` から呼ばれる。`~/.claude/github-landing-queue.txt` に未着地枝を登録済み。＝「このPCの修正が main に着地しない」は、1回の認証同意以外を自動化済み。
