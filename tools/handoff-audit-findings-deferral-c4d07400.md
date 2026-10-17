# handoff-audit 検証記録: `13d27af8161afa52`（`c4d07400` / W）の再発検証 — 2026-10-18

対象 TODO: `[handoff-audit:13d27af8161afa52] 恒久修正の先送り文を検出（2026-10-15T16:00:57.187Z / c4d07400 / W）`
（`~/.claude/next-session.md`）。

原文（`~/.claude/handoff-audit-deferral-ledger.jsonl` の hit 行、2026-10-15T16:00:57.187Z）:

| 項目 | 値 |
|---|---|
| sessionId | `c4d07400-8fe1-4f28-9b95-21d7335d42b7` |
| pattern | `W` |
| source | `stop-gate-runner-ledger.jsonl` |
| match | ``off-audit:3677714a0b69aad0（W / TJP-09「Codex の完了を待っています」）を実物検証し…` と**引用内**`` |

送信なし・権限変更なし・kim への DM なし。既存の承認範囲のみで実施。

## 結論（3点）

1. **原文の型は再現しない。** 現在の `origin/main`（`97d28cd`）の検出器に、原文を出した
   停止ゲート台帳の excerpt（200 字）と、台帳に保存された match 文字列を**そのまま**通した結果、
   どちらも `detect() = []`（§1）。監査 ID の引用（角括弧なし `off-audit:`）を引用として除外する
   ガードが効いている。
2. **恒久修正は着地済みで、夜間監査が実際に読むコードにも入っている。** PR #812 は
   **2026-10-16T18:51:15Z に MERGED**（`auto/20261016-deferral-audit-ref-guard`）。
   nightly が優先して読むクローン `~/.claude/nightly-repo` も HEAD `97d28cd` で同一コードを持ち、
   回帰テスト 24/24 pass（§2）。
3. **台帳の全走査では、原文時刻以降に W が 1 件だけ出たが、それは引用ではなく実在の進捗文で、
   同一セッション内に作業が着地していた。** `2026-10-17T01:56:20.286Z` / `b8a542d6` の
   「Codex 2本…の完了を待っています」で、約3分後の `01:59:00` に
   「ゲート実装の Codex が終わりました」と実測結果（51件 PASS 等）が記録されている（§3）。
   13d27 の型（監査 ID の引用内ヒット）の再発ではない。

## 1. 原文の再現（一次証拠）

`node -e` で `tools/permanent-fix-deferral-scan.mjs` の `detect()` を直接呼び、原文に当てた。

| 入力 | 実測 |
|---|---|
| `stop-gate-runner-ledger.jsonl` の `c4d07400` 行の excerpt（200 字、全文一致） | `[]` |
| 台帳に保存された match 文字列（上表） | `[]` |
| 対照: 監査参照のない素の待機文（既存テスト） | `W` を検出 |

 excerpt の要部は
`**やったこと**: 実物検証＝偽陽性と確定（当該 excerpt は \`handoff-audit:3677714a0b69aad0（W / TJP-09「Codex の完了を待っています」）を実物検証し…\` と**引用内**`
であり、「Codex の完了を待っています」は**引用符の内側**にある。修正前は `AUDIT_MARKER` が
角括弧つき `[handoff-audit:<id>]` しか知らず、この角括弧なし形を監査参照と認識できなかった。

## 2. 恒久修正の着地と、夜間監査が読むコード

| 確認項目 | 実測値 |
|---|---|
| PR #812 | `state=MERGED` / `mergedAt=2026-10-16T18:51:15Z` |
| 変更内容（`origin/main`） | `AUDIT_MARKER` に `\[?off-audit:[0-9a-f]{16}\]?` を追加、近傍ウィンドウ 40→80 字 |
| nightly クローン | `git -C ~/.claude/nightly-repo log -1` = `97d28cd`（= `origin/main`）。`AUDIT_MARKER` の該当行あり |
| 検出器の選択 | `deferralDetectorFile()` は local と clone が同一なら local を使う。台帳の最終 window 行も `detector=local / detectorDiffers=false` と整合 |
| 回帰テスト | `node --test tools/permanent-fix-deferral-scan.test.mjs` → **24 pass / 0 fail** |

該当する回帰テストは2本:
`検証報告が監査IDを参照して引用した待機文は再検出しない`（3677714a0b69aad0 の実 excerpt を逐語で固定）と
`角括弧なしの off-audit 参照でも引用を監査引用とみなす`。

## 3. 台帳の再走査（原文時刻以降）

`node tools/permanent-fix-deferral-scan.mjs --since 2026-10-15T16:00:57.187Z` の実測:

| 台帳 | hits / total | 内訳 |
|---|---|---|
| `stop-gate-runner-ledger.jsonl` | 1 / 853 | `2026-10-17T01:56:20.286Z`（`b8a542d6` / W）のみ |
| `handoff-audit-ledger.jsonl` | 0 / 899 | — |
| `handoff-audit-nightly-ledger.jsonl` | 0 / 42 | — |

ヒット 1 件の全文（要部）:

```
Codex 2本（全PC共通ゲートの実装、アプリの Gemini 切替と比較スクリプト）の完了を待っています。
- 次に kim がすること: なし（Codex の実装完了と比較結果を待つだけ）
- この後の自動進行: Codex 2本の結果をレビューしてテストを通し、ゲートは PR で提出します。…
```

これは**監査 ID の引用ではなく、実際に Codex の完了を待っている進捗文**で、`W` の仕様どおりの検出である。
ただし同一セッションの `2026-10-17T01:59:00.749Z` の行で

```
ゲート実装の Codex が終わりました。Codex の報告では、新規ゲートは30ケースで、
登録テストと合わせて51件 PASS、既存の契約・配線テストは58件 PASS、`git diff --check` も問題なしです。
```

と完了が記録され、作業は放置されていない。`e100b8d9` の検証記録（`handoff-audit-findings-deferral-e100b8d9.md` §7）と
同じ「委譲の完了待ちを記録した1時点」の型で、13d27 の citation false positive とは別物。

時刻の区切り: 原文（10-15T16:00:57Z）とこの 1 件（10-17T01:56:20Z）の間にヒットは無く、
10-17T01:56 以降もヒットは無い（台帳の最終行は 10-17T12:05:11Z）。

## 4. 夜間実行そのものの確認状況

`handoff-audit-deferral-ledger.jsonl` の最終 window 行は **2026-10-16T18:01:16Z**
（`hits=1` = 本 TODO を起案した回）。これは修正マージ（18:51:15Z）の**50分前**で、
修正後の夜間実行はまだ観測していない（次回は 2026-10-18 03:01 JST）。

本セッションが 5 分超のポーリングを行わない規約のため window 行の追記待ちはしない。
代わりに、nightly が読むのと同一のクローン検出器（`97d28cd`）を直接実行して
原文 0 件・台帳走査の内訳を確認済み（§1・§3）。次回の夜間実行は同じコードを通る。

## 5. 次に kim がすること

**なし。** 恒久修正はマージ済みで、残っている作業は無い。
