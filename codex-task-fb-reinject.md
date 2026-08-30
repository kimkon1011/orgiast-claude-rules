# タスク: 取り込み済み項目が引き継ぎファイルから消えたら再注入する

## 対象
`C:\Users\uers\Downloads\orgiast-claude-rules`（WSL: `/mnt/c/Users/uers/Downloads/orgiast-claude-rules`）
`tools/booth-feedback-intake.mjs` と `tools/booth-feedback-intake.test.mjs` のみを変更する。他のファイルは触らない。
git 操作（commit/push/branch）は一切しない。

## 直す問題（2026-08-28 実害）
このツールは未対応の要望を `~/.claude/next-session.md` の「## 残TODO」へ追記し、
台帳 `~/.claude/booth-feedback-ledger.json` の `injectedAt` で二重登録を防いでいる。

ところが `next-session.md` は**並行して動いている別のセッションが丸ごと書き直す**ファイルで、
実際に注入済みの2件が跡形もなく消えた。台帳には `injectedAt` が残っているため、
**現在の実装ではその2件は二度と積まれない**（要望はシート上で未対応のまま、誰も気付かない）。

## 期待する挙動
「台帳に `injectedAt` がある」だけでスキップしてはいけない。次の条件で判定する:

- **本文に `[FB:<key>]` が在る** → スキップ（今まで通り。これが第一の冪等キー）
- **本文に無い & その項目がまだ未対応(open)** → **再注入する**（消えたのは別セッションの上書きであって、
  対応が終わったからではない。対応済みならそもそも API が open として返さない）
- 再注入したら台帳の `injectedAt` を更新し、`reinjectedCount` を +1 して記録する（何度消えたかが後で分かるように）

要するに **本文の存在が正で、台帳は履歴**という関係にする。

## 追加で満たすこと
- サマリ出力に再注入の件数を出す。例:
  `booth-feedback: open=2 new=0 reinjected=2 injected=2 (skipped: already-injected 0)`
  `--json` の出力にも `reinjected` を足す。
- `--dry-run` でも再注入対象を数える（書き込みはしない）。

## テスト（`tools/booth-feedback-intake.test.mjs` に追加）
1. **台帳に `injectedAt` があるのに本文から消えている open 項目は、再注入される**
   （これが今回の実害の回帰テスト。修正前のコードでは落ちることを確認してからコミットすること）
2. 再注入後、台帳の `reinjectedCount` が 1 になる
3. 本文に `[FB:<key>]` が在る場合は、台帳の有無にかかわらず**増えない**（既存の冪等テストを壊さない）
4. 既存テストを1件も壊さない

`node --test tools/booth-feedback-intake.test.mjs` が green になること。
`node --test tools/auto-session.test.mjs` も green のままであること。
