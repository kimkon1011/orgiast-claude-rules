---
name: handoff-report
description: 「完了しました」「やったよ」「手渡し」「引き継ぎ」「やっておいて」「報告」などの完了・手渡しの合図・報告を書く前に必ず使う。classifier 拒否の報告を書く直前にも使い、Stop ゲートの証拠と人の次の1操作を最初から揃える。
---

# 完了・手渡し報告を最初から揃える

## 1. 3行を最初に書く

報告を組み立てる時は、まず次の3行フッターを埋める。詳細を整えた最終応答では末尾に置く。

```text
やったこと: <依頼に対する実施結果>
検証したこと: <実行コマンド・実データの読み戻し結果>
残ったこと: <未達・未確認・次の担当>
```

実測: Stop差し戻し275件／33セッション、フッター44件、恒久策37件。出典: `~/.claude/skill-and-loop-redesign-20261028.md` §1。原則は [ONBOARDING §1.1](../../ONBOARDING.md)。

## 2. 全要素を実データで検証する

依頼範囲を漏れなく行に分け、推測・予定を成功に数えない。別 worktree なら変更ファイルの絶対パス・commit・実行ディレクトリを先に示す。

| 依頼の要素 | 実行コマンド／直接照会 | 出力・読み戻し結果 | 実行日時（TZ付き） |
|---|---|---|---|
| <要素ごとに1行> | <再現できるコマンド> | <実データ・成功／未達／未確認> | <日時> |

実行テスト・read-back 後に `[TESTED]`。軽微な確認は `[NO-TEST-OK: <実行対象の絶対パス>]` とし、理由に否定表現を入れない。詳細は [gate-remedies.md](../../tools/gate-remedies.md) の `verify-before-done-detector`。

## 3. 恒久策と人の1操作を具体化する

- `恒久策: <今回実装した自動化・ルールと保存先>`。初回だけの作業なら `恒久策: 一回限り: <理由>`。
- `次に kim がすること:` は人が一度だけ実行できる具体的手順。前の応答・項目ラベルを参照させず、必要なURL・アカウント・入力値・正確なボタン名、成功／失敗の見え方を同じ段落に揃える。操作が残らなければ「なし」。
- 手渡し前に自動経路を実行し、失敗理由・出力・代替を記録する。2操作以上は [desktop-launcher](../../playbooks/desktop-launcher.md) で1個に畳む。理解・同意は省略しない。
- `この後の自動進行:` と `このセッション:` も末尾に明記する。予定を実施済みにしない。

詳細は gate-remedies.md の `next-action-gate`、各handoff節、`manual-request-fullsteps-gate`。PRは `gh-handoff-gate`・`merge-handoff-gate`、通知は `message-locator-gate`、再発防止は `handoff-regret-gate`。

## 4. 外部状態と拒否を正確に書く

- 「入力しました」「送付済み」は対象を読み戻して `[CLAIM-EVIDENCE: <操作> => <calendar:eventId / gmail:messageId / api:request-id / url:URL / shot:path>]` を添える。値そのものは載せない。詳細: `outbound-claim-evidence-gate`。
- 否定・未達の断定は対象CLI/APIへの直接照会だけを根拠にする。未照会は「未確認」。一覧やローカル検索だけで断定しない。詳細: `external-state-claim-gate`・`negative-claim-gate`。
- classifier 拒否自体は `classifier 拒否: <カテゴリ>（<拒否された操作>）` の1行で報告し、言い換え再試行しない。根拠: ONBOARDING §1.20、gate-remedies.md の `manual-request-evidence-gate`・`handoff-investigation-gate`。
- Stop 差し戻しは不足証拠だけ補う。同じ往復が2回続いたら打ち切り、実行証拠を1回だけ提示する。ゲート改修を kim に頼まない。
